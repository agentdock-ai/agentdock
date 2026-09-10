import type { JsonObject } from "./json.js";
import type { Message } from "./messages.js";
import type { ToolApprovalRequest } from "./approvals.js";
import type { AgentLimitInfo, AgentUsage, ContentPart } from "./events.js";
import type {
  ToolCallRecord,
  ToolErrorRecord,
  ToolResultRecord,
} from "./tools.js";

export type AgentContext = JsonObject;

export interface AgentRunRequest {
  sessionId: string;
  prompt: string;
  context: AgentContext;
  runId?: string;
  sessionNamespace?: string;
  maxSteps?: number;
  systemPrompt?: string;
  toolTimeout?: number;
  authorizationTimeout?: number;
}

export interface AgentResumeRequest {
  sessionId: string;
  runId: string;
  context: AgentContext;
  approvals: import("./approvals.js").ToolApprovalDecision[];
}

export type AgentRunStatus =
  "waiting_for_approval" | "completed" | "failed" | "cancelled";

export interface AgentRunResult {
  runId: string;
  sessionId: string;
  status: AgentRunStatus;
  content: ContentPart[];
  messages: Message[];
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  toolErrors: ToolErrorRecord[];
  approvalRequests: ToolApprovalRequest[];
  stepsCompleted: number;
  error?: string;
  errorCode?: string;
  cancellationReason?: string;
  finishReason?: string;
  usage?: AgentUsage;
  limit?: AgentLimitInfo;
}
