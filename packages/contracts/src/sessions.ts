import type { Message } from "./messages.js";

export interface AgentSessionRecord {
  sessionId: string;
  messages: Message[];
}

export interface AgentSessionHistoryEntry {
  checkpointId: string;
  timestamp: string;
  runId?: string;
  messages: Message[];
}

export interface AgentSessionHistory {
  sessionId: string;
  current: AgentSessionRecord | null;
  checkpoints: AgentSessionHistoryEntry[];
}
