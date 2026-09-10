import {
  cloneJsonObject,
  cloneJsonValue,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "./json.js";
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

export interface AgentInterrupt {
  kind: "tool-approval" | "custom";
  interruptId: string;
  prompt: string;
  actions: Array<{ id: string; name: string; input: JsonValue }>;
  payload?: JsonValue;
}

export const AGENT_EVENT_PROTOCOL_VERSION = 1 as const;

export interface AgentEventBase {
  protocolVersion: typeof AGENT_EVENT_PROTOCOL_VERSION;
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
  | { type: typeof AgentEventType.UsageUpdated; usage: AgentUsage }
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
      limit?: AgentLimitInfo;
    }
  | {
      type: typeof AgentEventType.RunCancelled;
      reason?: string;
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
  sessionId: string | null;
  status: "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  messages: AgentReducerMessage[];
  toolCalls: ToolCallRecord[];
  toolProgress: AgentToolProgress[];
  toolResults: ToolResultRecord[];
  toolErrors: ToolErrorRecord[];
  interrupt: AgentInterrupt | null;
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

export function createAgentReducerState(): AgentReducerState {
  return {
    protocolVersion: null,
    runId: null,
    sessionId: null,
    status: "idle",
    messages: [],
    toolCalls: [],
    toolProgress: [],
    toolResults: [],
    toolErrors: [],
    interrupt: null,
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

export function cloneAgentEventInput(value: unknown): AgentEventInput {
  const input = cloneJsonObject(value, "Agent event input");
  assertAgentEventInput(input);
  return input as AgentEventInput;
}

export function cloneContentParts(
  value: unknown,
  label = "Content",
): ContentPart[] {
  const content = cloneJsonValue(value, label);
  assertContentParts(content, label);
  return content as ContentPart[];
}

export function cloneAgentEvent(value: unknown): AgentEvent {
  const event = cloneJsonObject(value, "Agent event");
  if (event.protocolVersion !== AGENT_EVENT_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported Agent event protocol version: ${String(event.protocolVersion)}.`,
    );
  }
  assertString(event.eventId, "Agent event.eventId");
  assertString(event.runId, "Agent event.runId");
  assertString(event.sessionId, "Agent event.sessionId");
  assertString(event.phaseId, "Agent event.phaseId");
  assertString(event.timestamp, "Agent event.timestamp");
  assertSequence(event.logicalSequence, "Agent event.logicalSequence");
  assertSequence(event.sequence, "Agent event.sequence");
  const {
    protocolVersion: _protocolVersion,
    eventId: _eventId,
    runId: _runId,
    sessionId: _sessionId,
    logicalSequence: _logicalSequence,
    phaseId: _phaseId,
    sequence: _sequence,
    timestamp: _timestamp,
    ...input
  } = event;
  assertAgentEventInput(input as JsonObject);
  return event as unknown as AgentEvent;
}

export function assertAgentEventInput(
  value: unknown,
): asserts value is AgentEventInput {
  if (!isJsonObject(value)) throw new Error("Agent event must be an object.");
  assertString(value.type, "Agent event.type");
  switch (value.type) {
    case AgentEventType.RunStarted:
      assertExactKeys(value as JsonObject, ["type"]);
      return;
    case AgentEventType.MessageStarted:
      assertString(value.messageId, "Agent event.messageId");
      assertRole(value.role);
      return;
    case AgentEventType.MessagePartDelta:
      assertString(value.messageId, "Agent event.messageId");
      assertContentPart(value.part, "Agent event.part");
      return;
    case AgentEventType.MessageCompleted:
      assertString(value.messageId, "Agent event.messageId");
      assertRole(value.role);
      assertContentParts(value.content, "Agent event.content");
      return;
    case AgentEventType.ToolCalled:
      assertToolCall(value.toolCall, "Agent event.toolCall");
      return;
    case AgentEventType.ToolProgress:
      assertString(value.toolCallId, "Agent event.toolCallId");
      assertContentParts(value.content, "Agent event.content");
      return;
    case AgentEventType.ToolCompleted:
      assertToolResult(value.result, "Agent event.result");
      return;
    case AgentEventType.ToolFailed:
      assertToolError(value.error, "Agent event.error");
      return;
    case AgentEventType.InterruptRequired:
      assertInterrupt(value.interrupt, "Agent event.interrupt");
      return;
    case AgentEventType.InterruptResolved:
      assertString(value.interruptId, "Agent event.interruptId");
      assertJsonArray(value.decisions, "Agent event.decisions");
      return;
    case AgentEventType.UsageUpdated:
      assertUsage(value.usage, "Agent event.usage");
      return;
    case AgentEventType.RunCompleted:
      assertString(value.finishReason, "Agent event.finishReason");
      assertContentParts(value.content, "Agent event.content");
      if (value.usage !== undefined)
        assertUsage(value.usage, "Agent event.usage");
      if (value.limit !== undefined)
        assertLimit(value.limit, "Agent event.limit");
      return;
    case AgentEventType.RunFailed:
      assertString(value.code, "Agent event.code");
      assertString(value.message, "Agent event.message");
      if (value.limit !== undefined)
        assertLimit(value.limit, "Agent event.limit");
      return;
    case AgentEventType.RunCancelled:
      if (value.reason !== undefined)
        assertString(value.reason, "Agent event.reason");
      if (value.limit !== undefined)
        assertLimit(value.limit, "Agent event.limit");
      return;
    default:
      throw new Error(`Unknown Agent event type: ${String(value.type)}.`);
  }
}

export function reduceAgentEvent(
  state: AgentReducerState,
  rawEvent: AgentEvent,
): AgentReducerState {
  const event = cloneAgentEvent(rawEvent);
  const fingerprint = JSON.stringify(event);
  const previousFingerprint = state.eventFingerprints[event.eventId];
  if (previousFingerprint !== undefined) {
    if (previousFingerprint !== fingerprint)
      throw new Error("Agent event ID was reused for different event data.");
    return state;
  }
  if (
    state.status === "completed" ||
    state.status === "failed" ||
    state.status === "cancelled"
  )
    throw new Error("Agent event cannot be applied after the run is terminal.");
  if (state.status === "idle" && event.type !== AgentEventType.RunStarted)
    throw new Error("Agent event stream must begin with run.started.");
  if (state.runId !== null && state.runId !== event.runId)
    throw new Error("Agent event run ID does not match reducer state.");
  if (
    state.protocolVersion !== null &&
    state.protocolVersion !== event.protocolVersion
  )
    throw new Error(
      "Agent event protocol version does not match reducer state.",
    );
  if (state.sessionId !== null && state.sessionId !== event.sessionId)
    throw new Error("Agent event session ID does not match reducer state.");
  if (event.logicalSequence <= state.lastLogicalSequence)
    throw new Error(
      "Agent event logical sequence must increase monotonically.",
    );
  if (
    state.lastPhaseId === event.phaseId &&
    event.sequence <= state.lastSequence
  )
    throw new Error("Agent event sequence must increase within a phase.");

  const next: AgentReducerState = {
    ...state,
    protocolVersion: event.protocolVersion,
    runId: event.runId,
    sessionId: event.sessionId,
    lastSequence: event.sequence,
    lastLogicalSequence: event.logicalSequence,
    lastPhaseId: event.phaseId,
    eventIds: [...state.eventIds, event.eventId],
    eventFingerprints: {
      ...state.eventFingerprints,
      [event.eventId]: fingerprint,
    },
  };
  switch (event.type) {
    case AgentEventType.RunStarted:
      if (state.status !== "idle" && state.status !== "waiting")
        throw new Error("Run can only start from idle or waiting state.");
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
      if (
        !next.messages.some((message) => message.messageId === event.messageId)
      )
        throw new Error("Message delta has no started message.");
      next.messages = next.messages.map((message) =>
        message.messageId === event.messageId
          ? { ...message, content: [...message.content, event.part] }
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
      if (next.interrupt) throw new Error("An interrupt is already pending.");
      next.interrupt = event.interrupt;
      next.interruptResolution = null;
      next.status = "waiting";
      break;
    case AgentEventType.InterruptResolved:
      if (next.interrupt?.interruptId !== event.interruptId)
        throw new Error(
          "Interrupt resolution does not match the pending interrupt.",
        );
      next.interrupt = null;
      next.interruptResolution = {
        interruptId: event.interruptId,
        decisions: event.decisions,
      };
      next.status = "running";
      break;
    case AgentEventType.UsageUpdated:
      next.usage = event.usage;
      break;
    case AgentEventType.RunCompleted:
      next.status = "completed";
      next.finishReason = event.finishReason;
      next.usage = event.usage ?? next.usage;
      next.limit = event.limit ?? next.limit;
      break;
    case AgentEventType.RunFailed:
      next.status = "failed";
      next.errorCode = event.code;
      next.limit = event.limit ?? next.limit;
      break;
    case AgentEventType.RunCancelled:
      next.status = "cancelled";
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

function assertContentParts(value: unknown, path: string): void {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  value.forEach((part, index) => assertContentPart(part, `${path}[${index}]`));
}

function assertContentPart(value: unknown, path: string): void {
  if (!isJsonObject(value) || typeof value.type !== "string")
    throw new Error(`${path} must be a content part.`);
  switch (value.type) {
    case "text":
    case "reasoning":
      assertString(value.text, `${path}.text`);
      return;
    case "image":
    case "audio":
    case "video":
    case "file":
      assertMediaSource(value, path);
      if (value.mimeType !== undefined)
        assertString(value.mimeType, `${path}.mimeType`);
      if (value.type === "file" && value.name !== undefined)
        assertString(value.name, `${path}.name`);
      return;
    case "citation":
      assertString(value.url, `${path}.url`);
      if (value.title !== undefined) assertString(value.title, `${path}.title`);
      return;
    case "tool-call":
      assertToolCall(value.toolCall, `${path}.toolCall`);
      return;
    case "tool-result":
      assertToolResult(value.result, `${path}.result`);
      return;
    case "custom":
      assertString(value.name, `${path}.name`);
      cloneJsonValue(value.data, `${path}.data`);
      return;
    default:
      throw new Error(`${path}.type is unsupported.`);
  }
}

function assertToolCall(
  value: unknown,
  path: string,
): asserts value is ToolCallRecord {
  if (!isJsonObject(value)) throw new Error(`${path} must be an object.`);
  assertString(value.toolCallId, `${path}.toolCallId`);
  assertString(value.name, `${path}.name`);
  cloneJsonObject(value.input, `${path}.input`);
}

function assertToolResult(
  value: unknown,
  path: string,
): asserts value is ToolResultRecord {
  assertToolCall(value, path);
  const result = value as ToolResultRecord;
  cloneJsonValue(result.output, `${path}.output`);
  if (result.isError !== undefined && typeof result.isError !== "boolean")
    throw new Error(`${path}.isError must be a boolean.`);
}

function assertToolError(
  value: unknown,
  path: string,
): asserts value is ToolErrorRecord {
  assertToolCall(value, path);
  const error = value as ToolErrorRecord;
  assertString(error.error, `${path}.error`);
  if (error.code !== undefined) assertString(error.code, `${path}.code`);
}

function assertInterrupt(
  value: unknown,
  path: string,
): asserts value is AgentInterrupt {
  if (!isJsonObject(value)) throw new Error(`${path} must be an object.`);
  if (value.kind !== "tool-approval" && value.kind !== "custom")
    throw new Error(`${path}.kind is unsupported.`);
  assertString(value.interruptId, `${path}.interruptId`);
  assertString(value.prompt, `${path}.prompt`);
  if (!Array.isArray(value.actions))
    throw new Error(`${path}.actions must be an array.`);
  value.actions.forEach((action, index) => {
    const actionPath = `${path}.actions[${index}]`;
    if (!isJsonObject(action))
      throw new Error(`${actionPath} must be an object.`);
    assertString(action.id, `${actionPath}.id`);
    assertString(action.name, `${actionPath}.name`);
    cloneJsonValue(action.input, `${actionPath}.input`);
  });
  if (value.payload !== undefined)
    cloneJsonValue(value.payload, `${path}.payload`);
}

function assertUsage(
  value: unknown,
  path: string,
): asserts value is AgentUsage {
  if (!isJsonObject(value)) throw new Error(`${path} must be an object.`);
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "costUsd",
  ] as const)
    if (value[key] !== undefined)
      assertNonNegativeNumber(value[key], `${path}.${key}`);
  if (value.model !== undefined) assertString(value.model, `${path}.model`);
  if (value.provider !== undefined)
    assertString(value.provider, `${path}.provider`);
}

function assertMediaSource(value: Record<string, unknown>, path: string): void {
  const sources = [value.url, value.data, value.fileId].filter(
    (source) => source !== undefined,
  );
  if (sources.length !== 1)
    throw new Error(`${path} must contain exactly one media source.`);
  if (value.url !== undefined) assertString(value.url, `${path}.url`);
  if (value.data !== undefined) assertString(value.data, `${path}.data`);
  if (value.fileId !== undefined) assertString(value.fileId, `${path}.fileId`);
}

function assertLimit(
  value: unknown,
  path: string,
): asserts value is AgentLimitInfo {
  if (!isJsonObject(value)) throw new Error(`${path} must be an object.`);
  assertString(value.kind, `${path}.kind`);
  if (value.limit !== undefined)
    assertNonNegativeNumber(value.limit, `${path}.limit`);
  if (value.used !== undefined)
    assertNonNegativeNumber(value.used, `${path}.used`);
}

function assertJsonArray(
  value: unknown,
  path: string,
): asserts value is JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  cloneJsonValue(value, path);
}
function assertRole(
  value: unknown,
): asserts value is AgentReducerMessage["role"] {
  if (value !== "user" && value !== "assistant" && value !== "tool")
    throw new Error("Agent event role is unsupported.");
}
function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
}
function assertFiniteNumber(
  value: unknown,
  path: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${path} must be a finite number.`);
}
function assertNonNegativeNumber(
  value: unknown,
  path: string,
): asserts value is number {
  assertFiniteNumber(value, path);
  if (value < 0) throw new Error(`${path} must be non-negative.`);
}
function assertSequence(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${path} must be a non-negative safe integer.`);
}
function assertExactKeys(value: JsonObject, keys: string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Agent event contains unsupported fields.");
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
