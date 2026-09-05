import { MemoryCheckpointFactory } from "./memory-checkpoint.js";
import type { AgentDockCheckpointConfig, CheckpointAdapter } from "./types.js";

export class CheckpointFactoryRegistry {
  private readonly memory = new MemoryCheckpointFactory();

  create(config: AgentDockCheckpointConfig): CheckpointAdapter {
    return this.memory.create(config);
  }
}
