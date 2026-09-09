import type { Message } from "../memory.js";
import type {
  ToolApprovalRequest,
  ToolApprovalResponse,
} from "../permissions/types.js";
import type {
  AgentContext,
  AgentSessionHistory,
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
    options?: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    >,
  ): Promise<Message[]>;
  getRunId(
    sessionId: string,
    options?: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    >,
  ): Promise<string | null>;
  getPendingApprovals(
    sessionId: string,
    options?: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    >,
  ): Promise<ToolApprovalRequest[]>;
  getSessionHistory(
    sessionId: string,
    options?: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    >,
  ): Promise<AgentSessionHistory>;
  deleteSession(
    sessionId: string,
    options?: Pick<RunAgentOptions, "sessionNamespace">,
  ): Promise<void>;
}
