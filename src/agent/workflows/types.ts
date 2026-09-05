import type { Message } from "../memory.js";
import type {
  ToolApprovalRequest,
  ToolApprovalResponse,
} from "../permissions/types.js";
import type {
  AgentContext,
  RunAgentOptions,
  StreamAgentResult,
} from "../types.js";

export interface WorkflowInput {
  runId: string;
  sessionId: string;
  ctx: AgentContext;
  options: RunAgentOptions;
  signal: AbortSignal;
}

export interface WorkflowStartInput extends WorkflowInput {
  userPrompt: string;
}

export interface WorkflowResumeInput extends WorkflowInput {
  approvals: ToolApprovalResponse[];
}

export interface AgentWorkflow {
  start(input: WorkflowStartInput): StreamAgentResult;
  resume(input: WorkflowResumeInput): StreamAgentResult;
  getMessages(
    sessionId: string,
    options?: Pick<RunAgentOptions, "systemPrompt" | "maxSteps">,
  ): Promise<Message[]>;
  getRunId(
    sessionId: string,
    options?: Pick<RunAgentOptions, "systemPrompt" | "maxSteps">,
  ): Promise<string | null>;
  getPendingApprovals(
    sessionId: string,
    options?: Pick<RunAgentOptions, "systemPrompt" | "maxSteps">,
  ): Promise<ToolApprovalRequest[]>;
}
