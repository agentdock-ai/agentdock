import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";
import { CheckpointManager } from "../src/index.js";

function createAdapter(
  initialize: () => Promise<void> = async () => {},
  close: () => Promise<void> = async () => {},
) {
  return {
    saver: new MemorySaver(),
    initialize,
    close,
  };
}

describe("CheckpointManager", () => {
  it("initializes and closes an owned adapter exactly once", async () => {
    let initializeCalls = 0;
    let closeCalls = 0;
    const adapter = createAdapter(
      async () => {
        initializeCalls += 1;
      },
      async () => {
        closeCalls += 1;
      },
    );
    const manager = new CheckpointManager({ checkpoint: adapter });

    await Promise.all([manager.initialize(), manager.initialize()]);
    await manager.close();
    await manager.close();

    expect(initializeCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(manager.saver).toBe(adapter.saver);
  });

  it("waits for initialization before closing the adapter", async () => {
    let resolveInitialization: (() => void) | undefined;
    let closeCalls = 0;
    const adapter = createAdapter(
      () =>
        new Promise<void>((resolve) => {
          resolveInitialization = resolve;
        }),
      async () => {
        closeCalls += 1;
      },
    );
    const manager = new CheckpointManager({ checkpoint: adapter });

    const initialization = manager.initialize();
    const closing = manager.close();
    await Promise.resolve();
    expect(closeCalls).toBe(0);

    resolveInitialization?.();
    await initialization;
    await closing;
    expect(closeCalls).toBe(1);
  });

  it("allows initialization to retry after a failure", async () => {
    let attempts = 0;
    const adapter = createAdapter(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary checkpoint failure");
    });
    const manager = new CheckpointManager({ checkpoint: adapter });

    await expect(manager.initialize()).rejects.toThrow(
      "temporary checkpoint failure",
    );
    await manager.initialize();

    expect(attempts).toBe(2);
  });

  it("does not close an externally supplied saver", async () => {
    class TrackingSaver extends MemorySaver {
      closeCalls = 0;

      async close() {
        this.closeCalls += 1;
      }
    }

    const saver = new TrackingSaver();
    const manager = new CheckpointManager({ checkpointer: saver });

    await manager.initialize();
    await manager.close();

    expect(saver.closeCalls).toBe(0);
  });

  it("rejects conflicting options and operations after close", async () => {
    expect(
      () =>
        new CheckpointManager({
          checkpoint: createAdapter(),
          checkpointer: new MemorySaver(),
        }),
    ).toThrow(/cannot be used together/);

    const manager = new CheckpointManager({ checkpoint: createAdapter() });
    await manager.close();

    await expect(manager.initialize()).rejects.toThrow(/after closing/);
  });
});
