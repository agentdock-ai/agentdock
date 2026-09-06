import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

/** A lifecycle-aware wrapper around a LangGraph checkpoint saver. */
export interface CheckpointAdapter {
  readonly saver: BaseCheckpointSaver;

  initialize(): Promise<void>;
  close(): Promise<void>;
}
