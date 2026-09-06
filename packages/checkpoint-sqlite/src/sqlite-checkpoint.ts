import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { CheckpointAdapter } from "@agentdock/checkpoint";

export interface SqliteCheckpointOptions {
  readonly path: string;
}

/** AgentDock lifecycle adapter for LangGraph's SQLite saver. */
export class SqliteCheckpoint implements CheckpointAdapter {
  readonly saver: SqliteSaver;
  private closed = false;

  constructor(options: SqliteCheckpointOptions) {
    if (typeof options?.path !== "string" || options.path.trim().length === 0) {
      throw new Error("SqliteCheckpoint path must be a non-empty string.");
    }
    this.saver = SqliteSaver.fromConnString(options.path);
  }

  initialize(): Promise<void> {
    if (this.closed) throw new Error("SqliteCheckpoint is already closed.");
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.saver.db.close();
    return Promise.resolve();
  }
}
