import type { Message } from "../memory.js";
import { cloneValue } from "../storage/clone.js";

export interface AgentSessionRecord {
  sessionId: string;
  messages: Message[];
  latestRunId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSessionStore {
  get(sessionId: string): Promise<AgentSessionRecord | null> | AgentSessionRecord | null;
  save(record: AgentSessionRecord): Promise<void> | void;
  update(
    sessionId: string,
    update: Partial<AgentSessionRecord>,
  ): Promise<void> | void;
}

export class InMemoryAgentSessionStore implements AgentSessionStore {
  private readonly sessions = new Map<string, AgentSessionRecord>();

  get(sessionId: string): AgentSessionRecord | null {
    const record = this.sessions.get(sessionId);
    return record ? cloneValue(record) : null;
  }

  save(record: AgentSessionRecord): void {
    if (this.sessions.has(record.sessionId)) {
      throw new Error(`Agent session already exists: ${record.sessionId}`);
    }
    this.sessions.set(record.sessionId, cloneValue(record));
  }

  update(sessionId: string, update: Partial<AgentSessionRecord>): void {
    const current = this.sessions.get(sessionId);
    if (!current) throw new Error(`Agent session not found: ${sessionId}`);
    if (update.sessionId !== undefined && update.sessionId !== sessionId) {
      throw new Error(`Agent session identity is immutable: ${sessionId}`);
    }

    this.sessions.set(sessionId, cloneValue({
      ...current,
      ...update,
      updatedAt: Date.now(),
    }));
  }
}
