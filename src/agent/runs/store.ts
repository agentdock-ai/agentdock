import type { Message } from "../memory.js";
import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../permissions/types.js";
import { cloneValue } from "../storage/clone.js";

export type AgentRunStatus =
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRunRecord {
  runId: string;
  sessionId: string;
  status: AgentRunStatus;
  messages: Message[];
  pendingApprovals: ToolApprovalRequest[];
  stepsCompleted: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface AgentRunApprovalClaim {
  record: AgentRunRecord;
  approvals: ToolApprovalRequest[];
}

export interface AgentRunStore {
  get(runId: string): Promise<AgentRunRecord | null> | AgentRunRecord | null;
  save(record: AgentRunRecord): Promise<void> | void;
  update(
    runId: string,
    update: Partial<AgentRunRecord>,
  ): Promise<void> | void;
  /**
   * Atomically applies an update only when the run is currently in one of the
   * expected statuses.
   */
  transition(
    runId: string,
    expectedStatus: AgentRunStatus | AgentRunStatus[],
    update: Partial<AgentRunRecord>,
  ): Promise<boolean> | boolean;
  /**
   * Atomically claims the complete set of pending approvals for a run.
   * Returns null when the run is missing, no longer waits for approval, or the
   * supplied approval IDs do not match exactly.
   */
  claimApprovals(
    runId: string,
    decisions: ToolApprovalDecision[],
  ): Promise<AgentRunApprovalClaim | null> | AgentRunApprovalClaim | null;
}

export class InMemoryAgentRunStore implements AgentRunStore {
  private readonly runs = new Map<string, AgentRunRecord>();

  get(runId: string): AgentRunRecord | null {
    const record = this.runs.get(runId);
    return record ? cloneValue(record) : null;
  }

  save(record: AgentRunRecord): void {
    if (this.runs.has(record.runId)) {
      throw new Error(`Agent run already exists: ${record.runId}`);
    }
    this.runs.set(record.runId, cloneValue(record));
  }

  update(runId: string, update: Partial<AgentRunRecord>): void {
    const current = this.runs.get(runId);
    if (!current) throw new Error(`Agent run not found: ${runId}`);
    if (
      (update.runId !== undefined && update.runId !== runId) ||
      (update.sessionId !== undefined && update.sessionId !== current.sessionId)
    ) {
      throw new Error(`Agent run identity is immutable: ${runId}`);
    }
    this.runs.set(runId, cloneValue({
      ...current,
      ...update,
      updatedAt: Date.now(),
    }));
  }

  transition(
    runId: string,
    expectedStatus: AgentRunStatus | AgentRunStatus[],
    update: Partial<AgentRunRecord>,
  ): boolean {
    const current = this.runs.get(runId);
    if (!current) return false;
    if (
      (update.runId !== undefined && update.runId !== runId) ||
      (update.sessionId !== undefined && update.sessionId !== current.sessionId)
    ) {
      return false;
    }

    const expected = Array.isArray(expectedStatus)
      ? expectedStatus
      : [expectedStatus];
    if (!expected.includes(current.status)) return false;

    this.runs.set(runId, cloneValue({
      ...current,
      ...update,
      updatedAt: Date.now(),
    }));
    return true;
  }

  claimApprovals(
    runId: string,
    decisions: ToolApprovalDecision[],
  ): AgentRunApprovalClaim | null {
    const current = this.runs.get(runId);

    if (
      !current ||
      current.status !== "waiting_for_approval" ||
      !decisions.every(
        (decision) =>
          typeof decision.approvalId === "string" &&
          typeof decision.approved === "boolean",
      ) ||
      !hasExactApprovalSet(current.pendingApprovals, decisions)
    ) {
      return null;
    }

    const approvals = cloneValue(current.pendingApprovals);
    const claimedRecord = cloneValue<AgentRunRecord>({
      ...current,
      status: "running",
      pendingApprovals: [],
      updatedAt: Date.now(),
    });

    this.runs.set(runId, claimedRecord);

    return { record: claimedRecord, approvals };
  }
}

function hasExactApprovalSet(
  pendingApprovals: ToolApprovalRequest[],
  decisions: ToolApprovalDecision[],
): boolean {
  if (pendingApprovals.length === 0 || pendingApprovals.length !== decisions.length) {
    return false;
  }

  const decisionIds = new Set(decisions.map((decision) => decision.approvalId));
  if (decisionIds.size !== decisions.length) return false;

  return pendingApprovals.every((request) => decisionIds.has(request.approvalId));
}
