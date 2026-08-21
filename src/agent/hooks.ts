import type { ToolCallRecord } from "./types.js";

export interface AgentHooks {
  onStepStart?(step: number): void;
  onStepFinish?(step: number, text: string, toolCalls: ToolCallRecord[]): void;
  onToolCall?(tool: {
    toolCallId: string;
    name: string;
    input: unknown;
  }): Promise<void> | void;
  onToolResult?(result: {
    toolCallId: string;
    name: string;
    input: unknown;
    result: unknown;
    error?: string;
  }): void;
}
