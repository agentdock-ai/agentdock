import type { JsonValue } from "./json.js";
import type {
  ToolCallRecord,
  ToolErrorRecord,
  ToolResultRecord,
} from "./tools.js";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "image"; url: string; mimeType?: string }
  | { type: "file"; url: string; name?: string; mimeType?: string }
  | { type: "citation"; url: string; title?: string }
  | { type: "tool-call"; toolCall: ToolCallRecord }
  | { type: "tool-result"; result: ToolResultRecord }
  | { type: "custom"; name: string; data: JsonValue };

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentInterrupt {
  kind: "tool-approval" | "custom";
  interruptId: string;
  prompt: string;
  actions: Array<{ id: string; name: string; input: JsonValue }>;
  payload?: JsonValue;
}

export interface AgentEventBase {
  eventId: string;
  runId: string;
  sessionId: string;
  logicalSequence: number;
  phaseId: string;
  sequence: number;
  timestamp: string;
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
  | {
      type: typeof AgentEventType.ToolCalled;
      toolCall: ToolCallRecord;
    }
  | {
      type: typeof AgentEventType.ToolProgress;
      toolCallId: string;
      content: ContentPart[];
    }
  | {
      type: typeof AgentEventType.ToolCompleted;
      result: ToolResultRecord;
    }
  | {
      type: typeof AgentEventType.ToolFailed;
      error: ToolErrorRecord;
    }
  | {
      type: typeof AgentEventType.InterruptRequired;
      interrupt: AgentInterrupt;
    }
  | {
      type: typeof AgentEventType.InterruptResolved;
      interruptId: string;
      decisions: JsonValue[];
    }
  | {
      type: typeof AgentEventType.UsageUpdated;
      usage: AgentUsage;
    }
  | {
      type: typeof AgentEventType.RunCompleted;
      finishReason: string;
      content: ContentPart[];
      usage?: AgentUsage;
    }
  | {
      type: typeof AgentEventType.RunFailed;
      code: string;
      message: string;
    }
  | { type: typeof AgentEventType.RunCancelled; reason?: string };

export type AgentEvent = AgentEventBase & AgentEventInput;

export interface AgentReducerMessage {
  messageId: string;
  role: "user" | "assistant" | "tool";
  content: ContentPart[];
}

export interface AgentReducerState {
  runId: string | null;
  sessionId: string | null;
  status: "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  messages: AgentReducerMessage[];
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  toolErrors: ToolErrorRecord[];
  interrupt: AgentInterrupt | null;
  usage: AgentUsage | null;
  finishReason: string | null;
  lastSequence: number;
  lastLogicalSequence: number;
  lastPhaseId: string | null;
  eventIds: string[];
}

export function createAgentReducerState(): AgentReducerState {
  return {
    runId: null,
    sessionId: null,
    status: "idle",
    messages: [],
    toolCalls: [],
    toolResults: [],
    toolErrors: [],
    interrupt: null,
    usage: null,
    finishReason: null,
    lastSequence: 0,
    lastLogicalSequence: 0,
    lastPhaseId: null,
    eventIds: [],
  };
}

export function reduceAgentEvent(
  state: AgentReducerState,
  event: AgentEvent,
): AgentReducerState {
  if (state.eventIds.includes(event.eventId)) return state;
  if (state.runId !== null && state.runId !== event.runId) {
    throw new Error("Agent event run ID does not match reducer state.");
  }
  if (state.sessionId !== null && state.sessionId !== event.sessionId) {
    throw new Error("Agent event session ID does not match reducer state.");
  }
  if (event.logicalSequence <= state.lastLogicalSequence) {
    throw new Error(
      "Agent event logical sequence must increase monotonically.",
    );
  }
  if (
    state.lastPhaseId === event.phaseId &&
    event.sequence <= state.lastSequence
  ) {
    throw new Error("Agent event sequence must increase within a phase.");
  }

  const next: AgentReducerState = {
    ...state,
    runId: event.runId,
    sessionId: event.sessionId,
    lastSequence: event.sequence,
    lastLogicalSequence: event.logicalSequence,
    lastPhaseId: event.phaseId,
    eventIds: [...state.eventIds, event.eventId],
  };

  switch (event.type) {
    case AgentEventType.RunStarted:
      next.status = "running";
      break;
    case AgentEventType.MessageStarted:
      next.messages = upsertMessage(next.messages, {
        messageId: event.messageId,
        role: event.role,
        content: [],
      });
      break;
    case AgentEventType.MessagePartDelta: {
      const message = next.messages.find(
        (candidate) => candidate.messageId === event.messageId,
      );
      if (!message) throw new Error("Message delta has no started message.");
      next.messages = next.messages.map((candidate) =>
        candidate.messageId === event.messageId
          ? { ...candidate, content: [...candidate.content, event.part] }
          : candidate,
      );
      break;
    }
    case AgentEventType.MessageCompleted:
      next.messages = upsertMessage(next.messages, {
        messageId: event.messageId,
        role: event.role,
        content: event.content,
      });
      break;
    case AgentEventType.ToolCalled:
      next.toolCalls = upsertById(next.toolCalls, event.toolCall);
      break;
    case AgentEventType.ToolCompleted:
      next.toolResults = upsertById(next.toolResults, event.result);
      break;
    case AgentEventType.ToolFailed:
      next.toolErrors = upsertById(next.toolErrors, event.error);
      break;
    case AgentEventType.InterruptRequired:
      next.interrupt = event.interrupt;
      next.status = "waiting";
      break;
    case AgentEventType.InterruptResolved:
      if (next.interrupt?.interruptId === event.interruptId)
        next.interrupt = null;
      break;
    case AgentEventType.UsageUpdated:
      next.usage = event.usage;
      break;
    case AgentEventType.RunCompleted:
      next.status = "completed";
      next.finishReason = event.finishReason;
      next.usage = event.usage ?? next.usage;
      break;
    case AgentEventType.RunFailed:
      next.status = "failed";
      break;
    case AgentEventType.RunCancelled:
      next.status = "cancelled";
      break;
    case AgentEventType.ToolProgress:
      break;
  }

  return next;
}

export function reduceAgentEvents(
  events: readonly AgentEvent[],
): AgentReducerState {
  return events.reduce(reduceAgentEvent, createAgentReducerState());
}

function upsertMessage(
  messages: AgentReducerMessage[],
  message: AgentReducerMessage,
): AgentReducerMessage[] {
  const index = messages.findIndex(
    (candidate) => candidate.messageId === message.messageId,
  );
  if (index < 0) return [...messages, message];
  return messages.map((candidate, candidateIndex) =>
    candidateIndex === index ? message : candidate,
  );
}

function upsertById<T extends { toolCallId: string }>(
  records: T[],
  record: T,
): T[] {
  const index = records.findIndex(
    (candidate) => candidate.toolCallId === record.toolCallId,
  );
  if (index < 0) return [...records, record];
  return records.map((candidate, candidateIndex) =>
    candidateIndex === index ? record : candidate,
  );
}
