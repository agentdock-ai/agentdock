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
  assertString(event.phaseId, "Agent event.phaseId");
  assertString(event.timestamp, "Agent event.timestamp");
  if (
    event.namespace !== undefined &&
    (!Array.isArray(event.namespace) ||
      !event.namespace.every((part) => typeof part === "string"))
  )
    throw new Error("Agent event.namespace must be a string array.");
  assertSequence(event.logicalSequence, "Agent event.logicalSequence");
  assertSequence(event.sequence, "Agent event.sequence");
  const {
    protocolVersion: _protocolVersion,
    eventId: _eventId,
    runId: _runId,
    logicalSequence: _logicalSequence,
    phaseId: _phaseId,
    sequence: _sequence,
    timestamp: _timestamp,
    namespace: _namespace,
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
      assertAgentInterrupt(value.interrupt);
      return;
    case AgentEventType.InterruptResolved:
      assertString(value.interruptId, "Agent event.interruptId");
      assertJsonArray(value.decisions, "Agent event.decisions");
      return;
    case AgentEventType.RunPaused:
      if (
        !Array.isArray(value.next) ||
        !value.next.every((node) => typeof node === "string")
      )
        throw new Error("Agent event.next must be a string array.");
      return;
    case AgentEventType.UsageUpdated:
      if (value.messageId !== undefined)
        assertString(value.messageId, "Agent event.messageId");
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
      assertRecoverable(value.recoverable);
      assertString(value.code, "Agent event.code");
      assertString(value.message, "Agent event.message");
      if (value.limit !== undefined)
        assertLimit(value.limit, "Agent event.limit");
      return;
    case AgentEventType.RunCancelled:
      assertRecoverable(value.recoverable);
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

export function assertAgentInterrupt(
  value: unknown,
): asserts value is AgentInterrupt {
  assertInterrupt(value, "Agent interrupt");
}

function assertInterrupt(
  value: unknown,
  path: string,
): asserts value is AgentInterrupt {
  if (!isJsonObject(value)) throw new Error(`${path} must be an object.`);
  if (value.kind !== "tool-approval" && value.kind !== "custom")
    throw new Error(`${path}.kind is unsupported.`);
  assertString(value.interruptId, `${path}.interruptId`);
  if (value.interruptId.length === 0)
    throw new Error(`${path}.interruptId must be a non-empty string.`);
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
    if (action.toolCallId !== undefined) {
      if (
        typeof action.toolCallId !== "string" ||
        action.toolCallId.length === 0
      )
        throw new Error(`${actionPath}.toolCallId must be a non-empty string.`);
    }
    if (value.kind === "tool-approval") {
      assertString(action.toolCallId, `${actionPath}.toolCallId`);
    }
  });
  if (value.payload !== undefined)
    cloneJsonValue(value.payload, `${path}.payload`);
  if (value.responseSchema !== undefined)
    cloneJsonValue(value.responseSchema, `${path}.responseSchema`);
  if (
    value.occurrence !== undefined &&
    (!Number.isSafeInteger(value.occurrence) ||
      typeof value.occurrence !== "number" ||
      value.occurrence < 0)
  )
    throw new Error(`${path}.occurrence must be a non-negative safe integer.`);
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

function assertRecoverable(value: unknown): void {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error("Agent event.recoverable must be a boolean.");
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

export function sumUsage(usages: readonly AgentUsage[]): AgentUsage {
  const result: AgentUsage = {};
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "costUsd",
  ] as const) {
    const values = usages.flatMap((usage) =>
      usage[key] === undefined ? [] : [usage[key]],
    );
    if (values.length > 0)
      result[key] = values.reduce((sum, value) => sum + value, 0);
  }
  return result;
}
