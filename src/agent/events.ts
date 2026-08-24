import type {
  ToolApprovalRequest,
  ToolApprovalResponse,
} from "./permissions/types.js";
import type {
  ToolCallRecord,
  ToolResultRecord,
} from "./types.js";

export interface AgentEventBase {
  version: 1;
  eventId: string;
  runId: string;
  timestamp: string;
}

export interface AgentError {
  code: string;
  message: string;
  retryable?: boolean;
}

export const AgentEventType = {
  RunStarted: "run.started",
  StreamStarted: "stream.started",
  StepStarted: "step.started",
  TextStarted: "text.started",
  TextDelta: "text.delta",
  TextCompleted: "text.completed",
  ReasoningStarted: "reasoning.started",
  ReasoningDelta: "reasoning.delta",
  ReasoningCompleted: "reasoning.completed",
  Custom: "content.custom",
  ToolInputStarted: "tool.input.started",
  ToolInputDelta: "tool.input.delta",
  ToolInputCompleted: "tool.input.completed",
  ToolCalled: "tool.called",
  ToolResult: "tool.result",
  ToolError: "tool.error",
  ToolOutputDenied: "tool.output.denied",
  ApprovalRequired: "approval.required",
  ApprovalResolved: "approval.resolved",
  SourceAvailable: "source.available",
  FileGenerated: "file.generated",
  ReasoningFileGenerated: "reasoning.file.generated",
  StepCompleted: "step.completed",
  StreamFinished: "stream.finished",
  StreamAborted: "stream.aborted",
  StreamError: "stream.error",
  StreamRaw: "stream.raw",
  RunCompleted: "run.completed",
  RunFailed: "run.failed",
  RunCancelled: "run.cancelled",
} as const;

export type AgentEventType =
  (typeof AgentEventType)[keyof typeof AgentEventType];

export type AgentEventPayload =
  | { type: typeof AgentEventType.RunStarted }
  | { type: typeof AgentEventType.StreamStarted }
  | { type: typeof AgentEventType.StepStarted; step: number }
  | { type: typeof AgentEventType.TextStarted; id: string }
  | { type: typeof AgentEventType.TextDelta; id?: string; text: string }
  | { type: typeof AgentEventType.TextCompleted; id: string }
  | { type: typeof AgentEventType.ReasoningStarted; id: string }
  | {
      type: typeof AgentEventType.ReasoningDelta;
      id: string;
      text: string;
    }
  | { type: typeof AgentEventType.ReasoningCompleted; id: string }
  | {
      type: typeof AgentEventType.Custom;
      kind: string;
      metadata?: unknown;
    }
  | {
      type: typeof AgentEventType.ToolInputStarted;
      id: string;
      toolName: string;
      metadata?: unknown;
    }
  | {
      type: typeof AgentEventType.ToolInputDelta;
      id: string;
      delta: string;
    }
  | { type: typeof AgentEventType.ToolInputCompleted; id: string }
  | { type: typeof AgentEventType.ToolCalled; toolCall: ToolCallRecord }
  | { type: typeof AgentEventType.ToolResult; result: ToolResultRecord }
  | {
      type: typeof AgentEventType.ToolError;
      toolCall: ToolCallRecord;
      error: AgentError;
    }
  | {
      type: typeof AgentEventType.ToolOutputDenied;
      toolCall: ToolCallRecord;
    }
  | { type: typeof AgentEventType.ApprovalRequired; approvals: ToolApprovalRequest[] }
  | { type: typeof AgentEventType.ApprovalResolved; approvals: ToolApprovalResponse[] }
  | { type: typeof AgentEventType.SourceAvailable; source: unknown }
  | { type: typeof AgentEventType.FileGenerated; file: unknown }
  | {
      type: typeof AgentEventType.ReasoningFileGenerated;
      file: unknown;
    }
  | { type: typeof AgentEventType.StepCompleted; step: number }
  | {
      type: typeof AgentEventType.StreamFinished;
      finishReason: string;
      usage: unknown;
    }
  | { type: typeof AgentEventType.StreamAborted; reason?: string }
  | { type: typeof AgentEventType.StreamError; error: AgentError }
  | { type: typeof AgentEventType.StreamRaw; value: unknown }
  | {
      type: typeof AgentEventType.RunCompleted;
      content: string;
      stepsCompleted: number;
    }
  | { type: typeof AgentEventType.RunFailed; error: AgentError }
  | { type: typeof AgentEventType.RunCancelled; reason?: string };

export type AgentEvent = AgentEventBase & AgentEventPayload;
