import {
  AgentEventType,
  cloneJsonValue,
  sumUsage,
  type AgentEvent,
  type AgentEventInput,
  type AgentInterrupt,
} from "@agentdock-ai/contracts";
import {
  Command,
  isCommand,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { closeIterator } from "../utils/close-iterator.js";
import { createAbortScope } from "../signals/abort-scope.js";
import { EventContext } from "../events/event-context.js";
import { WireEventMapper } from "../events/from-langgraph.js";
import { mapSnapshotInterrupts } from "../langgraph/resume-state.js";
import {
  parseStreamChunk,
  type StreamChunk,
} from "../langgraph/parse-stream-chunk.js";
import { ToolObserver } from "../langgraph/tool-observer.js";
import {
  observeStream,
  type ObservedChunk,
} from "../langgraph/observed-stream.js";
import { mergeConfigs } from "@langchain/core/runnables";
import {
  readControlSnapshot,
  readFailureSnapshot,
  reconcileInterrupts,
  type NativeControlGraph,
} from "../langgraph/control-projection.js";
import { isRecord } from "../utils/is-record.js";
import type { ThreadSnapshot } from "../langgraph/thread-read.js";
import type { InterruptFormat } from "../agentdock.js";
import type { Run, ServableCompiledGraph } from "./types.js";

export type RunFailureStage = "graph" | "mapper" | "checkpoint";
export interface RunStreamOptions {
  recursionLimit?: number;
  interruptFormat?: InterruptFormat;
  validateResume?: (
    value: unknown,
    pending: readonly AgentInterrupt[],
    context: Record<string, unknown> | undefined,
  ) => void | Promise<void>;
  onError?: (
    error: unknown,
    details: { threadId: string; runId: string; stage: RunFailureStage },
  ) => void;
}
interface RuntimeGraph extends NativeControlGraph {
  stream(
    input: unknown,
    options: LangGraphRunnableConfig & {
      streamMode: readonly ["messages", "updates", "tasks"];
    },
  ): Promise<AsyncIterable<unknown>>;
}

/** Serves one native invocation without mutating graph checkpoints. */
export class RunStream {
  private readonly graph: RuntimeGraph;
  constructor(
    graph: ServableCompiledGraph,
    private readonly options: RunStreamOptions,
  ) {
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
    this.assertRun(run);
    const config: LangGraphRunnableConfig = {
      ...run.config,
      configurable: { ...run.config?.configurable, thread_id: run.threadId },
    };
    let input: unknown;
    if ("resume" in run) input = new Command({ resume: run.resume });
    else if ("continue" in run) input = null;
    else input = run.input;
    const resume = isCommand(input) ? input.resume : undefined;
    const continuation = input === null || isCommand(input);
    let before: ThreadSnapshot | undefined;
    if (continuation || this.graph.checkpointer)
      before = await readControlSnapshot(this.graph, config);
    const pending = before
      ? mapSnapshotInterrupts(before, this.options.interruptFormat)
      : [];
    if ("resume" in run && !pending.length && !before?.next?.length)
      throw new Error(
        "Cannot resume this thread: no native pending interrupt or breakpoint.",
      );
    if (resume !== undefined)
      await this.options.validateResume?.(resume, pending, run.context);
    if ("continue" in run && pending.length)
      throw new Error("Dynamic interrupts require a resume value.");
    const context = new EventContext(crypto.randomUUID(), 0);
    const mapper = new WireEventMapper(
      context,
      [],
      this.options.interruptFormat,
    );
    mapper.seedHistory(before?.values);
    if (!continuation) mapper.seedHistory(input);
    const mappers = new Map<string, WireEventMapper>([["[]", mapper]]);
    const abortScope = createAbortScope(run.signal);
    const interrupts = new Map<string, unknown>();
    let breakpoint = false;
    let finished = false;
    let iterator: AsyncIterator<unknown> | undefined;
    let observed: AsyncIterator<ObservedChunk> | undefined;
    let stage: RunFailureStage = "graph";
    const observer = new ToolObserver();
    let checkpointConfig = config;
    const raised = new Set<string>();
    const project = (chunk: StreamChunk) => {
      let namespace = chunk.namespace ?? [];
      if (
        chunk.mode === "messages" &&
        Array.isArray(chunk.value) &&
        isRecord(chunk.value[1]) &&
        typeof chunk.value[1].langgraph_checkpoint_ns === "string"
      )
        namespace = chunk.value[1].langgraph_checkpoint_ns
          .split("|")
          .filter(Boolean);
      if (chunk.mode === "messages" || chunk.mode === "tools")
        namespace = namespace.slice(0, -1);
      const key = JSON.stringify(namespace);
      let current = mappers.get(key);
      if (!current) {
        current = new WireEventMapper(
          context,
          namespace,
          this.options.interruptFormat,
        );
        mappers.set(key, current);
      }
      return current.map(chunk.mode, chunk.value, chunk.namespace ?? []);
    };
    try {
      yield context.emit({ type: AgentEventType.RunStarted });
      if (abortScope.signal.aborted) throw abortScope.signal.reason;
      const options: LangGraphRunnableConfig = mergeConfigs(config, {
        callbacks: [observer],
      });
      options.context = run.context;
      options.signal = abortScope.signal;
      if (this.options.recursionLimit !== undefined)
        options.recursionLimit = this.options.recursionLimit;
      const source = await this.graph.stream(input, {
        ...options,
        streamMode: ["messages", "updates", "tasks"],
      });
      iterator = source[Symbol.asyncIterator]();
      observed = observeStream(iterator, observer, abortScope.signal);
      while (true) {
        stage = "graph";
        const next = await observed.next();
        stage = "mapper";
        if (next.done) break;
        const chunk =
          next.value.source === "callback"
            ? next.value.chunk
            : parseStreamChunk(next.value.value);
        if (chunk.mode === "tasks") {
          if (isRecord(chunk.value) && "result" in chunk.value) {
            if (
              chunk.value.interrupts !== undefined &&
              !Array.isArray(chunk.value.interrupts)
            )
              throw new Error("LangGraph emitted invalid task interrupts.");
            for (const interrupt of chunk.value.interrupts ?? []) {
              if (
                !isRecord(interrupt) ||
                typeof interrupt.id !== "string" ||
                !interrupt.id
              )
                throw new Error("LangGraph emitted an invalid task interrupt.");
              raised.add(interrupt.id);
            }
          }
          continue;
        }
        {
          if (chunk.mode === "updates") context.advancePhase();
          if (
            chunk.mode === "updates" &&
            isRecord(chunk.value) &&
            Array.isArray(chunk.value.__interrupt__)
          ) {
            if (!chunk.value.__interrupt__.length) breakpoint = true;
            for (const interrupt of chunk.value.__interrupt__) {
              if (!isRecord(interrupt) || typeof interrupt.id !== "string")
                throw new Error("LangGraph emitted an invalid interrupt.");
              interrupts.set(interrupt.id, interrupt);
            }
            continue;
          }
          for (const event of project(chunk)) yield event;
        }
      }
      if (abortScope.signal.aborted) throw abortScope.signal.reason;
      stage = "checkpoint";
      if (observer.interruption) {
        checkpointConfig = {
          ...config,
          configurable: {
            ...config.configurable,
            checkpoint_id: observer.interruption.checkpointId,
          },
        };
        breakpoint = observer.interruption.interrupts.length === 0;
      }
      let snapshot: ThreadSnapshot | undefined;
      if (breakpoint || interrupts.size || observer.interruption)
        snapshot = await readControlSnapshot(this.graph, checkpointConfig);
      stage = "mapper";
      for (const currentMapper of mappers.values())
        for (const event of currentMapper.completeMessages()) yield event;
      if (snapshot?.tasks) {
        const current = mapSnapshotInterrupts(
          snapshot,
          this.options.interruptFormat,
        );
        for (const event of reconcileInterrupts(
          context,
          pending,
          current,
          resume,
          raised,
          snapshot.next,
        ))
          yield event;
        interrupts.clear();
        for (const interrupt of current)
          interrupts.set(interrupt.interruptId, interrupt);
        breakpoint = breakpoint && Boolean(snapshot.next?.length);
      } else {
        if (!interrupts.size)
          for (const event of reconcileInterrupts(
            context,
            pending,
            [],
            resume,
            raised,
            snapshot?.next,
          ))
            yield event;
        for (const event of mapper.map("updates", {
          __interrupt__: [...interrupts.values()],
        }))
          yield event;
      }
      if (interrupts.size || breakpoint) {
        finished = true;
        return;
      }
      finished = true;
      const usages: NonNullable<WireEventMapper["usage"]>[] = [];
      for (const currentMapper of mappers.values()) {
        const usage = currentMapper.usage;
        if (usage) usages.push(usage);
      }
      const completed: Extract<AgentEventInput, { type: "run.completed" }> = {
        type: AgentEventType.RunCompleted,
        finishReason: "stop",
        content: [...mappers.values()].flatMap((current) => current.content),
      };
      if (usages.length) completed.usage = sumUsage(usages);
      yield context.emit(completed);
    } catch (error) {
      const cancelled = abortScope.signal.aborted;
      if (stage !== "graph") abortScope.abort(error);
      try {
        this.options.onError?.(error, {
          threadId: run.threadId,
          runId: context.runId,
          stage,
        });
      } catch {
        /* Logging must not replace the original failure. */
      }
      let recoverable = pending.length > 0;
      try {
        const snapshot = await readFailureSnapshot(
          this.graph,
          checkpointConfig,
          observer.rootTasks,
        );
        if (snapshot) {
          const current = mapSnapshotInterrupts(
            snapshot,
            this.options.interruptFormat,
          );
          for (const event of reconcileInterrupts(
            context,
            pending,
            current,
            resume,
            raised,
            snapshot.next,
          ))
            yield event;
          recoverable = Boolean(snapshot.next?.length || current.length);
        } else recoverable = false;
      } catch {
        // Retain the original error and last known control state when a read fails.
      }
      finished = true;
      yield context.emit(
        cancelled
          ? {
              type: AgentEventType.RunCancelled,
              reason: "Run cancelled.",
              recoverable,
            }
          : {
              type: AgentEventType.RunFailed,
              code: stage === "graph" ? "graph_error" : `${stage}_error`,
              message: "Agent execution failed.",
              recoverable,
            },
      );
    } finally {
      if (!finished) abortScope.abort(new Error("Stream consumer stopped."));
      await closeIterator(observed);
      await closeIterator(iterator);
      abortScope.dispose();
    }
  }
  private assertRun(run: Run<unknown, Record<string, unknown>>): void {
    if (!run || typeof run !== "object")
      throw new Error("Run must be an object.");
    if (typeof run.threadId !== "string" || !run.threadId.trim())
      throw new Error("Run threadId must be a non-empty string.");
    if (
      ["input", "resume", "continue"].filter((key) => key in run).length !== 1
    )
      throw new Error(
        "Run must contain exactly one of input, resume, or continue.",
      );
    if ("continue" in run && run.continue !== true)
      throw new Error("Run continue must be true.");
    if ("resume" in run) cloneJsonValue(run.resume, "Run resume");
    if (run.context !== undefined && !isRecord(run.context))
      throw new Error("Run context must be an object.");
    if (run.config !== undefined) {
      if (!isRecord(run.config))
        throw new Error("Run config must be an object.");
      if (
        run.config.configurable !== undefined &&
        !isRecord(run.config.configurable)
      )
        throw new Error("Run config.configurable must be an object.");
      for (const key of [
        "encoding",
        "streamMode",
        "signal",
        "context",
        "recursionLimit",
      ])
        if (key in run.config)
          throw new Error(`Agentdock owns stream option ${key}.`);
    }
    if (run.signal !== undefined && !(run.signal instanceof AbortSignal))
      throw new Error("Run signal must be an AbortSignal.");
  }
}
