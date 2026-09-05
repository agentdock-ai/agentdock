import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

export type AgentDockCheckpointConfig = {
  type: "memory";
};

export interface CheckpointAdapter {
  readonly saver: BaseCheckpointSaver;

  initialize(): Promise<void>;
  close(): Promise<void>;
}

export interface CheckpointFactory<TConfig extends AgentDockCheckpointConfig> {
  readonly type: TConfig["type"];

  create(config: TConfig): CheckpointAdapter;
}
