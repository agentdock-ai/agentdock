import type { ToolCallRecord } from "../types.js";

export type ToolPermissionMode = "normal" | "approve_all";

export interface ToolApprovalRequest {
  approvalId: string;
  toolCall: ToolCallRecord;
}

export interface ToolApprovalResponse {
  approvalId: string;
  toolCall: ToolCallRecord;
  approved: boolean;
  reason?: string;
}
