import assert from "node:assert/strict";
import { test } from "vitest";
import { FakeToolCallingModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { AgentDock } from "../../src/index.js";

function createAgent(options = {}) {
  return new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    ...options,
  });
}

test("AgentDock accepts the memory checkpoint configuration", async () => {
  const agent = createAgent({ checkpoint: { type: "memory" } });

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

test("invalid checkpoint configuration fails at construction", () => {
  assert.throws(
    () =>
      createAgent({
        checkpoint: { type: "unsupported" },
      }),
    /Unsupported AgentDock checkpoint type: unsupported/,
  );

  assert.throws(
    () =>
      createAgent({
        checkpoint: { type: "memory" },
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
