import {
  AgentEventType,
  type AgentEvent,
  type AgentReducerState,
  type AgentReducerMessage,
  type ContentPart,
} from "./events.js";
import { cloneAgentEvent } from "./event-validation.js";
import { sumUsage } from "./usage.js";
import type { ToolCallRecord } from "./tools.js";

export function createAgentReducerState(): AgentReducerState {
  return {
    protocolVersion: null,
    runId: null,
    threadId: null,
    status: "idle",
    messages: [],
    toolCalls: [],
    toolProgress: [],
    toolResults: [],
    toolErrors: [],
    interrupt: null,
    interrupts: [],
    pausedNodes: [],
    usageByMessage: {},
    interruptResolution: null,
    usage: null,
    limit: null,
    finishReason: null,
    errorCode: null,
    cancellationReason: null,
    lastSequence: 0,
    lastLogicalSequence: 0,
    lastPhaseId: null,
    eventIds: [],
    eventFingerprints: {},
  };
}

export function reduceAgentEvent(
  state: AgentReducerState,
  rawEvent: AgentEvent,
): AgentReducerState {
  const event = cloneAgentEvent(rawEvent);
  const fingerprint = JSON.stringify(event);
  const previousFingerprint = Object.prototype.hasOwnProperty.call(
    state.eventFingerprints,
    event.eventId,
  )
    ? state.eventFingerprints[event.eventId]
    : undefined;
  const newInvocation =
    event.type === AgentEventType.RunStarted && state.runId !== event.runId;
  if (previousFingerprint !== undefined) {
    if (previousFingerprint !== fingerprint)
      throw new Error("Agent event ID was reused for different event data.");
    return state;
  }
  if (
    (state.status === "completed" ||
      state.status === "failed" ||
      state.status === "cancelled") &&
    !newInvocation
  )
    throw new Error("Agent event cannot be applied after the run is terminal.");
  if (state.status === "idle" && event.type !== AgentEventType.RunStarted)
    throw new Error("Agent event stream must begin with run.started.");
  if (state.runId !== null && state.runId !== event.runId && !newInvocation)
    throw new Error("Agent event run ID does not match reducer state.");
  if (
    state.protocolVersion !== null &&
    state.protocolVersion !== event.protocolVersion
  )
    throw new Error(
      "Agent event protocol version does not match reducer state.",
    );
  if (!newInvocation && event.logicalSequence <= state.lastLogicalSequence)
    throw new Error(
      "Agent event logical sequence must increase monotonically.",
    );
  if (
    !newInvocation &&
    state.lastPhaseId === event.phaseId &&
    event.sequence <= state.lastSequence
  )
    throw new Error("Agent event sequence must increase within a phase.");

  const eventIds = [
    ...(newInvocation ? [] : state.eventIds),
    event.eventId,
  ].slice(-128);
  const eventFingerprints: Record<string, string> = {};
  for (const id of eventIds) {
    Object.defineProperty(eventFingerprints, id, {
      value: id === event.eventId ? fingerprint : state.eventFingerprints[id],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const next: AgentReducerState = {
    ...state,
    protocolVersion: event.protocolVersion,
    runId: event.runId,
    lastSequence: event.sequence,
    lastLogicalSequence: event.logicalSequence,
    lastPhaseId: event.phaseId,
    eventIds,
    eventFingerprints,
  };
  switch (event.type) {
    case AgentEventType.RunStarted:
      if (
        state.status === "running" ||
        (!newInvocation && state.status !== "idle")
      )
        throw new Error("Run can only start from idle or waiting state.");
      next.status = "running";
      next.errorCode = null;
      next.cancellationReason = null;
      next.finishReason = null;
      next.usage = null;
      next.usageByMessage = {};
      next.limit = null;
      break;
    case AgentEventType.MessageStarted:
      next.messages = upsertMessage(next.messages, {
        messageId: event.messageId,
        role: event.role,
        content: [],
      });
      break;
    case AgentEventType.MessagePartDelta: {
      if (
        !next.messages.some((message) => message.messageId === event.messageId)
      )
        throw new Error("Message delta has no started message.");
      next.messages = next.messages.map((message) =>
        message.messageId === event.messageId
          ? { ...message, content: appendContent(message.content, event.part) }
          : message,
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
      next.toolCalls = upsertToolCall(next.toolCalls, event.toolCall);
      break;
    case AgentEventType.ToolProgress:
      if (!hasToolCall(next.toolCalls, event.toolCallId))
        throw new Error("Tool progress has no known tool call.");
      next.toolProgress = upsertById(next.toolProgress, {
        toolCallId: event.toolCallId,
        content: event.content,
      });
      break;
    case AgentEventType.ToolCompleted:
      if (!hasToolCall(next.toolCalls, event.result.toolCallId))
        throw new Error("Tool result has no known tool call.");
      next.toolResults = upsertById(next.toolResults, event.result);
      break;
    case AgentEventType.ToolFailed:
      if (!hasToolCall(next.toolCalls, event.error.toolCallId))
        throw new Error("Tool error has no known tool call.");
      next.toolErrors = upsertById(next.toolErrors, event.error);
      break;
    case AgentEventType.InterruptRequired:
      if (
        next.interrupts.some(
          (item) => item.interruptId === event.interrupt.interruptId,
        )
      )
        throw new Error("An interrupt with this ID is already pending.");
      next.interrupts = [...next.interrupts, event.interrupt];
      next.interrupt = next.interrupts[0] ?? null;
      next.interruptResolution = null;
      next.status = "waiting";
      break;
    case AgentEventType.InterruptResolved:
      if (
        !next.interrupts.some((item) => item.interruptId === event.interruptId)
      )
        throw new Error(
          "Interrupt resolution does not match the pending interrupt.",
        );
      next.interrupts = next.interrupts.filter(
        (item) => item.interruptId !== event.interruptId,
      );
      next.interrupt = next.interrupts[0] ?? null;
      next.interruptResolution = {
        interruptId: event.interruptId,
        decisions: event.decisions,
      };
      next.status = next.interrupts.length > 0 ? "waiting" : "running";
      break;
    case AgentEventType.RunPaused:
      next.pausedNodes = event.next;
      next.status = "waiting";
      break;
    case AgentEventType.UsageUpdated:
      if (event.messageId === undefined) next.usage = event.usage;
      else {
        next.usageByMessage = {
          ...next.usageByMessage,
          [event.messageId]: event.usage,
        };
        next.usage = sumUsage(Object.values(next.usageByMessage));
      }
      break;
    case AgentEventType.RunCompleted:
      if (next.interrupts.length > 0)
        throw new Error("Cannot complete while interrupts are pending.");
      next.pausedNodes = [];
      next.status = "completed";
      next.finishReason = event.finishReason;
      next.usage = event.usage ?? next.usage;
      next.limit = event.limit ?? next.limit;
      break;
    case AgentEventType.RunFailed:
      next.status = event.recoverable ? "waiting" : "failed";
      next.errorCode = event.code;
      next.limit = event.limit ?? next.limit;
      break;
    case AgentEventType.RunCancelled:
      next.status = event.recoverable ? "waiting" : "cancelled";
      next.cancellationReason = event.reason ?? null;
      next.limit = event.limit ?? next.limit;
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
function hasToolCall(toolCalls: ToolCallRecord[], toolCallId: string): boolean {
  return toolCalls.some((candidate) => candidate.toolCallId === toolCallId);
}
function upsertToolCall(
  toolCalls: ToolCallRecord[],
  toolCall: ToolCallRecord,
): ToolCallRecord[] {
  const existing = toolCalls.find(
    (candidate) => candidate.toolCallId === toolCall.toolCallId,
  );
  if (!existing) return [...toolCalls, toolCall];
  if (JSON.stringify(existing) !== JSON.stringify(toolCall))
    throw new Error("Tool call ID was reused for different tool data.");
  return toolCalls;
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

function appendContent(
  content: ContentPart[],
  part: ContentPart,
): ContentPart[] {
  const last = content[content.length - 1];
  if (
    (part.type === "text" || part.type === "reasoning") &&
    last?.type === part.type
  ) {
    return [...content.slice(0, -1), { ...part, text: last.text + part.text }];
  }
  return [...content, part];
}
