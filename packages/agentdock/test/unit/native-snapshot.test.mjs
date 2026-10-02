import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeSnapshot,
  assertThreadSnapshot,
} from "../../src/langgraph/thread-read.js";
import { createResumeState } from "../../src/langgraph/resume-state.js";
const interruption = { id: "i", value: "Question" };
const snapshot = {
  values: {},
  next: ["worker"],
  config: { configurable: { checkpoint_id: "cp", checkpoint_ns: "" } },
  tasks: [
    { id: "a", name: "worker", interrupts: [interruption] },
    { id: "b", name: "worker", interrupts: [{ id: "other", value: "Other" }] },
  ],
};
const graph = (pendingWrites) => ({
  checkpointer: {
    async getTuple() {
      return { pendingWrites };
    },
  },
});
test.each([
  "__interrupt__",
  "__resume__",
  "__error__",
  "__error_source_node__",
  "__scheduled__",
])("native %s writes do not imply task completion", async (channel) => {
  const normalized = await normalizeSnapshot(
    graph([["a", channel, "value"]]),
    snapshot,
  );
  assert.equal(normalized.tasks.length, 2);
  assert.equal(createResumeState(normalized, "t").state.interrupts.length, 2);
});
test.each(["values", "__no_writes__", "__return__"])(
  "native successful %s writes remove the exact task, preserving same-name siblings",
  async (channel) => {
    const normalized = await normalizeSnapshot(
      graph([
        ["a", "__interrupt__", interruption],
        ["a", channel, false],
      ]),
      snapshot,
    );
    assert.deepEqual(
      normalized.tasks.map((t) => t.id),
      ["b"],
    );
    assert.equal(snapshot.tasks.length, 2);
  },
);
test("nested snapshots use their own checkpoint namespace and remove parent mirrors", async () => {
  const reads = [];
  const reader = {
    checkpointer: {
      async getTuple(config) {
        reads.push(config);
        return {
          pendingWrites: config.configurable.checkpoint_ns
            ? [["a", "value", true]]
            : [],
        };
      },
    },
  };
  const child = {
    ...snapshot,
    config: {
      configurable: { checkpoint_ns: "child:c", checkpoint_id: "child-cp" },
    },
  };
  const parent = {
    ...snapshot,
    tasks: [
      {
        id: "parent",
        name: "child",
        state: child,
        interrupts: [{ id: "other", value: "Other" }],
      },
    ],
  };
  const result = await normalizeSnapshot(reader, parent);
  assert.deepEqual(
    result.tasks[0].state.tasks.map((t) => t.id),
    ["b"],
  );
  assert.equal(createResumeState(result, "t").state.interrupts.length, 1);
  assert.deepEqual(
    reads.map((c) => c.configurable.checkpoint_id),
    ["cp", "child-cp"],
  );
});
test("read-only snapshot normalization preserves absent task fields and propagates saver failures", async () => {
  const value = { values: {}, next: [] };
  assert.equal(await normalizeSnapshot({}, value), value);
  await assert.rejects(
    () =>
      normalizeSnapshot(
        {
          checkpointer: {
            getTuple() {
              throw new Error("saver failed");
            },
          },
        },
        snapshot,
      ),
    /saver failed/,
  );
  assert.deepEqual(
    (
      await normalizeSnapshot(
        {},
        { values: {}, tasks: [{ result: false, interrupts: [interruption] }] },
      )
    ).tasks,
    [],
  );
});
test.each([
  null,
  {},
  { values: {}, next: [1] },
  { values: {}, tasks: [null] },
  { values: {}, tasks: [{ id: 1 }] },
  { values: {}, tasks: [{ name: false }] },
  { values: {}, tasks: [{ interrupts: false }] },
  { values: {}, config: false },
])("rejects malformed native snapshots: %j", (value) => {
  assert.throws(() => assertThreadSnapshot(value));
});
