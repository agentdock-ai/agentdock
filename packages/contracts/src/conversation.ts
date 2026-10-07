import type { AgentEvent, AgentInterrupt, ContentPart } from "./events.js";
import type { JsonValue } from "./json.js";
import { cloneJsonValue } from "./json.js";
import {
  cloneAgentEvent,
  assertAgentInterrupt,
  cloneContentParts,
} from "./event-validation.js";

export const CONVERSATION_PROTOCOL_VERSION = 1 as const;

export interface ConversationThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  turnId: string;
  operationId: string;
  position: number;
  role: "user" | "assistant" | "tool";
  content: ContentPart[];
  outcome: "streaming" | "complete" | "stopped" | "error";
  createdAt: string;
}

export interface ConversationExecution {
  operationId: string;
  runId: string | null;
  status: "running" | "stopping" | "paused" | "settled" | "uncertain";
  action: "start" | "continue" | "approval";
}

export interface ConversationActions {
  canStart: boolean;
  canStop: boolean;
  canContinue: boolean;
  canRespondToInterrupt: boolean;
}

export interface ConversationHistory {
  protocolVersion: typeof CONVERSATION_PROTOCOL_VERSION;
  thread: ConversationThread;
  messages: ConversationMessage[];
  nextCursor: string | null;
  snapshotId: string;
  execution: ConversationExecution | null;
  nativeControls: { pendingNodes: string[]; interrupts: AgentInterrupt[] };
  interrupts: AgentInterrupt[];
  actions: ConversationActions;
}

export interface ConversationThreadPage {
  protocolVersion: typeof CONVERSATION_PROTOCOL_VERSION;
  threads: ConversationThread[];
  nextCursor: string | null;
}

export interface ConversationAttachment {
  id: string;
  threadId: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  size: number;
  url: string;
  createdAt: string;
}

export interface ConversationStartRequest {
  operationId: string;
  threadId: string;
  prompt: string;
  attachments: string[];
}

export interface ConversationContinueRequest {
  operationId: string;
  threadId: string;
  pendingOperationId: string;
}

export interface ConversationApprovalRequest {
  operationId: string;
  threadId: string;
  interruptId: string;
  decisions: JsonValue[];
}

export interface ConversationStopRequest {
  operationId: string;
  threadId: string;
  targetOperationId: string;
}

export interface ConversationEventEnvelope {
  protocolVersion: typeof CONVERSATION_PROTOCOL_VERSION;
  operationId: string;
  threadId: string;
  event: AgentEvent;
}

export type ConversationErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "persistence_failed"
  | "execution_uncertain";

export interface ConversationError {
  protocolVersion: typeof CONVERSATION_PROTOCOL_VERSION;
  code: ConversationErrorCode;
  message: string;
}

export function assertConversationStartRequest(
  value: unknown,
): asserts value is ConversationStartRequest {
  const request = object(value, "conversation start request");
  requiredId(request.operationId, "operationId");
  requiredId(request.threadId, "threadId");
  if (typeof request.prompt !== "string" || request.prompt.length > 100_000)
    throw new Error("prompt must be a string of at most 100000 characters.");
  if (
    !Array.isArray(request.attachments) ||
    request.attachments.length > 16 ||
    !request.attachments.every((id) => typeof id === "string" && id.length > 0)
  )
    throw new Error("attachments must contain at most 16 non-empty IDs.");
}

export function assertConversationContinueRequest(
  value: unknown,
): asserts value is ConversationContinueRequest {
  const request = object(value, "conversation continue request");
  requiredId(request.operationId, "operationId");
  requiredId(request.threadId, "threadId");
  requiredId(request.pendingOperationId, "pendingOperationId");
}

export function assertConversationApprovalRequest(
  value: unknown,
): asserts value is ConversationApprovalRequest {
  const request = object(value, "conversation approval request");
  requiredId(request.operationId, "operationId");
  requiredId(request.threadId, "threadId");
  requiredId(request.interruptId, "interruptId");
  if (!Array.isArray(request.decisions) || request.decisions.length > 64)
    throw new Error("decisions must be an array with at most 64 entries.");
  request.decisions.forEach((decision) => cloneJsonValue(decision));
}

export function assertConversationStopRequest(
  value: unknown,
): asserts value is ConversationStopRequest {
  const request = object(value, "conversation stop request");
  requiredId(request.operationId, "operationId");
  requiredId(request.threadId, "threadId");
  requiredId(request.targetOperationId, "targetOperationId");
}

export function assertConversationThread(
  value: unknown,
): asserts value is ConversationThread {
  const thread = object(value, "conversation thread");
  requiredId(thread.id, "thread.id");
  if (typeof thread.title !== "string" || thread.title.length > 200)
    throw new Error("thread.title must be a string of at most 200 characters.");
  for (const key of ["createdAt", "updatedAt"] as const) {
    if (
      typeof thread[key] !== "string" ||
      !Number.isFinite(Date.parse(thread[key]))
    )
      throw new Error(`thread.${key} must be an ISO date string.`);
  }
}

