import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentEventType, reduceAgentEvent } from "@agentdock-ai/contracts";
import { EventContext } from "../../src/events/event-context.js";
import { createResumeState } from "../../src/langgraph/resume-state.js";

const interrupt = {
  kind: "custom",
  interruptId: "interrupt-1",
  prompt: "Continue?",
  actions: [{ id: "continue", name: "continue", input: {} }],
};

test("creates a thread-bound waiting reducer seed for a resume stream", () => {
  const result = createResumeState(
    {
      agentEventState: {
        runId: "run-1",
        logicalSequence: 7,
        pendingInterrupt: interrupt,
      },
    },
    "thread-1",
  );

  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.state.status, "waiting");
  assert.equal(result.state.runId, "run-1");
  assert.equal(result.state.threadId, "thread-1");
  assert.equal(result.state.lastLogicalSequence, 7);
  assert.deepEqual(result.state.messages, []);
  assert.deepEqual(result.state.interrupt, interrupt);

  const context = new EventContext("run-1", 7);
  const events = [
    context.emit({ type: AgentEventType.RunStarted }),
    context.emit({
      type: AgentEventType.InterruptResolved,
      interruptId: "interrupt-1",
      decisions: [{ type: "approve" }],
    }),
    context.emit({
      type: AgentEventType.RunCompleted,
      finishReason: "stop",
      content: [],
    }),
  ];
  const finalState = events.reduce(reduceAgentEvent, result.state);
  assert.equal(finalState.status, "completed");
  assert.equal(finalState.interrupt, null);
});

test("reports no pending interrupt and invalid checkpoints explicitly", () => {
  assert.deepEqual(createResumeState({}, "thread-1"), {
    status: "invalid_checkpoint",
  });
  assert.deepEqual(
    createResumeState({ agentEventState: { logicalSequence: 0 } }, "thread-1"),
    { status: "no_pending_interrupt" },
  );
  assert.deepEqual(
    createResumeState(
      {
        agentEventState: {
          runId: "run-1",
          logicalSequence: 7,
          pendingInterrupt: { ...interrupt, interruptId: "" },
        },
      },
      "thread-1",
    ),
    { status: "invalid_checkpoint" },
  );
  assert.deepEqual(createResumeState({ agentEventState: null }, "thread-1"), {
    status: "invalid_checkpoint",
  });
  assert.throws(
    () => createResumeState({}, " "),
    /threadId must be a non-empty string/,
  );
});
