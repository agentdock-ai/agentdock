import { RunStream, type RunStreamOptions } from "./serving/run-stream.js";
import { pipeEvents } from "./transports/node/pipe.js";
import { createSseResponse } from "./transports/web/to-response.js";
import { createResumeState } from "./langgraph/resume-state.js";
import type { AgentReducerState } from "@agentdock-ai/contracts";
import {
  getThreadMessages,
  getThreadSnapshot,
} from "./langgraph/thread-read.js";
import type {
  AgentRuntime,
  GraphContext,
  GraphInput,
  GraphRunConfig,
  NodeSseResponse,
  Run,
  ServableCompiledGraph,
} from "./serving/types.js";

export type InterruptFormat = typeof Agentdock.OPAQUE | typeof Agentdock.HITL;

export interface AgentdockOptions {
  /** Optional override; otherwise LangGraph resolves its configured limit. */
  recursionLimit?: number;
  /** Explicit display format for native LangChain HITL middleware. Defaults to opaque. */
  interruptFormat?: InterruptFormat;
  /** Application-owned preflight validation, before execution or SSE headers. */
  validateResume?: RunStreamOptions["validateResume"];
  /** Server-side diagnostics; errors sent to clients remain sanitized. */
  onError?: RunStreamOptions["onError"];
}

/** Owns graph serving and checkpoint reads without binding to an HTTP server. */
export class Agentdock<
  Graph extends ServableCompiledGraph,
> implements AgentRuntime<GraphInput<Graph>, GraphContext<Graph>> {
  static readonly OPAQUE = "opaque";
  static readonly HITL = "langchain-hitl";

  private readonly runStream: RunStream;
  private readonly graph: Graph;
  private readonly interruptFormat: InterruptFormat;

  constructor(graph: Graph, options: AgentdockOptions = {}) {
    const recursionLimit = options.recursionLimit;
    if (
      recursionLimit !== undefined &&
      (!Number.isSafeInteger(recursionLimit) || recursionLimit <= 0)
    ) {
      throw new Error("recursionLimit must be a positive safe integer.");
    }
    if (
      options.interruptFormat !== undefined &&
      options.interruptFormat !== Agentdock.OPAQUE &&
      options.interruptFormat !== Agentdock.HITL
    )
      throw new Error("interruptFormat must be opaque or langchain-hitl.");
    this.graph = graph;
    this.interruptFormat = options.interruptFormat ?? Agentdock.OPAQUE;
    this.runStream = new RunStream(graph, {
      recursionLimit,
      interruptFormat: this.interruptFormat,
      validateResume: options.validateResume,
      onError: options.onError,
    });
  }

  stream(
    run: Run<GraphInput<Graph>, GraphContext<Graph>>,
  ): AsyncIterable<import("@agentdock-ai/contracts").AgentEvent> {
    return this.runStream.stream(run);
  }

  pipe(
    response: NodeSseResponse,
    run: Run<GraphInput<Graph>, GraphContext<Graph>>,
  ): Promise<void> {
    return pipeEvents(response, run, (currentRun) => this.stream(currentRun));
  }

  toResponse(
    run: Run<GraphInput<Graph>, GraphContext<Graph>>,
  ): Promise<Response> {
    return createSseResponse(run, (currentRun) => this.stream(currentRun));
  }

  getMessages(
    threadId: string,
    options: { channel?: string; config?: GraphRunConfig } = {},
  ): Promise<unknown[] | null> {
    return getThreadMessages(this.graph, threadId, options);
  }

  async getResumeState(
    threadId: string,
    config: GraphRunConfig = {},
  ): Promise<AgentReducerState | null> {
    const snapshot = await getThreadSnapshot(this.graph, threadId, config);
    if (!snapshot) return null;
    const result = createResumeState(snapshot, threadId, this.interruptFormat);
    if (result.status === "invalid_checkpoint")
      throw new Error(
        "Native checkpoint could not be projected into resume state.",
      );
    return result.status === "ready" ? result.state : null;
  }
}
