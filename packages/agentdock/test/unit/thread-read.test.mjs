import assert from "node:assert/strict";
import { test } from "vitest";
import { Agentdock } from "../../src/index.js";

test("Agentdock reads checkpoint messages and returns null for missing threads", async () => {
  const graph = createGraph({
    messages: [{ role: "user", content: "hello" }],
    history: ["older"],
  });
  const agent = new Agentdock(graph);
  assert.deepEqual(await agent.getMessages("thread-1"), [
    { role: "user", content: "hello" },
  ]);
  assert.deepEqual(
    await agent.getMessages("thread-1", { channel: "history" }),
    ["older"],
  );
  assert.equal(await agent.getMessages("missing"), null);
});

test("snapshot helper treats empty state as a missing thread", async () => {
  const agent = new Agentdock(createGraph({}));
  assert.equal(await agent.getMessages("empty-thread"), null);
  assert.equal(await agent.getResumeState("empty-thread"), null);
});

function createGraph(values) {
  return {
    async stream() {
      return (async function* () {})();
    },
    async getState(config) {
      return {
        values: config.configurable.thread_id === "missing" ? {} : values,
      };
    },
    async updateState() {
      return {};
    },
  };
}
