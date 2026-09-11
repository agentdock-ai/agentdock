import {
  isAIMessage,
  isBaseMessage,
  isToolMessage,
  type BaseMessage,
  type ToolMessage,
} from "@langchain/core/messages";
import {
  cloneJsonObject,
  cloneJsonValue,
  type ContentPart,
  type JsonObject,
  type JsonValue,
} from "@agentdock-ai/contracts";
import type { Message } from "../../memory.js";
import type {
  ToolCallRecord,
  ToolErrorRecord,
  ToolResultRecord,
} from "../../types.js";
import { isRecord, messageContentParts, messageText } from "../../value.js";

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
    if (isAIMessage(message)) {
      for (const rawToolCall of message.tool_calls ?? []) {
        addToolCall(calls, toToolCallRecord(rawToolCall));
      }
      continue;
    }
    if (isToolMessage(message)) {
      const toolCall = readToolMessageToolCall(message);
      if (toolCall) addToolCall(calls, toolCall);
    }
  }
  return [...calls.values()];
}

export function collectLatestToolCalls(
  messages: BaseMessage[],
): ToolCallRecord[] {
  for (const message of [...messages].reverse()) {
    if (!isAIMessage(message) || (message.tool_calls?.length ?? 0) === 0)
      continue;
    return (message.tool_calls ?? []).map(toToolCallRecord);
  }
  return [];
}

export function collectToolResults(messages: Message[]): {
  results: ToolResultRecord[];
  errors: ToolErrorRecord[];
} {
  const results = new Map<string, ToolResultRecord>();
  const errors = new Map<string, ToolErrorRecord>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const result of message.content.flatMap((part) =>
      part.type === "tool-result" ? [part.result] : [],
    )) {
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

export function collectToolRecordsFromMessages(
  messages: BaseMessage[],
): PersistedToolRecord[] {
  const records = new Map<string, PersistedToolRecord>();
  for (const message of messages) {
    if (!isToolMessage(message)) continue;
    const toolCall = readToolMessageToolCall(message);
    if (!toolCall) continue;
    const error = readToolMessageError(message, toolCall);
    const result: ToolResultRecord = {
      ...toolCall,
      output: readToolMessageOutput(
        message.artifact === undefined ? message.content : message.artifact,
      ),
      ...(error || message.status === "error" ? { isError: true } : {}),
    };
    records.set(toolCall.toolCallId, {
      toolCall,
      result,
      ...(error ? { error } : {}),
    });
  }
  return [...records.values()];
}

export function stateHasInterrupt(
  state: unknown,
  resolvedInterruptIds: ReadonlySet<string> = new Set(),
): boolean {
  if (!isRecord(state) || !Array.isArray(state.tasks)) return false;
  return state.tasks.some(
    (task) =>
      isRecord(task) &&
      Array.isArray(task.interrupts) &&
      hasUnresolvedInterrupt(task.interrupts, resolvedInterruptIds),
  );
}

function hasUnresolvedInterrupt(
  interrupts: unknown[],
  resolvedInterruptIds: ReadonlySet<string>,
): boolean {
  return interrupts.some((interrupt) => {
    if (Array.isArray(interrupt))
      return hasUnresolvedInterrupt(interrupt, resolvedInterruptIds);
    return (
      !isRecord(interrupt) ||
      typeof interrupt.id !== "string" ||
      !resolvedInterruptIds.has(interrupt.id)
    );
  });
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
        content: [
          ...messageContentParts(message.content),
          ...toolCalls.map((toolCall): ContentPart => ({
            type: "tool-call",
            toolCall,
          })),
        ],
        ...(message.id ? { id: message.id } : {}),
      });
      continue;
    }
    if (isToolMessage(message)) {
      const toolCall =
        toolCallsById.get(message.tool_call_id) ??
        readToolMessageToolCall(message);
      if (!toolCall) {
        throw new Error(
          `Tool message references an unknown tool call: ${message.tool_call_id}`,
        );
      }
      const record = toolRecords.get(message.tool_call_id);
      const messageContent = messageText(message.content);
      const messageOutput = readToolMessageOutput(
        message.artifact === undefined ? message.content : message.artifact,
      );
      const messageIsError =
        message.status === "error" ||
        messageContent.startsWith("Error invoking tool");
      if (record?.error) {
        const result: ToolResultRecord = {
          toolCallId: record.error.toolCallId,
          name: record.error.name,
          input: record.error.input,
          output: record.result?.output ?? messageOutput,
          isError: true,
        };
        normalized.push({
          role: "tool",
          content: [{ type: "tool-result", result }],
          ...(message.id ? { id: message.id } : {}),
        });
        continue;
      }
      const result: ToolResultRecord = record?.result ?? {
        ...toolCall,
        output: messageOutput,
        ...(messageIsError ? { isError: true } : {}),
      };
      normalized.push({
        role: "tool",
        content: [{ type: "tool-result", result }],
        ...(message.id ? { id: message.id } : {}),
      });
      continue;
    }

    const role = message.getType();
    if (role === "human") {
      normalized.push({
        role: "user",
        content: messageContentParts(message.content),
        ...(message.id ? { id: message.id } : {}),
      });
    } else if (role === "system") {
      normalized.push({
        role: "system",
        content: messageContentParts(message.content),
        ...(message.id ? { id: message.id } : {}),
      });
    }
  }
  return normalized;
}

