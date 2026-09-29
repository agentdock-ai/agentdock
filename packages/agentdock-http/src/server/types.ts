import type {
  Agentdock,
  GraphContext,
  GraphRunConfig,
  ServableCompiledGraph,
} from "@agentdock-ai/agentdock";

export interface Authorization<Context extends Record<string, unknown>> {
  context: Context;
  config?: GraphRunConfig;
}

export interface AgentdockServerOptions<Graph extends ServableCompiledGraph> {
  agent: Agentdock<Graph>;
  basePath?: string;
  authorize: (
    request: Request,
    threadId: string,
  ) => Promise<Authorization<GraphContext<Graph>> | null>;
  threads?: {
    listThreads: (options: { request: Request }) => unknown | Promise<unknown>;
  };
}

export type Route =
  | { kind: "list-threads" }
  | { kind: "run" | "resume" | "messages" | "resume-state"; threadId: string };
