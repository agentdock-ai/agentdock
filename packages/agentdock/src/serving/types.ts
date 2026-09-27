import type { AgentEvent } from "@agentdock-ai/contracts";
import type { CompiledGraph } from "@langchain/langgraph";

export type StartRun<TInput, TContext extends Record<string, unknown>> = {
  input: TInput;
  threadId: string;
  context?: TContext;
  signal?: AbortSignal;
};

export type ResumeRun<TContext extends Record<string, unknown>> = {
  threadId: string;
  resume: unknown;
  context?: TContext;
  signal?: AbortSignal;
};

export type Run<TInput, TContext extends Record<string, unknown>> =
  | StartRun<TInput, TContext>
  | ResumeRun<TContext>;

export interface AgentRuntime<TInput, TContext extends Record<string, unknown>> {
  stream(run: Run<TInput, TContext>): AsyncIterable<AgentEvent>;
  pipe(response: NodeSseResponse, run: Run<TInput, TContext>): Promise<void>;
  toResponse(run: Run<TInput, TContext>): Promise<Response>;
}

/** Minimal Node HTTP / Express-compatible response surface used by `pipe`. */
export interface NodeSseResponse {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  writeHead(statusCode: number, headers: Record<string, string>): this;
  write(frame: string): boolean;
  end(): void;
  on(event: "close" | "drain", listener: () => void): this;
  off(event: "close" | "drain", listener: () => void): this;
}

export type GraphInput<Graph> = Graph extends CompiledGraph<
  string,
  infer _State,
  infer _Update,
  infer _Context,
  infer Input,
  infer _Output
>
  ? Input
  : never;

export type GraphContext<Graph> = Graph extends CompiledGraph<
  string,
  infer _State,
  infer _Update,
  infer Context,
  infer _Input,
  infer _Output
>
  ? Context
  : never;

export type ServableCompiledGraph = CompiledGraph<string>;
