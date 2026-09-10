import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { CheckpointAdapter } from "@agentdock/checkpoint";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SqliteCheckpointOptions {
  readonly path: string;
}

/**
 * Exposes LangGraph's protected schema setup to the lifecycle adapter.
 * LangGraph remains the owner of the schema and its migrations.
 */
class AgentDockSqliteSaver extends SqliteSaver {
  initializeSchema(): void {
    this.setup();
  }
}

/** AgentDock lifecycle adapter for LangGraph's SQLite saver. */
export class SqliteCheckpoint implements CheckpointAdapter {
  readonly saver: SqliteSaver;
  private readonly sqliteSaver: AgentDockSqliteSaver;
  private closed = false;

  constructor(options: SqliteCheckpointOptions) {
    if (typeof options?.path !== "string" || options.path.trim().length === 0) {
      throw new Error("SqliteCheckpoint path must be a non-empty string.");
    }
    // better-sqlite3 creates the database file, but not missing parent
    // directories. Keep this adapter usable on a fresh single-machine
    // deployment while leaving schema ownership with LangGraph.
    mkdirSync(dirname(options.path), { recursive: true });
    this.sqliteSaver = new AgentDockSqliteSaver(new Database(options.path));
    this.saver = this.sqliteSaver;
  }

  initialize(): Promise<void> {
    if (this.closed) throw new Error("SqliteCheckpoint is already closed.");
    this.sqliteSaver.initializeSchema();
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.sqliteSaver.db.close();
    return Promise.resolve();
  }
}
