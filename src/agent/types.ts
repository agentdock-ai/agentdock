import type { JSONSchema } from "@langchain/core/utils/json_schema";
import type { Message } from "./memory.js";
import type { AgentEvent } from "./events.js";
import type { ToolApprovalRequest } from "./permissions/types.js";

export type AgentContext = Record<string, unknown>;

export interface ToolAuthorizationInput {
  toolCall: ToolCallRecord;
  ctx: AgentContext;
}

export type ToolAuthorizationResult =
  { allowed: true } | { allowed: false; reason: string };

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
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
  input: Record<string, unknown>;
}

export interface ToolErrorRecord extends ToolCallRecord {
  error: string;
}

export interface ToolResultRecord extends ToolCallRecord {
  output: unknown;
  isError?: boolean;
}

export type AgentRunStatus =
  "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled";

export interface AgentRunResult {
  runId: string;
  sessionId: string;
  status: AgentRunStatus;
  content: string;
  messages: Message[];
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  toolErrors: ToolErrorRecord[];
  approvalRequests: ToolApprovalRequest[];
  stepsCompleted: number;
  error?: string;
}

export interface StreamAgentResult {
  stream: AsyncIterable<AgentEvent>;
  result: Promise<AgentRunResult>;
}

export interface RunAgentOptions {
  runId?: string;
  sessionId?: string;
  maxSteps?: number;
  systemPrompt?: string;
  abortSignal?: AbortSignal;
  toolTimeout?: number;
}

export interface AgentSessionRecord {
  sessionId: string;
  messages: Message[];
}
