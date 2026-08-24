import type { Message } from "../memory.js";
import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../permissions/types.js";

export type AgentRunStatus =
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRunRecord {
  runId: string;
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
    return record ? cloneRecord(record) : null;
  }

  save(record: AgentRunRecord): void {
    this.runs.set(record.runId, cloneRecord(record));
  }

  update(runId: string, update: Partial<AgentRunRecord>): void {
    const current = this.runs.get(runId);
    if (!current) throw new Error(`Agent run not found: ${runId}`);
    this.runs.set(runId, cloneRecord({
      ...current,
      ...update,
      updatedAt: Date.now(),
    }));
  }

  claimApprovals(
    runId: string,
    decisions: ToolApprovalDecision[],
  ): AgentRunApprovalClaim | null {
    const current = this.runs.get(runId);

    if (
      !current ||
      current.status !== "waiting_for_approval" ||
      !hasExactApprovalSet(current.pendingApprovals, decisions)
    ) {
      return null;
    }

    const approvals = structuredClone(current.pendingApprovals);
    const claimedRecord = cloneRecord({
      ...current,
      status: "running",
      pendingApprovals: [],
      updatedAt: Date.now(),
    });

    this.runs.set(runId, claimedRecord);

    return { record: claimedRecord, approvals };
  }
}

function cloneRecord(record: AgentRunRecord): AgentRunRecord {
  return structuredClone(record);
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
