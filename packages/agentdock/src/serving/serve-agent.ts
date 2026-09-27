import type { AgentEvent } from "@agentdock-ai/contracts";
import { streamGraph } from "./stream.js";
import { pipeEvents } from "./pipe.js";
import { createSseResponse } from "./to-response.js";
import type {
  AgentRuntime,
  GraphContext,
  GraphInput,
  Run,
  ServableCompiledGraph,
} from "./types.js";

export interface ServeAgentOptions {
  /** LangGraph safety limit; defaults to 25 graph steps. */
  recursionLimit?: number;
}

const DEFAULT_RECURSION_LIMIT = 25;

/** Adapts one compiled LangGraph graph to a transport-neutral SSE runtime. */
export function serveAgent<Graph extends ServableCompiledGraph>(
  graph: Graph,
  options: ServeAgentOptions = {},
): AgentRuntime<GraphInput<Graph>, GraphContext<Graph>> {
  const recursionLimit = options.recursionLimit ?? DEFAULT_RECURSION_LIMIT;
  if (!Number.isSafeInteger(recursionLimit) || recursionLimit <= 0) {
    throw new Error("recursionLimit must be a positive safe integer.");
  }

  const stream = (
    run: Run<GraphInput<Graph>, GraphContext<Graph>>,
  ): AsyncIterable<AgentEvent> =>
    streamGraph(
      graph,
      run as Run<unknown, Record<string, unknown>>,
      { recursionLimit },
    );

  return {
    stream,
    pipe: (response, run) => pipeEvents(response, run, stream),
    toResponse: (run) => createSseResponse(run, stream),
  };
}
