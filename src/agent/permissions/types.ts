import type { AgentContext, Tool, ToolCallRecord } from "../types.js";

export type ToolPermissionMode = "normal" | "approve_all";

export type ToolPermissionDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string }
  | { type: "approval_required" };

export interface ToolPermissionPolicy {
  check(input: {
    tool: Tool;
    toolCall: ToolCallRecord;
    ctx: AgentContext;
  }): Promise<ToolPermissionDecision> | ToolPermissionDecision;
}

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
