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

test("checkpoint reads forward namespace and saver options with the authorized thread", async () => {
  const calls = [];
  const graph = createGraph({ messages: ["hello"] });
  graph.getState = async (...args) => {
    calls.push(args);
    return { values: { messages: ["hello"] } };
  };
  const runtime = new Agentdock(graph);
  const config = {
    configurable: {
      thread_id: "untrusted",
      checkpoint_ns: "nested",
      tenant: "tenant-a",
    },
    tags: ["read"],
  };
  await runtime.getMessages("authorized", { config });
  await runtime.getResumeState("authorized", config);
  for (const [options, readOptions] of calls) {
    assert.deepEqual(options.configurable, {
      thread_id: "authorized",
      checkpoint_ns: "nested",
      tenant: "tenant-a",
    });
    assert.deepEqual(readOptions, { subgraphs: true });
  }
  assert.equal(config.configurable.thread_id, "untrusted");
});

test.each(["", "   ", null])(
  "rejects invalid read thread IDs: %j",
  async (threadId) => {
    const runtime = new Agentdock(createGraph({ messages: [] }));
    await assert.rejects(runtime.getMessages(threadId), /non-empty/);
    await assert.rejects(runtime.getResumeState(threadId), /non-empty/);
  },
);

test("rejects malformed message channels and returns empty for absent channels", async () => {
  assert.deepEqual(
    await new Agentdock(createGraph({ marker: true })).getMessages("t"),
    [],
  );
  await assert.rejects(
    new Agentdock(createGraph({ messages: {} })).getMessages("t"),
    /is not an array/,
  );
});

test("native pending tasks hydrate even without object state values", async () => {
  const graph = createGraph({});
  graph.getState = async () => ({
    values: null,
    next: ["ask"],
    tasks: [{ name: "ask", interrupts: [{ id: "pending", value: "Choose" }] }],
  });
  const seed = await new Agentdock(graph).getResumeState("t");
  assert.equal(seed.interrupt.interruptId, "pending");
  assert.equal(await new Agentdock(graph).getMessages("t"), null);
});
