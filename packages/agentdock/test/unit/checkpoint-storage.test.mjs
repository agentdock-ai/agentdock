import assert from "node:assert/strict";
import { test } from "vitest";
import { FakeToolCallingModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { AgentDock } from "../../src/index.js";

function createAgent(options = {}) {
  return new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    ...options,
  });
}

test("AgentDock defaults to a LangGraph in-memory saver", async () => {
  const agent = createAgent();
  const result = await agent.run(
    "Use memory checkpoints.",
    {},
    { sessionId: "memory-session" },
  );
  assert.equal(result.status, "completed");
  await agent.close();
});

test("AgentDock accepts a vendor BaseCheckpointSaver instance", async () => {
  const checkpointer = new MemorySaver();
  const agent = createAgent({ checkpointer });
  const result = await agent.run(
    "Use the supplied saver.",
    {},
    { sessionId: "external-saver-session" },
  );
  assert.equal(result.status, "completed");
  await agent.close();
});

test("AgentDock does not close an application-owned checkpointer", async () => {
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

test("malformed checkpointer values fail at construction", () => {
  assert.throws(
    () => createAgent({ checkpointer: {} }),
    /must be a LangGraph checkpointer/,
  );
});

test("the removed checkpoint adapter option is rejected clearly", () => {
  assert.throws(
    () => createAgent({ checkpoint: {} }),
    /checkpoint option was removed; use checkpointer/,
  );
});

test("AgentDock rejects operations after close", async () => {
  const agent = createAgent();
  await agent.close();
  await assert.rejects(
    () => agent.getSession("closed-session"),
    /AgentDock is closed or closing/,
  );
});
