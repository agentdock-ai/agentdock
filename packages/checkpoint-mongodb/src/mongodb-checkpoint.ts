import { MongoClient } from "mongodb";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import type { CheckpointAdapter } from "@agentdock/checkpoint";

export interface MongoDBCheckpointOptions {
  readonly connectionString: string;
  readonly database?: string;
  readonly collection?: string;
  readonly writesCollection?: string;
}

/** AgentDock lifecycle adapter for LangGraph's MongoDB saver. */
export class MongoDBCheckpoint implements CheckpointAdapter {
  readonly saver: MongoDBSaver;
  private readonly client: MongoClient;
  private initialized = false;
  private closed = false;
  private initialization: Promise<void> | undefined;

  constructor(options: MongoDBCheckpointOptions) {
    assertNonEmptyString(options?.connectionString, "connectionString");
    for (const [name, value] of [
      ["database", options.database],
      ["collection", options.collection],
      ["writesCollection", options.writesCollection],
    ] as const) {
      if (value !== undefined) assertNonEmptyString(value, name);
    }
    if (
      options.collection !== undefined &&
      options.collection === options.writesCollection
    ) {
      throw new Error(
        "MongoDBCheckpoint collection and writesCollection must be different.",
      );
    }
    this.client = new MongoClient(options.connectionString);
    this.saver = new MongoDBSaver({
      client: this.client,
      ...(options.database ? { dbName: options.database } : {}),
      ...(options.collection
        ? { checkpointCollectionName: options.collection }
        : {}),
      ...(options.writesCollection
        ? { checkpointWritesCollectionName: options.writesCollection }
        : {}),
    });
  }

  initialize(): Promise<void> {
    if (this.closed) throw new Error("MongoDBCheckpoint is already closed.");
    if (this.initialized) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.initialization = this.setup().then(
      () => {
        this.initialized = true;
      },
      (error: unknown) => {
        this.initialization = undefined;
        throw withCause("Failed to initialize MongoDB checkpoints.", error);
      },
    );
    return this.initialization;
  }

  private async setup(): Promise<void> {
    await this.client.connect();
    const errors = await this.saver.setup();
    if (errors.length > 0) throw new Error(errors.map(String).join("; "));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.initialization?.catch(() => undefined);
    await this.client.close();
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
    throw new Error(`MongoDBCheckpoint ${name} must be a non-empty string.`);
  }
}
