import {
  AgentEventType,
  cloneJsonValue,
  type AgentEvent,
  type AgentInterrupt,
  type JsonValue,
} from "@agentdock-ai/contracts";
import { Command, type LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  createAbortScope,
  type AbortScope,
} from "../signals/compose-abort-signals.js";
import { EventContext } from "../events/event-context.js";
import { WireEventMapper } from "../events/from-langgraph.js";
import {
  AGENT_EVENT_STATE_KEY,
  parseAgentEventState,
  type AgentEventState,
} from "../langgraph/event-state.js";
import { parseStreamChunk } from "../langgraph/parse-stream-chunk.js";
import { isRecord } from "../utils/is-record.js";
import type { Run, ServableCompiledGraph } from "./types.js";

export interface RunStreamOptions {
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

type PendingEventState = AgentEventState & {
  runId: string;
  pendingInterrupt: AgentInterrupt;
};

interface RunSession {
  config: RuntimeGraphConfig;
  savedState: PendingEventState | null;
  runId: string;
  eventContext: EventContext;
  mapper: WireEventMapper;
  abortScope: AbortScope;
}

/** Owns one compiled graph's run orchestration; all request state stays local. */
export class RunStream {
  private readonly graph: RuntimeGraph;

  constructor(
    graph: ServableCompiledGraph,
    private readonly options: RunStreamOptions,
  ) {
    // CompiledGraph loses useful input typing at LangGraph's broad stream boundary.
    this.graph = graph as unknown as RuntimeGraph;
  }

  stream<TInput, TContext extends Record<string, unknown>>(
    run: Run<TInput, TContext>,
  ): AsyncGenerator<AgentEvent> {
    return this.execute(run);
  }

  private async *execute<TInput, TContext extends Record<string, unknown>>(
    run: Run<TInput, TContext>,
  ): AsyncGenerator<AgentEvent> {
    const session = await this.prepareRun(run);
    let terminalEventEmitted = false;
    let pausedForInterrupt = false;
    let graphIterator: AsyncIterator<unknown> | undefined;

    try {
      for (const event of this.initialEvents(run, session)) yield event;

      const graphInput = this.graphInput(run, session);
      const graphStream = await this.graph.stream(graphInput, {
        ...run.config,
        configurable: session.config.configurable,
        context: run.context,
        signal: session.abortScope.signal,
        streamMode: ["messages", "tools", "updates"],
        recursionLimit: this.options.recursionLimit,
      });
      graphIterator = graphStream[Symbol.asyncIterator]();

      while (true) {
        const next = await graphIterator.next();
        if (next.done) break;

        const chunk = parseStreamChunk(next.value);
        if (chunk.mode === "updates") session.eventContext.advancePhase();

        for (const event of session.mapper.map(chunk.mode, chunk.value)) {
          if (event.type === AgentEventType.InterruptRequired) {
            pausedForInterrupt = true;
            await this.persistEventState(session, {
              runId: session.runId,
              logicalSequence: event.logicalSequence,
              pendingInterrupt: event.interrupt,
            });
          }
          yield event;
        }
      }

      if (session.abortScope.signal.aborted) {
        const cancelled = session.eventContext.emit({
          type: AgentEventType.RunCancelled,
          reason: "Run cancelled.",
        });
        await this.persistTerminalState(session, cancelled.logicalSequence);
        terminalEventEmitted = true;
        yield cancelled;
        return;
      }

      if (pausedForInterrupt) {
        terminalEventEmitted = true;
        return;
      }

      for (const event of session.mapper.completeMessages()) yield event;

      const completed = session.eventContext.emit({
        type: AgentEventType.RunCompleted,
        finishReason: "stop",
        content: [],
      });
      if (session.savedState) {
        await this.persistEventState(session, {
          runId: session.runId,
          logicalSequence: completed.logicalSequence,
        });
      }
      terminalEventEmitted = true;
      yield completed;
    } catch {
      const terminal = this.failureEvent(session);
      await this.persistTerminalState(session, terminal.logicalSequence);
      terminalEventEmitted = true;
      yield terminal;
    } finally {
      if (!terminalEventEmitted) {
        session.abortScope.abort(new Error("Stream consumer stopped."));
      }
      session.abortScope.dispose();
      if (graphIterator?.return) {
        await graphIterator.return().catch(() => undefined);
      }
    }
  }

  private async prepareRun<TInput, TContext extends Record<string, unknown>>(
    run: Run<TInput, TContext>,
  ): Promise<RunSession> {
    this.assertRun(run);
    const config = this.graphConfig(run);
    const savedState = await this.loadResumeState(run, config);
    const runId = savedState?.runId ?? crypto.randomUUID();
    const eventContext = new EventContext(
      runId,
      savedState?.logicalSequence ?? 0,
    );
    const abortScope = createAbortScope(run.signal);

    return {
      config,
      savedState,
      runId,
      eventContext,
      mapper: new WireEventMapper(eventContext),
      abortScope,
    };
  }

