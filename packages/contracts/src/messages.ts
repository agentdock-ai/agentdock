import type { ToolCallRecord, ToolResultRecord } from "./tools.js";

export type Message =
  | {
      role: "user";
      content: string;
      id?: string;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCallRecord[];
      id?: string;
    }
  | {
      role: "tool";
      content: string;
      toolResults: ToolResultRecord[];
      id?: string;
    }
  | {
      role: "system";
      content: string;
      id?: string;
    };
