import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { MemoryCheckpoint } from "./memory-checkpoint.js";
import type { CheckpointAdapter } from "./types.js";

type CheckpointManagerState =
  "new" | "initializing" | "ready" | "closing" | "closed";

export interface CheckpointManagerOptions {
  readonly checkpoint?: CheckpointAdapter;
  readonly checkpointer?: BaseCheckpointSaver;
}

/** Owns checkpoint adapter lifecycle without coupling workflows to a backend. */
export class CheckpointManager {
  private readonly adapter: CheckpointAdapter;
  private readonly ownsAdapter: boolean;
  private state: CheckpointManagerState = "new";
  private initialization: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: CheckpointManagerOptions = {}) {
    if (options.checkpoint && options.checkpointer) {
      throw new Error(
        "AgentDock checkpoint and checkpointer options cannot be used together.",
      );
    }

    if (options.checkpoint) {
      this.adapter = options.checkpoint;
      this.ownsAdapter = true;
    } else if (options.checkpointer) {
      this.adapter = new ExternalCheckpointAdapter(options.checkpointer);
      this.ownsAdapter = false;
    } else {
      this.adapter = new MemoryCheckpoint();
      this.ownsAdapter = true;
    }
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

  close(): Promise<void> {
    if (this.state === "closed") return Promise.resolve();
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