  private graphConfig<TInput, TContext extends Record<string, unknown>>(
    run: Run<TInput, TContext>,
  ): RuntimeGraphConfig {
    return {
      configurable: {
        ...run.config?.configurable,
        thread_id: run.threadId,
      },
    };
  }

  private async loadResumeState<
    TInput,
    TContext extends Record<string, unknown>,
  >(
    run: Run<TInput, TContext>,
    config: RuntimeGraphConfig,
  ): Promise<PendingEventState | null> {
    if (!("resume" in run)) return null;

    const snapshot = await this.graph.getState(config);
    const result = parseAgentEventState(snapshot.values);
    if (
      result.status !== "valid" ||
      !result.state.runId ||
      !result.state.pendingInterrupt
    ) {
      throw new Error(
        "Cannot resume this thread: the graph must use withAgentEventState and have a valid pending interrupt.",
      );
    }
    return {
      ...result.state,
      runId: result.state.runId,
      pendingInterrupt: result.state.pendingInterrupt,
    };
  }

  private initialEvents<TInput, TContext extends Record<string, unknown>>(
    run: Run<TInput, TContext>,
    session: RunSession,
  ): AgentEvent[] {
    const events = [
      session.eventContext.emit({ type: AgentEventType.RunStarted }),
    ];
    if ("resume" in run && session.savedState) {
      events.push(
        session.eventContext.emit({
          type: AgentEventType.InterruptResolved,
          interruptId: session.savedState.pendingInterrupt.interruptId,
          decisions: this.resumeDecisions(run.resume),
        }),
      );
    }
    return events;
  }

  private graphInput<TInput, TContext extends Record<string, unknown>>(
    run: Run<TInput, TContext>,
    session: RunSession,
  ): unknown {
    if ("resume" in run) return new Command({ resume: run.resume });
    return this.withEventState(run.input, {
      runId: session.runId,
      logicalSequence: session.eventContext.lastLogicalSequence,
    });
  }

  private withEventState(
    input: unknown,
    state: AgentEventState,
  ): Record<string, unknown> {
    if (!isRecord(input)) {
      throw new Error(
        "This graph needs an object input and withAgentEventState to emit resumable AgentEvents.",
      );
    }
    return { ...input, [AGENT_EVENT_STATE_KEY]: state };
  }

  private async persistEventState(
    session: RunSession,
    state: AgentEventState,
  ): Promise<void> {
    await this.graph.updateState(session.config, {
      [AGENT_EVENT_STATE_KEY]: state,
    });
    const snapshot = await this.graph.getState(session.config);
    const result = parseAgentEventState(snapshot.values);
    const restored = result.status === "valid" ? result.state : null;
    if (
      result.status !== "valid" ||
      !restored ||
      restored.runId !== state.runId ||
      restored.logicalSequence !== state.logicalSequence ||
      stableJson(restored.pendingInterrupt) !==
        stableJson(state.pendingInterrupt)
    ) {
      throw new Error("The graph did not persist Agentdock event state.");
    }
  }

  private async persistTerminalState(
    session: RunSession,
    logicalSequence: number,
  ): Promise<void> {
    try {
      await this.persistEventState(session, {
        runId: session.runId,
        logicalSequence,
      });
    } catch {
      // Preserve the terminal event without exposing checkpoint details.
    }
  }

  private failureEvent(session: RunSession): AgentEvent {
    if (session.abortScope.signal.aborted) {
      return session.eventContext.emit({
        type: AgentEventType.RunCancelled,
        reason: "Run cancelled.",
      });
    }
    return session.eventContext.emit({
      type: AgentEventType.RunFailed,
      code: "graph_error",
      message: "Agent execution failed.",
    });
  }

  private resumeDecisions(value: unknown): JsonValue[] {
    if (isRecord(value) && Array.isArray(value.decisions)) {
      return value.decisions.map((decision) => cloneJsonValue(decision));
    }
    return [cloneJsonValue(value)];
  }

  private assertRun(run: Run<unknown, Record<string, unknown>>): void {
    if (!run || typeof run !== "object") {
      throw new Error("Run must be an object.");
    }
    if (typeof run.threadId !== "string" || run.threadId.trim().length === 0) {
      throw new Error("Run threadId must be a non-empty string.");
    }
    const isResume = "resume" in run;
    if (isResume === "input" in run) {
      throw new Error("Run must contain exactly one of input or resume.");
    }
    if (run.signal !== undefined && !this.isAbortSignal(run.signal)) {
      throw new Error("Run signal must be an AbortSignal.");
    }
  }

  private isAbortSignal(value: unknown): value is AbortSignal {
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
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
