import { RunStream } from "./serving/run-stream.js";
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
  NodeSseResponse,
  Run,
  ServableCompiledGraph,
} from "./serving/types.js";

export interface AgentdockOptions {
  /** LangGraph safety limit; defaults to 25 graph steps. */
  recursionLimit?: number;
}

const DEFAULT_RECURSION_LIMIT = 25;

/** Owns graph serving and checkpoint reads without binding to an HTTP server. */
export class Agentdock<
  Graph extends ServableCompiledGraph,
> implements AgentRuntime<GraphInput<Graph>, GraphContext<Graph>> {
  private readonly runStream: RunStream;
  private readonly graph: Graph;

  constructor(graph: Graph, options: AgentdockOptions = {}) {
    const recursionLimit = options.recursionLimit ?? DEFAULT_RECURSION_LIMIT;
    if (!Number.isSafeInteger(recursionLimit) || recursionLimit <= 0) {
      throw new Error("recursionLimit must be a positive safe integer.");
    }
    this.graph = graph;
    this.runStream = new RunStream(graph, { recursionLimit });
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
    options: { channel?: string } = {},
  ): Promise<unknown[] | null> {
    return getThreadMessages(this.graph, threadId, options);
  }

  async getResumeState(threadId: string): Promise<AgentReducerState | null> {
    const snapshot = await getThreadSnapshot(this.graph, threadId);
    if (!snapshot) return null;
    const result = createResumeState(snapshot.values, threadId);
    return result.status === "ready" ? result.state : null;
  }
}
