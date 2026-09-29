import type { AgentEvent } from "@agentdock-ai/contracts";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

/** LangGraph run options; serving-owned context, signal, mode, and recursion are excluded. */
export type GraphRunConfig = Omit<
  LangGraphRunnableConfig,
  "context" | "signal" | "streamMode" | "recursionLimit"
>;

export type StartRun<TInput, TContext extends Record<string, unknown>> = {
  /** Input accepted by the compiled graph. */
  input: TInput;
  resume?: never;
  /** Stable, application-authorized LangGraph thread identity. */
  threadId: string;
  /** Per-invocation graph context; never persisted by Agentdock. */
  context?: TContext;
  /** LangGraph callbacks, tags, metadata, store, and additional configurable values. */
  config?: GraphRunConfig;
  /** Aborts cooperative graph and tool work when signaled. */
  signal?: AbortSignal;
};

export type ResumeRun<TContext extends Record<string, unknown>> = {
  input?: never;
  /** The same application-authorized thread ID used for the interrupted run. */
  threadId: string;
  /** Opaque value forwarded unchanged to LangGraph's `Command({ resume })`. */
  resume: unknown;
  context?: TContext;
  /** LangGraph callbacks, tags, metadata, store, and additional configurable values. */
  config?: GraphRunConfig;
  signal?: AbortSignal;
};

export type Run<TInput, TContext extends Record<string, unknown>> =
  StartRun<TInput, TContext> | ResumeRun<TContext>;

export interface AgentRuntime<
  TInput,
  TContext extends Record<string, unknown>,
> {
  /** Transport-free event stream. Early iterator return aborts cooperative work. */
  stream(run: Run<TInput, TContext>): AsyncIterable<AgentEvent>;
  /** Writes SSE to a Node-compatible response and owns its response listeners. */
  pipe(response: NodeSseResponse, run: Run<TInput, TContext>): Promise<void>;
  /** Adapts the event stream to a Web `Response`; body cancellation aborts work. */
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

type GraphStreamArguments<Graph> = Graph extends {
  stream: (...args: infer Arguments) => unknown;
}
  ? Arguments
  : never;

export type GraphInput<Graph> =
  GraphStreamArguments<Graph> extends [infer Input, ...unknown[]]
    ? Input
    : never;

export type GraphContext<Graph> =
  GraphStreamArguments<Graph> extends [unknown, (infer Options)?]
    ? NonNullable<Options> extends { context?: infer Context }
      ? Context extends Record<string, unknown>
        ? Context
        : Record<string, unknown>
      : Record<string, unknown>
    : Record<string, unknown>;

export interface ServableCompiledGraph {
  stream(input: never, options?: never): unknown;
  getState(config: LangGraphRunnableConfig): Promise<{ values: unknown }>;
  updateState(
    config: LangGraphRunnableConfig,
    update: Record<string, unknown>,
  ): unknown;
}
