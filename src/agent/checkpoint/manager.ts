import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { AgentDockCheckpointConfig, CheckpointAdapter } from "./types.js";
import { CheckpointFactoryRegistry } from "./registry.js";

type CheckpointManagerState =
  "new" | "initializing" | "ready" | "closing" | "closed";

export interface CheckpointManagerOptions {
  checkpoint?: AgentDockCheckpointConfig;
  checkpointer?: BaseCheckpointSaver;
}

export class CheckpointManager {
  private readonly adapter: CheckpointAdapter;
  private readonly ownsAdapter: boolean;
  private state: CheckpointManagerState = "new";
  private initialization: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: CheckpointManagerOptions) {
    if (
      options.checkpoint !== undefined &&
      options.checkpointer !== undefined
    ) {
      throw new Error(
        "AgentDock checkpoint and checkpointer options cannot be used together.",
      );
    }

    if (options.checkpointer !== undefined) {
      this.adapter = new ExternalCheckpointAdapter(options.checkpointer);
      this.ownsAdapter = false;
      return;
    }

    const config = options.checkpoint ?? { type: "memory" as const };
    this.adapter = new CheckpointFactoryRegistry().create(config);
    this.ownsAdapter = true;
  }

  get saver(): BaseCheckpointSaver {
    return this.adapter.saver;
  }

  async initialize(): Promise<void> {
    if (this.state === "closed" || this.state === "closing") {
      throw new Error("AgentDock cannot initialize after closing.");
    }
    if (this.state === "ready") return;
    if (this.initialization) return this.initialization;

    this.state = "initializing";
    this.initialization = this.adapter.initialize().then(
      () => {
        this.state = "ready";
      },
      (error: unknown) => {
        this.initialization = undefined;
        this.state = "new";
        throw error;
      },
    );
    return this.initialization;
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.closing) return this.closing;

    this.state = "closing";
    this.closing = (this.initialization ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (this.ownsAdapter) await this.adapter.close();
        this.state = "closed";
      });
    return this.closing;
  }
}

class ExternalCheckpointAdapter implements CheckpointAdapter {
  constructor(readonly saver: BaseCheckpointSaver) {}

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
