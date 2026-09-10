import {
  RedisSaver,
  type TTLConfig,
} from "@langchain/langgraph-checkpoint-redis";
import type { CheckpointAdapter } from "@agentdock/checkpoint";
import { createClient } from "redis";

export interface RedisCheckpointOptions {
  readonly url: string;
  readonly ttl?: TTLConfig;
}

/** AgentDock lifecycle adapter for LangGraph's Redis saver. */
export class RedisCheckpoint implements CheckpointAdapter {
  readonly saver: RedisSaver;
  private readonly client: ReturnType<typeof createClient>;
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private closed = false;

  constructor(options: RedisCheckpointOptions) {
    if (typeof options?.url !== "string" || options.url.trim().length === 0) {
      throw new Error("RedisCheckpoint url must be a non-empty string.");
    }
    if (
      options.ttl?.defaultTTL !== undefined &&
      (!Number.isFinite(options.ttl.defaultTTL) || options.ttl.defaultTTL <= 0)
    ) {
      throw new Error("RedisCheckpoint ttl.defaultTTL must be positive.");
    }
    if (
      options.ttl?.refreshOnRead !== undefined &&
      typeof options.ttl.refreshOnRead !== "boolean"
    ) {
      throw new Error("RedisCheckpoint ttl.refreshOnRead must be a boolean.");
    }

    this.client = createClient({ url: options.url });
    this.saver = new RedisSaver(this.client, options.ttl);
  }

  initialize(): Promise<void> {
    if (this.closed) throw new Error("RedisCheckpoint is already closed.");
    if (this.initialized) return Promise.resolve();
    if (this.initialization) return this.initialization;

    this.initialization = this.client.connect().then(
      () => {
        this.initialized = true;
      },
      (error: unknown) => {
        this.initialization = undefined;
        throw withCause("Failed to initialize Redis checkpoints.", error);
      },
    );
    return this.initialization;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.initialization?.catch(() => undefined);
    if (this.client.isOpen) await this.saver.end();
  }
}

function withCause(message: string, cause: unknown): Error {
  return Object.assign(new Error(message), { cause });
}
