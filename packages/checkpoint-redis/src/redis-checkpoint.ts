import {
  RedisSaver,
  type TTLConfig,
} from "@langchain/langgraph-checkpoint-redis";
import { createClient, type RedisClientType } from "redis";
import type { CheckpointAdapter } from "@agentdock/checkpoint";

export interface RedisCheckpointOptions {
  readonly url: string;
  readonly ttl?: TTLConfig;
}

/** AgentDock lifecycle adapter for LangGraph's Redis saver. */
export class RedisCheckpoint implements CheckpointAdapter {
  readonly saver: RedisSaver;
  private readonly client: RedisClientType;
  private initialized = false;
  private closed = false;
  private initialization: Promise<void> | undefined;

  constructor(options: RedisCheckpointOptions) {
    if (typeof options?.url !== "string" || options.url.trim().length === 0) {
      throw new Error("RedisCheckpoint url must be a non-empty string.");
    }
    this.client = createClient({ url: options.url });
    this.saver = new RedisSaver(this.client, options.ttl);
  }

  initialize(): Promise<void> {
    if (this.closed) throw new Error("RedisCheckpoint is already closed.");
    if (this.initialized) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.initialization = this.setup().then(
      () => {
        this.initialized = true;
      },
      (error: unknown) => {
        this.initialization = undefined;
        throw error;
      },
    );
    return this.initialization;
  }

  private async setup(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
    await callSetup(this.saver);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.initialization?.catch(() => undefined);
    await this.saver.end();
  }
}

async function callSetup(saver: RedisSaver): Promise<void> {
  // The official Redis saver keeps index setup private but exposes it through
  // its async fromUrl factory. The adapter has a synchronous constructor API,
  // so invoke that same runtime hook after connecting a caller-provided client.
  const setup = (
    saver as unknown as {
      ensureIndexes?: () => Promise<void>;
    }
  ).ensureIndexes;
  if (typeof setup === "function") await setup.call(saver);
}
