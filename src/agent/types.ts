import type { LanguageModel } from "ai";
import type { CompressionStrategy } from "../compression/strategy.js";
import type { AgentHooks } from "./hooks.js";
import type { Message } from "./memory.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentEvent } from "./events.js";
import type {
  ToolApprovalRequest,
  ToolPermissionMode,
} from "./permissions/types.js";
import type { AgentRunStatus } from "./runs/store.js";

export interface AgentContext {
  [key: string]: unknown;
}

export interface ToolAuthorizationInput {
  toolCall: ToolCallRecord;
  ctx: AgentContext;
}

export type ToolAuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requiresApproval?: boolean;
  authorize?(
    input: ToolAuthorizationInput,
  ): ToolAuthorizationResult | Promise<ToolAuthorizationResult>;
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
  runId: string;
  status: AgentRunStatus;
  content: string;
  messages: Message[];
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  toolErrors: ToolErrorRecord[];
  approvalRequests: ToolApprovalRequest[];
  stepsCompleted: number;
}

export interface StreamAgentResult {
  stream: AsyncIterable<AgentEvent>;
  result: Promise<AgentRunResult>;
}

export interface RunAgentOptions {
  runId?: string;
  permissionMode?: ToolPermissionMode;
  maxSteps?: number;
  systemPrompt?: string;
  model?: LanguageModel;
  registry?: ToolRegistry;
  abortSignal?: AbortSignal;
  toolTimeout?: number;
  messages?: Message[];
  hooks?: AgentHooks;
  compression?: CompressionStrategy;
}
