import type { JsonValue } from "@agentdock-ai/contracts";
import { isRecord } from "../utils/is-record.js";

export function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

export function toJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") {
    throw new Error("Response data is not JSON-safe.");
  }
  if (ancestors.has(value)) throw new Error("Response data is circular.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => toJsonValue(item, ancestors));
    }
    const toJSON = "toJSON" in value ? value.toJSON : undefined;
    if (typeof toJSON === "function") {
      return toJsonValue(toJSON.call(value), ancestors);
    }
    if (!isRecord(value)) throw new Error("Response data is not JSON-safe.");
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = toJsonValue(item, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
