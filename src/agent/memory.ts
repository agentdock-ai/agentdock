import type { ToolCallRecord, ToolResultRecord } from "./types.js";
import type { ToolApprovalRequest, ToolApprovalResponse } from "./permissions/types.js";

export type Message =
  | { role: "user"; content: string; id?: string; active?: boolean; compacted?: boolean }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCallRecord[];
      approvalRequests?: ToolApprovalRequest[];
      id?: string;
      active?: boolean;
      compacted?: boolean;
    }
  | {
      role: "tool";
      content: string;
      toolResults: ToolResultRecord[];
      approvalResponses?: ToolApprovalResponse[];
      id?: string;
      active?: boolean;
      compacted?: boolean;
    }
  | { role: "system"; content: string; id?: string; active?: boolean; compacted?: boolean };
