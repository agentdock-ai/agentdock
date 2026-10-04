import { isCommand } from "@langchain/langgraph";
import { isToolMessage } from "@langchain/core/messages";
import {
  cloneContentParts,
  cloneJsonObject,
  cloneJsonValue,
  type AgentUsage,
  type ContentPart,
  type JsonObject,
  type JsonValue,
} from "@agentdock-ai/contracts";
import { isRecord } from "../utils/is-record.js";

export function toProgressContent(value: unknown): ContentPart[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return [
    { type: "custom", name: "tool-progress", data: cloneJsonValue(value) },
  ];
}

export function toToolOutput(
  value: unknown,
  toolCallId: string,
): { output: JsonValue; isError?: boolean } {
  if (isCommand(value)) {
    const update: unknown = value.update;
    let messages: unknown[] = [];
    if (isRecord(update) && Array.isArray(update.messages))
      messages = update.messages;
    else if (Array.isArray(update)) {
      for (const entry of update) {
        if (
          Array.isArray(entry) &&
          entry[0] === "messages" &&
          Array.isArray(entry[1])
        )
          messages.push(...entry[1]);
      }
    }
    value =
      messages.find(
        (message) =>
          isToolMessage(message) && message.tool_call_id === toolCallId,
      ) ?? null;
  }
  const output = isRecord(value) && "content" in value ? value.content : value;
  return {
    output: cloneJsonValue(output, "Tool output"),
    ...(isToolMessage(value) && value.status === "error"
      ? { isError: true }
      : {}),
  };
}

export function toContentParts(value: unknown): ContentPart[] {
  if (typeof value === "string")
    return value ? [{ type: "text", text: value }] : [];
  if (!Array.isArray(value)) {
    return value == null
      ? []
      : [
          {
            type: "custom",
            name: "model-content",
            data: cloneJsonValue(value),
          },
        ];
  }
  return value.flatMap((item): ContentPart[] => {
    if (!isRecord(item)) {
      return [
        { type: "custom", name: "model-content", data: cloneJsonValue(item) },
      ];
    }
    if (item.type === "text" && typeof item.text === "string") {
      return [{ type: "text", text: item.text }];
    }
    if (
      (item.type === "reasoning" || item.type === "thinking") &&
      (typeof item.text === "string" ||
        typeof item.reasoning === "string" ||
        typeof item.thinking === "string")
    ) {
      let text = String(item.thinking);
      if (typeof item.text === "string") text = item.text;
      else if (typeof item.reasoning === "string") text = item.reasoning;
      return [{ type: "reasoning", text }];
    }
    if (
      item.type === "image" ||
      item.type === "audio" ||
      item.type === "video" ||
      item.type === "file"
    ) {
      const media: Record<string, unknown> = { type: item.type };
      if (typeof item.url === "string") media.url = item.url;
      else if (typeof item.data === "string") media.data = item.data;
      else if (typeof item.base64 === "string") media.data = item.base64;
      else if (typeof item.fileId === "string") media.fileId = item.fileId;
      else if (typeof item.file_id === "string") media.fileId = item.file_id;
      else
        return [
          { type: "custom", name: "model-content", data: cloneJsonValue(item) },
        ];
      const mimeType = item.mimeType ?? item.mime_type;
      if (typeof mimeType === "string") media.mimeType = mimeType;
      const name = item.name ?? item.filename;
      if (item.type === "file" && typeof name === "string") media.name = name;
      return cloneContentParts([media], "Model content");
    }
    return [
      { type: "custom", name: "model-content", data: cloneJsonValue(item) },
    ];
  });
}

export function toJsonObject(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (typeof value === "string") {
    try {
      return cloneJsonObject(JSON.parse(value), "Tool input");
    } catch {
      throw new Error(
        "LangGraph emitted tool input that is not a JSON object.",
      );
    }
  }
  return cloneJsonObject(value, "Tool input");
}

export function toUsage(value: unknown): AgentUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: AgentUsage = {};
  if (typeof value.input_tokens === "number")
    usage.inputTokens = value.input_tokens;
  if (typeof value.output_tokens === "number")
    usage.outputTokens = value.output_tokens;
  if (typeof value.total_tokens === "number")
    usage.totalTokens = value.total_tokens;
  if (
    isRecord(value.output_token_details) &&
    typeof value.output_token_details.reasoning === "number"
  )
    usage.reasoningTokens = value.output_token_details.reasoning;
  if (
    isRecord(value.input_token_details) &&
    typeof value.input_token_details.cache_read === "number"
  )
    usage.cachedInputTokens = value.input_token_details.cache_read;
  return Object.keys(usage).length > 0 ? usage : undefined;
}
