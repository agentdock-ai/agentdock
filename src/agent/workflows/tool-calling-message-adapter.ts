import {
  isAIMessage,
  isBaseMessage,
  isToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { Message } from "../memory.js";
import type { ToolCallRecord } from "../types.js";
import { isRecord, messageText } from "../value.js";

export function readStateMessages(state: unknown): BaseMessage[] {
  if (!isRecord(state) || !isRecord(state.values)) return [];
  const messages = state.values.messages;
  return Array.isArray(messages) ? messages.filter(isBaseMessage) : [];
}

export function readStateRunId(state: unknown): string | null {
  if (!isRecord(state) || !isRecord(state.values)) return null;
  const runId = state.values.agentdockRunId;
  return typeof runId === "string" ? runId : null;
}

export function stateHasInterrupt(state: unknown): boolean {
  if (!isRecord(state) || !Array.isArray(state.tasks)) return false;
  return state.tasks.some(
    (task) =>
      isRecord(task) &&
      Array.isArray(task.interrupts) &&
      task.interrupts.length > 0,
  );
}

export function findLastAssistantWithToolCalls(
  messages: BaseMessage[],
): BaseMessage | null {
  for (const message of [...messages].reverse()) {
    if (isAIMessage(message) && (message.tool_calls?.length ?? 0) > 0)
      return message;
  }
  return null;
}

export function normalizeMessages(
  messages: BaseMessage[],
  toolCallsById: Map<string, ToolCallRecord>,
): Message[] {
  const normalized: Message[] = [];
  for (const message of messages) {
    if (isAIMessage(message)) {
      const toolCalls = (message.tool_calls ?? []).map(toToolCallRecord);
      normalized.push({
        role: "assistant",
        content: messageText(message.content),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(message.id ? { id: message.id } : {}),
      });
      continue;
    }
    if (isToolMessage(message)) {
      const toolCall = toolCallsById.get(message.tool_call_id);
      if (!toolCall) continue;
      normalized.push({
        role: "tool",
        content: messageText(message.content),
        toolResults: [{ ...toolCall, output: messageText(message.content) }],
        ...(message.id ? { id: message.id } : {}),
      });
      continue;
    }

    const role = message.getType();
    if (role === "human") {
      normalized.push({
        role: "user",
        content: messageText(message.content),
        ...(message.id ? { id: message.id } : {}),
      });
    } else if (role === "system") {
      normalized.push({
        role: "system",
        content: messageText(message.content),
        ...(message.id ? { id: message.id } : {}),
      });
    }
  }
  return normalized;
}

export function findFinalContent(messages: Message[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role === "assistant" && !message.toolCalls?.length)
      return message.content;
  }
  return "";
}

export function toToolCallRecord(value: unknown): ToolCallRecord {
  if (!isRecord(value)) throw new Error("Model returned an invalid tool call.");
  const toolCallId = value.id;
  const name = value.name;
  if (typeof toolCallId !== "string" || !toolCallId) {
    throw new Error("Model returned a tool call without an ID.");
  }
  if (typeof name !== "string" || !name) {
    throw new Error(`Model returned an unnamed tool call: ${toolCallId}`);
  }
  return {
    toolCallId,
    name,
    input: requireRecord(
      value.args ?? {},
      `Model returned invalid tool input: ${name}`,
    ),
  };
}

export function isStreamChunk(value: unknown): value is [string, unknown] {
  return (
    Array.isArray(value) && value.length === 2 && typeof value[0] === "string"
  );
}

export function readStepNumber(metadata: unknown): number | null {
  if (!isRecord(metadata) || typeof metadata.langgraph_step !== "number")
    return null;
  return metadata.langgraph_step;
}

function requireRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}