export function cloneConversationThreadPage(
  value: unknown,
): ConversationThreadPage {
  const page = object(value, "conversation thread page");
  if (
    page.protocolVersion !== CONVERSATION_PROTOCOL_VERSION ||
    !Array.isArray(page.threads)
  )
    throw new Error("Conversation thread page is invalid.");
  if (page.nextCursor !== null && typeof page.nextCursor !== "string")
    throw new Error("Conversation thread page cursor is invalid.");
  const threads = page.threads.map((thread) => {
    assertConversationThread(thread);
    return structuredClone(thread);
  });
  return {
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    threads,
    nextCursor: page.nextCursor as string | null,
  };
}

export function cloneConversationAttachment(
  value: unknown,
): ConversationAttachment {
  const attachment = object(value, "conversation attachment");
  requiredId(attachment.id, "attachment.id");
  requiredId(attachment.threadId, "attachment.threadId");
  if (typeof attachment.name !== "string" || attachment.name.length > 240)
    throw new Error("attachment.name is invalid.");
  if (
    !(
      ["image/png", "image/jpeg", "image/gif", "image/webp"] as unknown[]
    ).includes(attachment.mimeType)
  )
    throw new Error("attachment.mimeType is invalid.");
  if (!Number.isSafeInteger(attachment.size) || (attachment.size as number) < 1)
    throw new Error("attachment.size is invalid.");
  if (
    typeof attachment.url !== "string" ||
    !attachment.url.startsWith("/") ||
    attachment.url.startsWith("//")
  )
    throw new Error("attachment.url must be a same-origin path.");
  if (
    typeof attachment.createdAt !== "string" ||
    !Number.isFinite(Date.parse(attachment.createdAt))
  )
    throw new Error("attachment.createdAt is invalid.");
  return structuredClone(value) as ConversationAttachment;
}

export function cloneConversationHistory(value: unknown): ConversationHistory {
  const history = object(value, "conversation history");
  if (
    history.protocolVersion !== CONVERSATION_PROTOCOL_VERSION ||
    !Array.isArray(history.messages) ||
    typeof history.snapshotId !== "string" ||
    (history.nextCursor !== null && typeof history.nextCursor !== "string") ||
    !Array.isArray(history.interrupts)
  )
    throw new Error("Conversation history is invalid.");
  assertConversationThread(history.thread);
  for (const message of history.messages) assertConversationMessage(message);
  const actions = object(history.actions, "conversation history actions");
  for (const key of [
    "canStart",
    "canStop",
    "canContinue",
    "canRespondToInterrupt",
  ] as const) {
    if (typeof actions[key] !== "boolean")
      throw new Error(`Conversation action ${key} must be boolean.`);
  }
  for (const interrupt of history.interrupts) assertAgentInterrupt(interrupt);
  const nativeControls = object(
    history.nativeControls,
    "conversation native controls",
  );
  if (
    !Array.isArray(nativeControls.pendingNodes) ||
    !nativeControls.pendingNodes.every((node) => typeof node === "string")
  )
    throw new Error("Conversation pending nodes are invalid.");
  if (!Array.isArray(nativeControls.interrupts))
    throw new Error("Conversation interrupts are invalid.");
  for (const interrupt of nativeControls.interrupts)
    assertAgentInterrupt(interrupt);
  const execution = history.execution;
  if (execution !== null) {
    const state = object(execution, "conversation execution");
    requiredId(state.operationId, "execution.operationId");
    if (state.runId !== null && typeof state.runId !== "string")
      throw new Error("execution.runId must be a string or null.");
    if (
      !["running", "stopping", "paused", "settled", "uncertain"].includes(
        String(state.status),
      )
    )
      throw new Error("execution.status is invalid.");
    if (!["start", "continue", "approval"].includes(String(state.action)))
      throw new Error("execution.action is invalid.");
  }
  return structuredClone(value) as ConversationHistory;
}

export function cloneConversationEventEnvelope(
  value: unknown,
): ConversationEventEnvelope {
  const envelope = object(value, "conversation event envelope");
  if (envelope.protocolVersion !== CONVERSATION_PROTOCOL_VERSION)
    throw new Error("Unsupported conversation protocol version.");
  requiredId(envelope.operationId, "operationId");
  requiredId(envelope.threadId, "threadId");
  return {
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    operationId: envelope.operationId as string,
    threadId: envelope.threadId as string,
    event: cloneAgentEvent(envelope.event),
  };
}

export function assertConversationMessage(
  value: unknown,
): asserts value is ConversationMessage {
  const message = object(value, "conversation message");
  requiredId(message.id, "message.id");
  requiredId(message.turnId, "message.turnId");
  requiredId(message.operationId, "message.operationId");
  requiredId(message.createdAt, "message.createdAt");
  if (
    !Number.isFinite(Date.parse(message.createdAt)) ||
    !Number.isSafeInteger(message.position) ||
    (message.position as number) < 0
  )
    throw new Error("Conversation message position/time is invalid.");
  if (!["user", "assistant", "tool"].includes(String(message.role)))
    throw new Error("Conversation message role is invalid.");
  if (
    !["streaming", "complete", "stopped", "error"].includes(
      String(message.outcome),
    )
  )
    throw new Error("Conversation message outcome is invalid.");
  cloneContentParts(message.content);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requiredId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200)
    throw new Error(
      `${label} must be a non-empty string of at most 200 characters.`,
    );
}
