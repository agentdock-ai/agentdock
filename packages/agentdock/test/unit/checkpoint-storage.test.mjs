import assert from "node:assert/strict";
import { test } from "vitest";
import { FakeToolCallingModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { MemoryCheckpoint } from "@agentdock/checkpoint";
import { AgentDock } from "../../src/index.js";

function createAgent(options = {}) {
  return new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    ...options,
  });
}

test("AgentDock accepts a memory checkpoint adapter", async () => {
  const agent = createAgent({ checkpoint: new MemoryCheckpoint() });

  await agent.initialize();
  await agent.initialize();
  const result = await agent.run(
    "Use memory checkpoints.",
    {},
    { sessionId: "memory-session" },
  );

  assert.equal(result.status, "completed");
  await agent.close();
  await agent.close();
});

test("invalid checkpoint adapters fail at construction", () => {
  assert.throws(
    () =>
      createAgent({
        checkpoint: {},
      }),
    /must be a CheckpointAdapter instance/,
  );

  assert.throws(
    () =>
      createAgent({
        checkpoint: new MemoryCheckpoint(),
        checkpointer: new MemorySaver(),
      }),
    /cannot be used together/,
  );
});

test("AgentDock does not close an externally injected checkpointer", async () => {
  class TrackingSaver extends MemorySaver {
    closed = 0;

    async close() {
      this.closed += 1;
    }
  }

  const checkpointer = new TrackingSaver();
  const agent = createAgent({ checkpointer });

  await agent.close();

  assert.equal(checkpointer.closed, 0);
});

test("AgentDock rejects operations after close", async () => {
  const agent = createAgent();
  await agent.close();

  await assert.rejects(
    () => agent.getSession("closed-session"),
    /AgentDock is closed or closing/,
  );
});

test("AgentDock bounds an owned adapter close", async () => {
  let closeCalls = 0;
  const agent = createAgent({
    checkpoint: {
      saver: new MemorySaver(),
      initialize: async () => {},
      close: async () => {
        closeCalls += 1;
        await new Promise(() => {});
      },
    },
  });

  await agent.close({ gracePeriodMs: 10 });
  assert.equal(closeCalls, 1);
});

test("AgentDock stays deterministically closed when owned adapter close fails", async () => {
  const agent = createAgent({
    checkpoint: {
      saver: new MemorySaver(),
      initialize: async () => {},
      close: async () => {
        throw new Error("adapter close failed");
      },
    },
  });

  const firstClose = agent.close();
  const secondClose = agent.close();
  assert.equal(firstClose, secondClose);
  await assert.rejects(firstClose, /adapter close failed/);
  await assert.rejects(agent.close(), /adapter close failed/);
  await assert.rejects(agent.initialize(), /closed or closing/);
});
