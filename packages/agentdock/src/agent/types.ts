import type {
  AgentContext,
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
  JsonObject,
  ToolCallRecord,
} from "@agentdock/contracts";

export type {
  AgentContext,
  AgentRunResult,
  AgentRunStatus,
  AgentSessionRecord,
  AgentSessionHistory,
  Message,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCallRecord,
  ToolErrorRecord,
  ToolResultRecord,
} from "@agentdock/contracts";

export interface ToolAuthorizationInput {
  toolCall: ToolCallRecord;
  ctx: AgentContext;
}

export type ToolAuthorizationResult =
  { allowed: true } | { allowed: false; reason: string };

export interface Tool {
  name: string;
  description: string;
  parameters: JsonObject;
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

export interface StreamAgentResult {
  stream: AsyncIterable<AgentEvent>;
  result: Promise<AgentRunResult>;
}

export interface RunAgentOptions extends Pick<
  AgentRunRequest,
  | "runId"
  | "maxSteps"
  | "systemPrompt"
  | "toolTimeout"
  | "authorizationTimeout"
  | "sessionNamespace"
> {
  sessionId?: string;
  abortSignal?: AbortSignal;
}
