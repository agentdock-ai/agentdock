import assert from "node:assert/strict";
import { test } from "vitest";
import {
  readControlSnapshot,
  readFailureSnapshot,
  reconcileInterrupts,
} from "../../src/langgraph/control-projection.js";
import { EventContext } from "../../src/events/event-context.js";

const control = (tasks = [], next = []) => ({
  values: {},
  tasks: tasks.map((task) => ({ ...task, state: undefined })),
  next,
});
const interruption = (interruptId, occurrence = 0, kind = "custom") => ({
  interruptId,
  kind,
  prompt: "Question",
  actions: [],
  occurrence,
});
const reconcile = (pending, current, resume, raised = [], next = []) =>
  reconcileInterrupts(
    new EventContext("run", 0),
    pending,
    current,
    resume,
    new Set(raised),
    next,
  );

test("control reads request native subgraphs and only suppress missing checkpointers", async () => {
  const config = { configurable: { thread_id: "t", checkpoint_id: "pin" } };
  const snapshot = control();
  assert.deepEqual(
    await readControlSnapshot(
      {
        async getState(actual, options) {
          assert.equal(actual, config);
          assert.deepEqual(options, { subgraphs: true });
          return snapshot;
        },
      },
      config,
    ),
    snapshot,
  );
  assert.equal(
    await readControlSnapshot(
      {
        async getState() {
          throw { lc_error_code: "MISSING_CHECKPOINTER" };
        },
      },
      config,
    ),
    undefined,
  );
  const error = new Error("saver disconnected");
  await assert.rejects(
    () =>
      readControlSnapshot(
        {
          async getState() {
            throw error;
          },
        },
        config,
      ),
    (actual) => actual === error,
  );
});

test("failure reads find the observed native task in history without choosing an unrelated head", async () => {
  const pinned = control([{ id: "old", name: "work" }], ["work"]);
  const latest = control(
    [{ id: "another-invocation", name: "work" }],
    ["work"],
  );
  const produced = control([{ id: "executing", name: "after" }], ["after"]);
  const config = {
    configurable: {
      thread_id: "t",
      checkpoint_ns: "child:c",
      checkpoint_id: "pin",
      custom: true,
    },
    tags: ["app"],
  };
  let consumed = 0;
  const result = await readFailureSnapshot(
    {
      async getState() {
        return pinned;
      },
      async *getStateHistory(actual) {
        assert.deepEqual(actual, {
          ...config,
          configurable: {
            thread_id: "t",
            checkpoint_ns: "child:c",
            custom: true,
          },
        });
        for (const snapshot of [latest, produced, pinned]) {
          consumed++;
          yield snapshot;
        }
      },
    },
    config,
    new Set(["executing"]),
  );
  assert.deepEqual(result, produced);
  assert.equal(consumed, 2);
  assert.equal(config.configurable.checkpoint_id, "pin");
});

test.each(["no-observed-tasks", "already-matches", "no-history", "no-match"])(
  "failure reads preserve native state when %s",
  async (mode) => {
    const snapshot = control([{ id: "current", name: "work" }], ["work"]);
    let historyReads = 0;
    const graph = {
      async getState() {
        return snapshot;
      },
      async *getStateHistory() {
        historyReads++;
        yield control([{ id: "unrelated", name: "work" }]);
      },
    };
    if (mode === "no-history") delete graph.getStateHistory;
    const taskIds = new Set(
      mode === "no-observed-tasks"
        ? []
        : [mode === "already-matches" ? "current" : "missing"],
    );
    assert.deepEqual(await readFailureSnapshot(graph, {}, taskIds), snapshot);
    assert.equal(historyReads, mode === "no-match" ? 1 : 0);
  },
);

test("failure reads propagate history failures instead of selecting an arbitrary checkpoint", async () => {
  const error = new Error("history unavailable");
  await assert.rejects(
    () =>
      readFailureSnapshot(
        {
          async getState() {
            return control();
          },
          async *getStateHistory() {
            throw error;
          },
        },
        {},
        new Set(["task"]),
      ),
    (actual) => actual === error,
  );
});

test("native occurrence counts prevent unchanged questions from being falsely resolved", () => {
  const pending = interruption("id", 1);
  const events = reconcile(
    [pending],
    [pending],
    { wrong: "answer" },
    ["id"],
    ["ask"],
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ["run.paused"],
  );
  assert.deepEqual(events[0].next, ["ask"]);
});

test("a higher native occurrence resolves the old question before requiring its replacement", () => {
  const events = reconcile(
    [interruption("id", 0)],
    [interruption("id", 1)],
    { id: "answer" },
    [],
    ["ask"],
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ["interrupt.resolved", "run.paused", "interrupt.required"],
  );
  assert.deepEqual(events[0].decisions, ["answer"]);
  assert.equal(events[2].interrupt.occurrence, 1);
});

test("partial resolutions unwrap only the targeted native ID and preserve opaque answers", () => {
  const pending = [interruption("a"), interruption("b")];
  const answer = { a: "inner", decisions: [false, null] };
  const events = reconcile(pending, [pending[1]], { a: answer }, [], ["ask"]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["interrupt.resolved", "run.paused"],
  );
  assert.equal(events[0].interruptId, "a");
  assert.deepEqual(events[0].decisions, [answer]);
  assert.notEqual(events[0].decisions[0], answer);
  assert.deepEqual(
    reconcile(pending, [pending[1]], "untargeted")[0].decisions,
    [],
  );
});

test("only explicit approval projections unpack decisions; absent answers remain empty", () => {
  const decision = { type: "approve" };
  const events = reconcile([interruption("a", 0, "tool-approval")], [], {
    a: { decisions: [decision] },
  });
  assert.deepEqual(events[0].decisions, [decision]);
  assert.notEqual(events[0].decisions[0], decision);
  assert.deepEqual(
    reconcile([interruption("a")], [], undefined)[0].decisions,
    [],
  );
});
