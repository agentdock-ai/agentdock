import type { Message } from "../memory.js";
import type { ToolApprovalRequest } from "../permissions/types.js";

export type AgentRunStatus =
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRunRecord {
  runId: string;
  userId: string;
  organizationId: string;
  status: AgentRunStatus;
  messages: Message[];
  pendingApprovals: ToolApprovalRequest[];
  stepsCompleted: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface AgentRunStore {
  get(runId: string): Promise<AgentRunRecord | null> | AgentRunRecord | null;
  save(record: AgentRunRecord): Promise<void> | void;
  update(
    runId: string,
    update: Partial<AgentRunRecord>,
  ): Promise<void> | void;
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
}

export const defaultAgentRunStore = new InMemoryAgentRunStore();

function cloneRecord(record: AgentRunRecord): AgentRunRecord {
  return structuredClone(record);
}
