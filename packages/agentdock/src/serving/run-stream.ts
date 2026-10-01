import {
  AgentEventType,
  cloneJsonValue,
  sumUsage,
  type AgentEvent,
  type AgentEventInput,
  type AgentInterrupt,
} from "@agentdock-ai/contracts";
import { Command, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { createAbortScope } from "../signals/compose-abort-signals.js";
import { EventContext } from "../events/event-context.js";
import { WireEventMapper } from "../events/from-langgraph.js";
import {
  mapSnapshotInterrupts,
  nativeInterrupts,
} from "../langgraph/resume-state.js";
import { validateResume } from "../langgraph/validate-resume.js";
import { parseStreamChunk } from "../langgraph/parse-stream-chunk.js";
import { isRecord } from "../utils/is-record.js";
import type { ThreadSnapshot } from "../langgraph/thread-read.js";
import type { Run, ServableCompiledGraph } from "./types.js";

export type RunFailureStage = "graph" | "mapper" | "checkpoint";
export interface RunStreamOptions {
  recursionLimit: number;
  onError?: (
    error: unknown,
    details: { threadId: string; runId: string; stage: RunFailureStage },
  ) => void;
}
interface RuntimeGraph {
  stream(
    input: unknown,
    options: LangGraphRunnableConfig & {
      streamMode: readonly ["messages", "tools", "updates"];
    },
  ): Promise<AsyncIterable<unknown>>;
  getState(
    config: LangGraphRunnableConfig,
    options?: { subgraphs?: boolean },
  ): Promise<ThreadSnapshot>;
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
    let pending: AgentInterrupt[] = [];
    if (!("input" in run)) {
      const snapshot = await this.graph.getState(config, { subgraphs: true });
      pending = mapSnapshotInterrupts(snapshot);
      if (!snapshot.next?.length && !pending.length)
        throw new Error(
          "Cannot resume this thread: no native pending interrupt or breakpoint.",
        );
      if ("resume" in run) validateResume(run.resume, pending);
      if ("continue" in run && pending.length)
        throw new Error("Dynamic interrupts require a resume value.");
    }
    const context = new EventContext(crypto.randomUUID(), 0);
    const mapper = new WireEventMapper(context);
    const mappers = new Map<string, WireEventMapper>([["[]", mapper]]);
    const abortScope = createAbortScope(run.signal);
    const interrupts = new Map<string, unknown>();
    let breakpoint = false;
    let finished = false;
    let iterator: AsyncIterator<unknown> | undefined;
    let stage: RunFailureStage = "graph";
    try {
      yield context.emit({ type: AgentEventType.RunStarted });
      if (abortScope.signal.aborted) throw abortScope.signal.reason;
      let input: unknown;
      if ("resume" in run) input = new Command({ resume: run.resume });
      else if ("continue" in run) input = null;
      else input = run.input;
      const source = await this.graph.stream(input, {
        ...config,
        context: run.context,
        signal: abortScope.signal,
        streamMode: ["messages", "tools", "updates"],
        recursionLimit: this.options.recursionLimit,
      });
      iterator = source[Symbol.asyncIterator]();
      while (true) {
        stage = "graph";
        const next = await iterator.next();
        if (next.done) break;
        stage = "mapper";
        const chunk = parseStreamChunk(next.value);
        if (chunk.mode === "updates") context.advancePhase();
        if (
          chunk.mode === "updates" &&
          isRecord(chunk.value) &&
          Array.isArray(chunk.value.__interrupt__)
        ) {
          if (chunk.value.__interrupt__.length === 0) breakpoint = true;
          for (const interrupt of chunk.value.__interrupt__) {
            if (!isRecord(interrupt) || typeof interrupt.id !== "string")
              throw new Error("LangGraph emitted an invalid interrupt.");
            interrupts.set(interrupt.id, interrupt);
          }
          continue;
        }
        const namespace = chunk.namespace ?? [];
        const key = JSON.stringify(namespace);
        let currentMapper = mappers.get(key);
        if (!currentMapper) {
          currentMapper = new WireEventMapper(context, namespace);
          mappers.set(key, currentMapper);
        }
        for (const event of currentMapper.map(chunk.mode, chunk.value))
          yield event;
      }
      if (abortScope.signal.aborted) throw abortScope.signal.reason;
      stage = "checkpoint";
      let snapshot: ThreadSnapshot | undefined;
      if (pending.length || breakpoint || interrupts.size) {
        snapshot = await this.graph.getState(config, { subgraphs: true });
        mapper.seedMessages(snapshot.values);
        if (snapshot.tasks) {
          interrupts.clear();
          for (const interrupt of nativeInterrupts(snapshot)) {
            if (isRecord(interrupt) && typeof interrupt.id === "string")
              interrupts.set(interrupt.id, interrupt);
          }
        }
      }
      stage = "mapper";
      for (const currentMapper of mappers.values()) {
        for (const event of currentMapper.completeMessages()) yield event;
      }
      // A successfully exhausted invocation confirms which previous interrupts resolved.
      for (const interrupt of pending) {
        if (interrupts.has(interrupt.interruptId)) continue;
        const value = "resume" in run ? run.resume : null;
        yield context.emit({
          type: AgentEventType.InterruptResolved,
          interruptId: interrupt.interruptId,
          decisions: this.resumeDecisions(
            value,
            interrupt.interruptId,
            pending.length,
          ),
        });
      }
      const newInterrupts = [...interrupts.entries()]
        .filter(([id]) => !pending.some((item) => item.interruptId === id))
        .map(([, value]) => value);
      if (snapshot?.tasks) {
        for (const interrupt of mapSnapshotInterrupts(snapshot)) {
          if (
            !pending.some((item) => item.interruptId === interrupt.interruptId)
          )
            yield context.emit({
              type: AgentEventType.InterruptRequired,
              interrupt,
            });
        }
      } else {
        for (const event of mapper.map("updates", {
          __interrupt__: newInterrupts,
        }))
          yield event;
      }
      if (interrupts.size || breakpoint) {
        if (breakpoint || newInterrupts.length === 0)
          yield context.emit({
            type: AgentEventType.RunPaused,
            next: [...(snapshot?.next ?? [])],
          });
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
        content: [],
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
      let recoverable = false;
      if (!("input" in run)) {
        try {
          const snapshot = await this.graph.getState(config, {
            subgraphs: true,
          });
          recoverable = Boolean(
            snapshot.next?.length || nativeInterrupts(snapshot).length,
          );
        } catch {
          // Preserve the failure when its recovery checkpoint cannot be read.
          recoverable = pending.length > 0;
        }
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
      if (iterator?.return) await iterator.return().catch(() => undefined);
      abortScope.dispose();
    }
  }
  private resumeDecisions(value: unknown, id: string, count: number) {
    if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, id))
      return [cloneJsonValue(value[id])];
    if (count > 1) return [];
    if (isRecord(value) && Array.isArray(value.decisions))
      return value.decisions.map((item) => cloneJsonValue(item));
    return [cloneJsonValue(value)];
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
    if (run.config && "encoding" in run.config)
      throw new Error("Agentdock owns stream encoding.");
    if (run.signal !== undefined && !(run.signal instanceof AbortSignal))
      throw new Error("Run signal must be an AbortSignal.");
  }
}
