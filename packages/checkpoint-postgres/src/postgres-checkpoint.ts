import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { CheckpointAdapter } from "@agentdock/checkpoint";

export interface PostgresCheckpointOptions {
  readonly connectionString: string;
  readonly schema?: string;
}

/** AgentDock lifecycle adapter for LangGraph's PostgreSQL saver. */
export class PostgresCheckpoint implements CheckpointAdapter {
  readonly saver: PostgresSaver;
  private initialized = false;
  private closed = false;
  private initialization: Promise<void> | undefined;

  constructor(options: PostgresCheckpointOptions) {
    assertNonEmptyString(options?.connectionString, "connectionString");
    if (options.schema !== undefined)
      assertNonEmptyString(options.schema, "schema");
    this.saver = PostgresSaver.fromConnString(options.connectionString, {
      ...(options.schema ? { schema: options.schema } : {}),
    });
  }

  initialize(): Promise<void> {
    if (this.closed) throw new Error("PostgresCheckpoint is already closed.");
    if (this.initialized) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.initialization = this.saver.setup().then(
      () => {
        this.initialized = true;
      },
      (error: unknown) => {
        this.initialization = undefined;
        throw withCause("Failed to initialize PostgreSQL checkpoints.", error);
      },
    );
    return this.initialization;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.initialization?.catch(() => undefined);
    await this.saver.end();
  }
}

function withCause(message: string, cause: unknown): Error {
  return Object.assign(new Error(message), { cause });
}

function assertNonEmptyString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`PostgresCheckpoint ${name} must be a non-empty string.`);
  }
}
