import {
  cloneJsonObject,
  cloneJsonValue,
  isJsonObject,
  type JsonValue,
} from "./json.js";
import {
  AGENT_EVENT_PROTOCOL_VERSION,
  AgentEventType,
  type AgentEvent,
  type AgentEventInput,
  type AgentInterrupt,
  type AgentUsage,
  type AgentLimitInfo,
  type AgentReducerMessage,
  type ContentPart,
} from "./events.js";
import type {
  ToolCallRecord,
  ToolErrorRecord,
  ToolResultRecord,
} from "./tools.js";

export function cloneContentParts(
  value: unknown,
  label = "Content",
): ContentPart[] {
  const content = cloneJsonValue(value, label);
  assertContentParts(content, label);
  return content;
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
  assertAgentEventInput(input);
  return event as unknown as AgentEvent;
}

export function assertAgentEventInput(
  value: unknown,
): asserts value is AgentEventInput {
  if (!isJsonObject(value)) throw new Error("Agent event must be an object.");
  assertString(value.type, "Agent event.type");
  const fields = EVENT_FIELDS.get(value.type);
  if (!fields) throw new Error(`Unknown Agent event type: ${value.type}.`);
  if (Object.keys(value).some((key) => key !== "type" && !fields.includes(key)))
    throw new Error("Agent event contains unsupported fields.");
  switch (value.type) {
    case AgentEventType.RunStarted:
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
  }
}

function assertContentParts(
  value: unknown,
  path: string,
): asserts value is ContentPart[] {
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
  if (!isJsonObject(value)) throw new Error(`${path} must be an object.`);
  assertToolCall(value, path);
  cloneJsonValue(value.output, `${path}.output`);
  if (value.isError !== undefined && typeof value.isError !== "boolean")
    throw new Error(`${path}.isError must be a boolean.`);
}

function assertToolError(
  value: unknown,
  path: string,
): asserts value is ToolErrorRecord {
  if (!isJsonObject(value)) throw new Error(`${path} must be an object.`);
  assertToolCall(value, path);
  assertString(value.error, `${path}.error`);
  if (value.code !== undefined) assertString(value.code, `${path}.code`);
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${path} must be a non-negative safe integer.`);
}
function assertRecoverable(value: unknown): void {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error("Agent event.recoverable must be a boolean.");
}

const EVENT_FIELDS = new Map<string, readonly string[]>(
  Object.entries({
    "run.started": [],
    "message.started": ["messageId", "role"],
    "message.part.delta": ["messageId", "part"],
    "message.completed": ["messageId", "role", "content"],
    "tool.called": ["toolCall"],
    "tool.progress": ["toolCallId", "content"],
    "tool.completed": ["result"],
    "tool.failed": ["error"],
    "interrupt.required": ["interrupt"],
    "interrupt.resolved": ["interruptId", "decisions"],
    "usage.updated": ["usage", "messageId"],
    "run.paused": ["next"],
    "run.completed": ["finishReason", "content", "usage", "limit"],
    "run.failed": ["code", "message", "recoverable", "limit"],
    "run.cancelled": ["reason", "recoverable", "limit"],
  } satisfies Record<AgentEventInput["type"], readonly string[]>),
);
