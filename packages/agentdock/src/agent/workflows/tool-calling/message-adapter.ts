import {
  isAIMessage,
  isBaseMessage,
  isToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { cloneJsonObject, type JsonObject } from "@agentdock/contracts";
import type { Message } from "../../memory.js";
import type {
  ToolCallRecord,
  ToolErrorRecord,
  ToolResultRecord,
} from "../../types.js";
import { isRecord, messageText } from "../../value.js";

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

export interface PersistedToolRecord {
  toolCall: ToolCallRecord;
  result?: ToolResultRecord;
  error?: ToolErrorRecord;
}

export function readStateToolRecords(state: unknown): PersistedToolRecord[] {
  if (!isRecord(state) || !isRecord(state.values)) return [];
  const records = state.values.agentdockToolRecords;
  if (!Array.isArray(records)) return [];
  return records.filter(isPersistedToolRecord);
}

export function collectToolCalls(messages: BaseMessage[]): ToolCallRecord[] {
  const calls = new Map<string, ToolCallRecord>();
  for (const message of messages) {
    if (!isAIMessage(message)) continue;
    for (const rawToolCall of message.tool_calls ?? []) {
      const toolCall = toToolCallRecord(rawToolCall);
      calls.set(toolCall.toolCallId, toolCall);
    }
  }
  return [...calls.values()];
}

export function collectToolResults(messages: Message[]): {
  results: ToolResultRecord[];
  errors: ToolErrorRecord[];
} {
  const results = new Map<string, ToolResultRecord>();
  const errors = new Map<string, ToolErrorRecord>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const result of message.toolResults) {
      results.set(result.toolCallId, result);
      if (result.isError) {
        const validationFailure =
          typeof result.output === "string" &&
          result.output.includes(
            "Received tool input did not match expected schema",
          );
        errors.set(result.toolCallId, {
          toolCallId: result.toolCallId,
          name: result.name,
          input: result.input,
          error: validationFailure
            ? "Tool input failed validation."
            : typeof result.output === "string"
              ? result.output
              : "Tool execution failed.",
          code: validationFailure
            ? "tool_input_invalid"
            : "tool_execution_failed",
        });
      }
    }
  }
  return { results: [...results.values()], errors: [...errors.values()] };
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
  toolRecords: Map<string, PersistedToolRecord> = new Map(),
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
      const record = toolRecords.get(message.tool_call_id);
      const messageContent = messageText(message.content);
      const messageIsError =
        message.status === "error" ||
        messageContent.startsWith("Error invoking tool");
      if (record?.error) {
        normalized.push({
          role: "tool",
          content: messageContent,
          toolResults: [
            {
              ...record.error,
              output: record.result?.output ?? messageContent,
              isError: true,
            },
          ],
          ...(message.id ? { id: message.id } : {}),
        });
        continue;
      }
      normalized.push({
        role: "tool",
        content: messageContent,
        toolResults: [
          record?.result ?? {
            ...toolCall,
            output: messageContent,
            ...(messageIsError ? { isError: true } : {}),
          },
        ],
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

function requireRecord(value: unknown, message: string): JsonObject {
  try {
    return cloneJsonObject(value, message);
  } catch (error) {
    throw new Error(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isPersistedToolRecord(value: unknown): value is PersistedToolRecord {
  if (!isRecord(value) || !isRecord(value.toolCall)) return false;
  const toolCall = value.toolCall;
  return (
    typeof toolCall.toolCallId === "string" &&
    typeof toolCall.name === "string" &&
    isRecord(toolCall.input)
  );
}
