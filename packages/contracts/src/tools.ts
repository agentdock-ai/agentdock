import type { JsonObject, JsonSchema, JsonValue } from "./json.js";

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
  requiresApproval: boolean;
}

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
