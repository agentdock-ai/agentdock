import {
  AgentEventType,
  cloneJsonValue,
  type AgentEvent,
  type JsonValue,
} from "@agentdock-ai/contracts";
import { Command, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { composeAbortSignals } from "./abort-signal.js";
import { EventContext } from "./event-context.js";
import {
  AGENT_EVENT_STATE_KEY,
  readAgentEventState,
  type AgentEventState,
} from "./event-state.js";
import { parseStreamChunk } from "./stream-chunk.js";
import type { Run, ServableCompiledGraph } from "./types.js";
import { WireEventMapper } from "./to-wire-event.js";

export interface StreamOptions {
  recursionLimit: number;
}

interface RuntimeGraph {
  stream(
    input: unknown,
    options: Omit<
      LangGraphRunnableConfig,
      "configurable" | "context" | "signal"
    > & {
      configurable: NonNullable<LangGraphRunnableConfig["configurable"]> & {
        thread_id: string;
      };
      context?: Record<string, unknown>;
      signal: AbortSignal;
      streamMode: readonly ["messages", "tools", "updates"];
      recursionLimit: number;
    },
  ): Promise<AsyncIterable<unknown>>;
  getState(config: RuntimeGraphConfig): Promise<{ values: unknown }>;
  updateState(
    config: RuntimeGraphConfig,
    update: Record<string, unknown>,
  ): Promise<unknown>;
}

interface RuntimeGraphConfig {
  configurable: NonNullable<LangGraphRunnableConfig["configurable"]> & {
    thread_id: string;
  };
}

/** Drives one compiled graph invocation and projects its stream to AgentEvents. */
export async function* streamGraph<
  TInput,
  TContext extends Record<string, unknown>,
>(
  graph: ServableCompiledGraph,
  run: Run<TInput, TContext>,
  options: StreamOptions,
): AsyncGenerator<AgentEvent> {
  assertRun(run);
  // CompiledGraph methods lose useful input typing at LangGraph's broad stream boundary.
  const graphRuntime = graph as unknown as RuntimeGraph;
  const configurable = {
    ...run.config?.configurable,
    thread_id: run.threadId,
  };
  const config = { configurable };
  const resumed = "resume" in run;
  let savedState: AgentEventState | null = null;

  if (resumed) {
    const snapshot = await graphRuntime.getState(config);
    savedState = readAgentEventState(snapshot.values);
    if (!savedState?.runId || !savedState.pendingInterruptId) {
      throw new Error(
        "Cannot resume this thread: the graph must include agentEventStateSchema and have a pending interrupt.",
      );
    }
  }

  const runId = savedState?.runId ?? crypto.randomUUID();
  const eventContext = new EventContext(
    runId,
    run.threadId,
    savedState?.logicalSequence ?? 0,
  );
  const mapper = new WireEventMapper(eventContext);
  const consumerController = new AbortController();
  const composed = composeAbortSignals(run.signal, consumerController.signal);
  let terminalEventEmitted = false;
  let pausedForInterrupt = false;
  let graphIterator: AsyncIterator<unknown> | undefined;

  try {
    yield eventContext.emit({ type: AgentEventType.RunStarted });
    if (resumed && savedState) {
      yield eventContext.emit({
        type: AgentEventType.InterruptResolved,
        interruptId: savedState.pendingInterruptId!,
        decisions: resumeDecisions(run.resume),
      });
    }

    const graphInput = resumed
      ? new Command({ resume: run.resume })
      : withEventState(run.input, {
          runId,
          logicalSequence: eventContext.lastLogicalSequence,
        });
    const stream = await graphRuntime.stream(graphInput, {
      ...run.config,
      configurable,
      context: run.context,
      signal: composed.signal,
      streamMode: ["messages", "tools", "updates"],
      recursionLimit: options.recursionLimit,
    });
    graphIterator = stream[Symbol.asyncIterator]();

    while (true) {
      const next = await graphIterator.next();
      if (next.done) break;
      const parsed = parseStreamChunk(next.value);
      if (parsed.mode === "updates") eventContext.advancePhase();

      for (const event of mapper.map(parsed.mode, parsed.value)) {
        if (event.type === AgentEventType.InterruptRequired) {
          pausedForInterrupt = true;
          await persistEventState(graphRuntime, config, {
            runId,
            logicalSequence: event.logicalSequence,
            pendingInterruptId: event.interrupt.interruptId,
          });
        }
        yield event;
      }
    }

    if (composed.signal.aborted) {
      const cancelled = eventContext.emit({
        type: AgentEventType.RunCancelled,
        reason: "Run cancelled.",
      });
      try {
        await persistEventState(graphRuntime, config, {
          runId,
          logicalSequence: cancelled.logicalSequence,
        });
      } catch {
        // Preserve the terminal transport event; checkpoint failure is not exposed.
      }
      terminalEventEmitted = true;
      yield cancelled;
      return;
    }

    if (pausedForInterrupt) {
      terminalEventEmitted = true;
      return;
    }

    for (const event of mapper.completeMessages()) yield event;
    const completed = eventContext.emit({
      type: AgentEventType.RunCompleted,
      finishReason: "stop",
      content: [],
    });
    if (resumed) {
      await persistEventState(graphRuntime, config, {
        runId,
        logicalSequence: completed.logicalSequence,
      });
    }
    terminalEventEmitted = true;
    yield completed;
  } catch {
    const cancelled = composed.signal.aborted;
    const terminal = cancelled
      ? eventContext.emit({
          type: AgentEventType.RunCancelled,
          reason: "Run cancelled.",
        })
      : eventContext.emit({
          type: AgentEventType.RunFailed,
          code: "graph_error",
          message: "Agent execution failed.",
        });
    try {
      await persistEventState(graphRuntime, config, {
        runId,
        logicalSequence: terminal.logicalSequence,
      });
    } catch {
      // Preserve the terminal transport event; checkpoint failure is not exposed.
    }
    terminalEventEmitted = true;
    yield terminal;
  } finally {
    if (!terminalEventEmitted) {
      consumerController.abort(new Error("Stream consumer stopped."));
    }
    composed.dispose();
    if (graphIterator?.return) {
      await graphIterator.return().catch(() => undefined);
    }
  }
}

function assertRun(run: Run<unknown, Record<string, unknown>>): void {
  if (!run || typeof run !== "object")
    throw new Error("Run must be an object.");
  if (typeof run.threadId !== "string" || run.threadId.trim().length === 0) {
    throw new Error("Run threadId must be a non-empty string.");
  }
  const isResume = "resume" in run;
  if (isResume === "input" in run) {
    throw new Error("Run must contain exactly one of input or resume.");
  }
  if (run.signal !== undefined && !isAbortSignal(run.signal)) {
    throw new Error("Run signal must be an AbortSignal.");
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof value.aborted === "boolean" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function" &&
    "removeEventListener" in value &&
    typeof value.removeEventListener === "function"
  );
}

function withEventState(
  input: unknown,
  state: AgentEventState,
): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error(
      "This graph needs an object input and agentEventStateSchema to emit resumable AgentEvents.",
    );
  }
  return { ...input, [AGENT_EVENT_STATE_KEY]: state };
}

async function persistEventState(
  graph: RuntimeGraph,
  config: { configurable: { thread_id: string } },
  state: AgentEventState,
): Promise<void> {
  const persistedState = {
    ...state,
    pendingInterruptId: state.pendingInterruptId,
  };
  await graph.updateState(config, { [AGENT_EVENT_STATE_KEY]: persistedState });
  const snapshot = await graph.getState(config);
  const restored = readAgentEventState(snapshot.values);
  if (
    !restored ||
    restored.runId !== state.runId ||
    restored.logicalSequence !== state.logicalSequence ||
    restored.pendingInterruptId !== state.pendingInterruptId
  ) {
    throw new Error("The graph did not persist AgentDock event state.");
  }
}

function resumeDecisions(value: unknown): JsonValue[] {
  if (isRecord(value) && Array.isArray(value.decisions)) {
    return value.decisions.map((decision) => cloneJsonValue(decision));
  }
  return [cloneJsonValue(value)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
