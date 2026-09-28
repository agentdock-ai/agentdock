import type { JsonObject, JsonValue } from "./json.js";

export interface ToolCallRecord {
  toolCallId: string;
  name: string;
  input: JsonObject;
}

export interface ToolErrorRecord extends ToolCallRecord {
  error: string;
  code?: string;
}

export interface ToolResultRecord extends ToolCallRecord {
  output: JsonValue;
  isError?: boolean;
}
