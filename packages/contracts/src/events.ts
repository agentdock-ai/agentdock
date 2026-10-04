import type { JsonValue } from "./json.js";
import type {
  ToolCallRecord,
  ToolErrorRecord,
  ToolResultRecord,
} from "./tools.js";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "image" | "audio" | "video";
      url?: string;
      data?: string;
      fileId?: string;
      mimeType?: string;
    }
  | {
      type: "file";
      url?: string;
      data?: string;
      fileId?: string;
      name?: string;
      mimeType?: string;
    }
  | { type: "citation"; url: string; title?: string }
  | { type: "tool-call"; toolCall: ToolCallRecord }
  | { type: "tool-result"; result: ToolResultRecord }
  | { type: "custom"; name: string; data: JsonValue };

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  model?: string;
  provider?: string;
}

export interface AgentLimitInfo {
  kind: string;
  limit?: number;
  used?: number;
}

export interface AgentInterruptAction {
  id: string;
  name: string;
  input: JsonValue;
  /** Required on tool-approval actions; optional for custom interrupts. */
  toolCallId?: string;
}

export interface AgentToolApprovalInterruptAction extends AgentInterruptAction {
  toolCallId: string;
}

interface AgentInterruptBase {
  interruptId: string;
  prompt: string;
  payload?: JsonValue;
  /** JSON Schema supplied by native interrupt response validation. */
  responseSchema?: JsonValue;
  /** Native answer index when available; subsequent questions may reuse an ID. */
  occurrence?: number;
}

export type AgentInterrupt =
  | (AgentInterruptBase & {
      kind: "tool-approval";
      actions: AgentToolApprovalInterruptAction[];
    })
  | (AgentInterruptBase & {
      kind: "custom";
      actions: AgentInterruptAction[];
    });

export const AGENT_EVENT_PROTOCOL_VERSION = 3 as const;

export interface AgentEventBase {
  protocolVersion: typeof AGENT_EVENT_PROTOCOL_VERSION;
  eventId: string;
  runId: string;
  logicalSequence: number;
  phaseId: string;
  sequence: number;
  timestamp: string;
  namespace?: string[];
}

export const AgentEventType = {
  RunStarted: "run.started",
  MessageStarted: "message.started",
  MessagePartDelta: "message.part.delta",
  MessageCompleted: "message.completed",
  ToolCalled: "tool.called",
  ToolProgress: "tool.progress",
  ToolCompleted: "tool.completed",
  ToolFailed: "tool.failed",
  InterruptRequired: "interrupt.required",
  InterruptResolved: "interrupt.resolved",
  UsageUpdated: "usage.updated",
  RunPaused: "run.paused",
  RunCompleted: "run.completed",
  RunFailed: "run.failed",
  RunCancelled: "run.cancelled",
} as const;

export type AgentEventType =
  (typeof AgentEventType)[keyof typeof AgentEventType];

export type AgentEventInput =
  | { type: typeof AgentEventType.RunStarted }
  | {
      type: typeof AgentEventType.MessageStarted;
      messageId: string;
      role: "user" | "assistant" | "tool";
    }
  | {
      type: typeof AgentEventType.MessagePartDelta;
      messageId: string;
      part: ContentPart;
    }
  | {
      type: typeof AgentEventType.MessageCompleted;
      messageId: string;
      role: "user" | "assistant" | "tool";
      content: ContentPart[];
    }
  | { type: typeof AgentEventType.ToolCalled; toolCall: ToolCallRecord }
  | {
      type: typeof AgentEventType.ToolProgress;
      toolCallId: string;
      content: ContentPart[];
    }
  | { type: typeof AgentEventType.ToolCompleted; result: ToolResultRecord }
  | { type: typeof AgentEventType.ToolFailed; error: ToolErrorRecord }
  | { type: typeof AgentEventType.InterruptRequired; interrupt: AgentInterrupt }
  | {
      type: typeof AgentEventType.InterruptResolved;
      interruptId: string;
      decisions: JsonValue[];
    }
  | {
      type: typeof AgentEventType.UsageUpdated;
      usage: AgentUsage;
      messageId?: string;
    }
  | { type: typeof AgentEventType.RunPaused; next: string[] }
  | {
      type: typeof AgentEventType.RunCompleted;
      finishReason: string;
      content: ContentPart[];
      usage?: AgentUsage;
      limit?: AgentLimitInfo;
    }
  | {
      type: typeof AgentEventType.RunFailed;
      code: string;
      message: string;
      recoverable?: boolean;
      limit?: AgentLimitInfo;
    }
  | {
      type: typeof AgentEventType.RunCancelled;
      reason?: string;
      recoverable?: boolean;
      limit?: AgentLimitInfo;
    };

export type AgentEvent = AgentEventBase & AgentEventInput;

export interface AgentReducerMessage {
  messageId: string;
  role: "user" | "assistant" | "tool";
  content: ContentPart[];
}

export interface AgentToolProgress {
  toolCallId: string;
  content: ContentPart[];
}

export interface AgentInterruptResolution {
  interruptId: string;
  decisions: JsonValue[];
}

export interface AgentReducerState {
  protocolVersion: typeof AGENT_EVENT_PROTOCOL_VERSION | null;
  runId: string | null;
  threadId: string | null;
  status: "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  messages: AgentReducerMessage[];
  toolCalls: ToolCallRecord[];
  toolProgress: AgentToolProgress[];
  toolResults: ToolResultRecord[];
  toolErrors: ToolErrorRecord[];
  /** First pending interrupt; use interrupts when more than one is pending. */
  interrupt: AgentInterrupt | null;
  interrupts: AgentInterrupt[];
  pausedNodes: string[];
  usageByMessage: Record<string, AgentUsage>;
  interruptResolution: AgentInterruptResolution | null;
  usage: AgentUsage | null;
  limit: AgentLimitInfo | null;
  finishReason: string | null;
  errorCode: string | null;
  cancellationReason: string | null;
  lastSequence: number;
  lastLogicalSequence: number;
  lastPhaseId: string | null;
  eventIds: string[];
  eventFingerprints: Record<string, string>;
}
