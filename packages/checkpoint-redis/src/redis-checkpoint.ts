import {
  RedisSaver,
  type TTLConfig,
} from "@langchain/langgraph-checkpoint-redis";
import type { CheckpointAdapter } from "@agentdock/checkpoint";

export interface RedisCheckpointOptions {
  readonly url: string;
  readonly ttl?: TTLConfig;
}

/** AgentDock lifecycle adapter for LangGraph's Redis saver. */
export class RedisCheckpoint implements CheckpointAdapter {
  readonly saver: RedisSaver;
  private closed = false;

  private constructor(saver: RedisSaver) {
    this.saver = saver;
  }

  static async create(
    options: RedisCheckpointOptions,
  ): Promise<RedisCheckpoint> {
    if (typeof options?.url !== "string" || options.url.trim().length === 0) {
      throw new Error("RedisCheckpoint url must be a non-empty string.");
    }

    try {
      const saver = await RedisSaver.fromUrl(options.url, options.ttl);
      return new RedisCheckpoint(saver);
    } catch (error) {
      throw withCause("Failed to create Redis checkpoints.", error);
    }
  }

  initialize(): Promise<void> {
    if (this.closed) throw new Error("RedisCheckpoint is already closed.");
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.saver.end();
  }
}

function withCause(message: string, cause: unknown): Error {
  return Object.assign(new Error(message), { cause });
}
