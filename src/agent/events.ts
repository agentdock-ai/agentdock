import type {
  ToolCallRecord,
  ToolErrorRecord,
  ToolResultRecord,
} from "./types.js";
import type {
  ToolApprovalRequest,
  ToolApprovalResponse,
} from "./permissions/types.js";

export interface AgentEventBase {
  version: 1;
  eventId: string;
  runId: string;
  /** Monotonic ordering within one emitted stream. */
  sequence: number;
  timestamp: string;
}

export interface AgentError {
  code: string;
  message: string;
}

export const AgentEventType = {
  RunStarted: "run.started",
  StreamStarted: "stream.started",
  TextDelta: "text.delta",
  ToolCalled: "tool.called",
  ToolResult: "tool.result",
  ToolError: "tool.error",
  ApprovalRequired: "approval.required",
  ApprovalResolved: "approval.resolved",
  RunCompleted: "run.completed",
  RunWaitingForApproval: "run.waiting_for_approval",
  RunFailed: "run.failed",
  RunCancelled: "run.cancelled",
} as const;

export type AgentEventType =
  (typeof AgentEventType)[keyof typeof AgentEventType];

export type AgentEventPayload =
  | { type: typeof AgentEventType.RunStarted; sessionId: string }
  | { type: typeof AgentEventType.StreamStarted }
  | { type: typeof AgentEventType.TextDelta; id: string; text: string }
  | { type: typeof AgentEventType.ToolCalled; toolCall: ToolCallRecord }
  | { type: typeof AgentEventType.ToolResult; result: ToolResultRecord }
  | { type: typeof AgentEventType.ToolError; error: ToolErrorRecord }
  | {
      type: typeof AgentEventType.ApprovalRequired;
      approvals: ToolApprovalRequest[];
    }
  | {
      type: typeof AgentEventType.ApprovalResolved;
      approvals: ToolApprovalResponse[];
    }
  | {
      type: typeof AgentEventType.RunCompleted;
      content: string;
      stepsCompleted: number;
    }
  | {
      type: typeof AgentEventType.RunWaitingForApproval;
      approvals: ToolApprovalRequest[];
    }
  | { type: typeof AgentEventType.RunFailed; error: AgentError }
  | { type: typeof AgentEventType.RunCancelled; reason?: string };

export type AgentEvent = AgentEventBase & AgentEventPayload;
