import type { LanguageModel } from "ai";
import type { CompressionStrategy } from "../compression/strategy.js";
import type { AgentHooks } from "./hooks.js";
import type { Message } from "./memory.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface AgentContext {
  userId: string;
  organizationId: string;
  permissions: string[];
  role: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(input: ToolExecuteInput): Promise<unknown>;
}

export interface ToolExecuteInput {
  input: Record<string, unknown>;
  ctx: AgentContext;
  signal?: AbortSignal;
}

export interface ToolCallRecord {
  toolCallId: string;
  name: string;
  input: unknown;
}

export interface ToolErrorRecord extends ToolCallRecord {
  error: string;
}

export interface ToolResultRecord {
  toolCallId: string;
  name: string;
  input: unknown;
  output: unknown;
  isError?: boolean;
}

export interface AgentRunResult {
  content: string;
  messages: Message[];
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  toolErrors: ToolErrorRecord[];
}

export interface StreamAgentResult {
  textStream: AsyncIterable<string>;
  fullStream: AsyncIterable<unknown>;
  result: Promise<AgentRunResult>;
}

export interface RunAgentOptions {
  maxSteps?: number;
  systemPrompt?: string;
  model?: LanguageModel;
  modelId?: string;
  apiKey?: string;
  registry?: ToolRegistry;
  abortSignal?: AbortSignal;
  toolTimeout?: number;
  messages?: Message[];
  hooks?: AgentHooks;
  compression?: CompressionStrategy;
}
