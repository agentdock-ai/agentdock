import type { ToolCallRecord } from "./tools.js";

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
