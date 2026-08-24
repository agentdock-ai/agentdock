import type { ToolCallRecord } from "../types.js";

export type ToolPermissionMode = "normal" | "approve_all";

export interface ToolApprovalDecision {
  approvalId: string;
  approved: boolean;
  reason?: string;
}

export interface ToolApprovalRequest {
  approvalId: string;
  toolCall: ToolCallRecord;
}

export interface ToolApprovalResponse extends ToolApprovalDecision {
  toolCall: ToolCallRecord;
}
