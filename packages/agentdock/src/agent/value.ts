import { Buffer } from "node:buffer";
import {
  cloneJsonValue,
  type ContentPart,
  type JsonValue,
} from "@agentdock/contracts";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Agent execution failed.";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function messageText(content: unknown): string {
  return messageContentParts(content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function messageContentParts(content: unknown): ContentPart[] {
  if (typeof content === "string")
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content))
    return [toCustomPart(content, "provider-content")];
  return content.flatMap((part) => normalizeContentPart(part));
}

function normalizeContentPart(value: unknown): ContentPart[] {
  if (typeof value === "string")
    return value.length > 0 ? [{ type: "text", text: value }] : [];
  if (!isRecord(value)) return [toCustomPart(value, "provider-content")];

  if (value.type === "text" && typeof value.text === "string")
    return [{ type: "text", text: value.text }];
  if (value.type === "reasoning") {
    const text =
      typeof value.reasoning === "string"
        ? value.reasoning
        : typeof value.text === "string"
          ? value.text
          : null;
    if (text !== null) return [{ type: "reasoning", text }];
  }
  if (value.type === "citation" && typeof value.url === "string") {
    return [
      {
        type: "citation",
        url: value.url,
        ...(typeof value.title === "string" ? { title: value.title } : {}),
      },
    ];
  }
  if (value.type === "image_url") {
    const imageUrl = isRecord(value.image_url)
      ? value.image_url.url
      : value.image_url;
    if (typeof imageUrl === "string") return [{ type: "image", url: imageUrl }];
  }
  if (
    value.type === "image" ||
    value.type === "audio" ||
    value.type === "video" ||
    value.type === "file"
  ) {
    const media = normalizeMediaPart(value);
    if (media) return [media];
  }
  if (
    value.type === "tool_call" ||
    value.type === "tool_call_chunk" ||
    value.type === "invalid_tool_call"
  ) {
    return [];
  }

  const name = typeof value.type === "string" ? value.type : "provider-content";
  return [toCustomPart(value, name)];
}

function normalizeMediaPart(
  value: Record<string, unknown>,
): ContentPart | null {
  const type = value.type as "image" | "audio" | "video" | "file";
  const mimeType =
    typeof value.mimeType === "string"
      ? value.mimeType
      : typeof value.mime_type === "string"
        ? value.mime_type
        : undefined;
  const source =
    typeof value.url === "string"
      ? { url: value.url }
      : typeof value.data === "string"
        ? { data: value.data }
        : value.data instanceof Uint8Array
          ? { data: Buffer.from(value.data).toString("base64") }
          : typeof value.fileId === "string"
            ? { fileId: value.fileId }
            : typeof value.id === "string"
              ? { fileId: value.id }
              : null;
  if (!source) return null;
  return {
    type,
    ...source,
    ...(mimeType ? { mimeType } : {}),
    ...(type === "file" && typeof value.name === "string"
      ? { name: value.name }
      : {}),
  };
}

function toCustomPart(value: unknown, name: string): ContentPart {
  return {
    type: "custom",
    name,
    data: cloneJsonValue(value, "Message content") as JsonValue,
  };
}
