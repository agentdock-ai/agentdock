import type { Message } from "./messages.js";
import type { AgentRunResult } from "./runs.js";

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

/** Options for reading the durable normalized run timeline of a session. */
export interface AgentSessionRunHistoryOptions {
  /** Maximum number of logical runs to return. */
  limit?: number;
  /** Opaque cursor returned by a previous page. */
  cursor?: string;
}

/** One durable normalized snapshot for a logical run. */
export interface AgentSessionRunHistoryEntry extends AgentRunResult {
  /** Checkpoint containing the latest snapshot for this run. */
  checkpointId: string;
  /** Timestamp of the checkpoint containing the latest snapshot. */
  checkpointTimestamp: string;
  /** Timestamp of the earliest checkpoint observed for this run. */
  startedAt?: string;
  /** Timestamp of the terminal snapshot, when the run is terminal. */
  completedAt?: string;
}

export interface AgentSessionRunHistory {
  sessionId: string;
  /** Runs are ordered from oldest to newest by their checkpoint timestamps. */
  runs: AgentSessionRunHistoryEntry[];
  nextCursor?: string;
}
