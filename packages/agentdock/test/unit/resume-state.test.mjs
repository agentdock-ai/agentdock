import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentEventType, reduceAgentEvent } from "@agentdock-ai/contracts";
import { EventContext } from "../../src/events/event-context.js";
import { createResumeState } from "../../src/langgraph/resume-state.js";

const native = {
  id: "interrupt-1",
  value: { prompt: "Continue?", custom: ["yes", "no"] },
};
test("hydrates control state from native tasks without event bookkeeping", () => {
  const result = createResumeState(
    {
      values: {},
      next: ["ask"],
      tasks: [{ name: "ask", interrupts: [native] }],
    },
    "thread-1",
  );
  assert.equal(result.status, "ready");
  assert.equal(result.state.runId, null);
  assert.equal(result.state.threadId, "thread-1");
  assert.equal(result.state.lastLogicalSequence, 0);
  assert.deepEqual(result.state.interrupt.payload, native.value);
  assert.equal(result.state.interrupts.length, 1);
  const context = new EventContext("new-invocation", 0);
  const events = [
    context.emit({ type: AgentEventType.RunStarted }),
    context.emit({
      type: AgentEventType.InterruptResolved,
      interruptId: "interrupt-1",
      decisions: [true],
    }),
    context.emit({
      type: AgentEventType.RunCompleted,
      finishReason: "stop",
      content: [],
    }),
  ];
  assert.equal(
    events.reduce(reduceAgentEvent, result.state).status,
    "completed",
  );
});

test("reports malformed native interruptions and missing pending execution", () => {
  assert.deepEqual(
    createResumeState({ values: {}, next: [], tasks: [] }, "thread-1"),
    { status: "no_pending_interrupt" },
  );
  assert.deepEqual(
    createResumeState(
      { values: { agentEventState: { pendingInterrupt: native } } },
      "thread-1",
    ),
    { status: "no_pending_interrupt" },
  );
  for (const interrupt of [
    { value: "bad" },
    { id: "", value: "bad" },
    { id: "bad", value: undefined },
  ]) {
    assert.equal(
      createResumeState(
        { values: {}, tasks: [{ interrupts: [interrupt] }] },
        "thread-1",
      ).status,
      "invalid_checkpoint",
    );
  }
  assert.throws(() => createResumeState({ values: {} }, " "), /threadId/);
});

test("hydrates static breakpoints and ignores resolved task interrupts", () => {
  const ready = createResumeState(
    { values: {}, next: ["work"], tasks: [] },
    "t",
  );
  assert.equal(ready.state.status, "waiting");
  assert.deepEqual(ready.state.pausedNodes, ["work"]);
  assert.equal(ready.state.interrupt, null);
  assert.equal(
    createResumeState(
      { values: {}, next: [], tasks: [{ name: "done", interrupts: [native] }] },
      "t",
    ).status,
    "no_pending_interrupt",
  );
});

test("nested native snapshots deduplicate parent mirrors and retain errored pending tasks", () => {
  const child = {
    values: {},
    config: { configurable: { checkpoint_ns: "child:uuid" } },
    next: ["ask"],
    tasks: [{ name: "ask", interrupts: [native] }],
  };
  const parent = {
    values: {},
    next: ["child"],
    tasks: [{ name: "child", state: child, interrupts: [native] }],
  };
  assert.equal(createResumeState(parent, "t").state.interrupts.length, 1);
  assert.equal(
    createResumeState(
      {
        values: {},
        next: [],
        tasks: [{ name: "failed", error: "failed", interrupts: [native] }],
      },
      "t",
    ).state.interrupt.interruptId,
    native.id,
  );
});

test.each([
  { values: {}, next: [42] },
  { values: {}, tasks: [null] },
  { values: {}, config: 42 },
])("rejects malformed nested native state: %j", (state) => {
  assert.equal(
    createResumeState({ values: {}, tasks: [{ state }] }, "t").status,
    "invalid_checkpoint",
  );
});
