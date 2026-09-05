import {
  MemorySaver,
  type BaseCheckpointSaver,
} from "@langchain/langgraph-checkpoint";
import type {
  AgentDockCheckpointConfig,
  CheckpointAdapter,
  CheckpointFactory,
} from "./types.js";

type MemoryCheckpointConfig = Extract<
  AgentDockCheckpointConfig,
  { type: "memory" }
>;

export class MemoryCheckpointAdapter implements CheckpointAdapter {
  readonly saver: BaseCheckpointSaver = new MemorySaver();

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export class MemoryCheckpointFactory implements CheckpointFactory<MemoryCheckpointConfig> {
  readonly type = "memory" as const;

  create(_config: MemoryCheckpointConfig): CheckpointAdapter {
    return new MemoryCheckpointAdapter();
  }
}
