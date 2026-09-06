import {
  MemorySaver,
  type BaseCheckpointSaver,
} from "@langchain/langgraph-checkpoint";
import type { CheckpointAdapter } from "./types.js";

/** In-process checkpoint storage for development and tests. */
export class MemoryCheckpoint implements CheckpointAdapter {
  readonly saver: BaseCheckpointSaver = new MemorySaver();

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