function readToolMessageOutput(content: unknown): JsonValue {
  try {
    return cloneJsonValue(content, "Tool message output");
  } catch {
    return messageText(content);
  }
}

function readToolMessageToolCall(message: ToolMessage): ToolCallRecord | null {
  const metadata = isRecord(message.additional_kwargs)
    ? message.additional_kwargs.agentdockToolCall
    : undefined;
  if (!isRecord(metadata)) return null;
  try {
    return {
      toolCallId: message.tool_call_id,
      name:
        typeof metadata.name === "string"
          ? metadata.name
          : (message.name ?? ""),
      input: cloneJsonObject(metadata.args ?? {}, "Tool message input"),
    };
  } catch {
    return null;
  }
}

function readToolMessageError(
  message: ToolMessage,
  toolCall: ToolCallRecord,
): ToolErrorRecord | null {
  const metadata = isRecord(message.additional_kwargs)
    ? message.additional_kwargs.agentdockToolError
    : undefined;
  if (metadata === undefined) return null;
  if (
    !isRecord(metadata) ||
    typeof metadata.error !== "string" ||
    (metadata.code !== undefined && typeof metadata.code !== "string")
  ) {
    throw new Error(
      `Tool message contains invalid AgentDock error metadata: ${toolCall.toolCallId}`,
    );
  }
  return {
    ...toolCall,
    error: metadata.error,
    ...(typeof metadata.code === "string" ? { code: metadata.code } : {}),
  };
}

function addToolCall(
  calls: Map<string, ToolCallRecord>,
  toolCall: ToolCallRecord,
): void {
  const existing = calls.get(toolCall.toolCallId);
  if (
    existing &&
    (existing.name !== toolCall.name ||
      JSON.stringify(existing.input) !== JSON.stringify(toolCall.input))
  ) {
    throw codedError(
      "tool_call_conflict",
      `Model returned conflicting finalized tool calls for ID: ${toolCall.toolCallId}`,
    );
  }
  calls.set(toolCall.toolCallId, toolCall);
}

export function findFinalContent(messages: Message[]): ContentPart[] {
  for (const message of [...messages].reverse()) {
    if (
      message.role === "assistant" &&
      !message.content.some((part) => part.type === "tool-call")
    )
      return message.content;
  }
  return [];
}

export function toToolCallRecord(value: unknown): ToolCallRecord {
  if (!isRecord(value))
    throw codedError(
      "tool_call_invalid",
      "Model returned an invalid tool call.",
    );
  const toolCallId = value.id;
  const name = value.name;
  if (typeof toolCallId !== "string" || !toolCallId) {
    throw codedError(
      "tool_call_invalid",
      "Model returned a tool call without an ID.",
    );
  }
  if (typeof name !== "string" || !name) {
    throw codedError(
      "tool_call_invalid",
      `Model returned an unnamed tool call: ${toolCallId}`,
    );
  }
  return {
    toolCallId,
    name,
    input: requireRecord(
      value.args ?? {},
      `Model returned invalid tool input: ${name}`,
      "tool_input_invalid",
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
  code: string,
): JsonObject {
  try {
    return cloneJsonObject(value, message);
  } catch (error) {
    throw codedError(
      code,
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
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
