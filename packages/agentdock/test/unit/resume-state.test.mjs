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

test("creates a waiting reducer seed that accepts a resume stream", () => {
  const result = createResumeState(
    {
      agentdockEventState: {
        runId: "run-1",
        logicalSequence: 7,
        pendingInterruptId: "interrupt-1",
        pendingInterrupt: interrupt,
      },
    },
    "thread-1",
  );

  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.state.status, "waiting");
  assert.equal(result.state.runId, "run-1");
  assert.equal(result.state.sessionId, "thread-1");
  assert.equal(result.state.lastLogicalSequence, 7);
  assert.deepEqual(result.state.messages, []);
  assert.deepEqual(result.state.interrupt, interrupt);

  const context = new EventContext("run-1", "thread-1", 7);
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

test("reports checkpoint conditions without hiding legacy or invalid state", () => {
  assert.deepEqual(createResumeState({}, "thread-1"), {
    status: "invalid_checkpoint",
  });
  assert.deepEqual(
    createResumeState(
      { agentdockEventState: { logicalSequence: 0 } },
      "thread-1",
    ),
    { status: "no_pending_interrupt" },
  );
  assert.deepEqual(
    createResumeState(
      {
        agentdockEventState: {
          runId: "legacy-run",
          logicalSequence: 2,
          pendingInterruptId: "legacy-interrupt",
        },
      },
      "thread-1",
    ),
    { status: "legacy_checkpoint", interruptId: "legacy-interrupt" },
  );
  assert.deepEqual(
    createResumeState(
      {
        agentdockEventState: {
          runId: "run-1",
          logicalSequence: 7,
          pendingInterruptId: "interrupt-1",
          pendingInterrupt: { ...interrupt, interruptId: "mismatched-id" },
        },
      },
      "thread-1",
    ),
    { status: "invalid_checkpoint" },
  );
  assert.deepEqual(
    createResumeState(
      {
        agentdockEventState: {
          runId: "run-1",
          logicalSequence: 7,
          pendingInterruptId: "interrupt-1",
          pendingInterrupt: { ...interrupt, payload: { invalid: undefined } },
        },
      },
      "thread-1",
    ),
    { status: "invalid_checkpoint" },
  );
  assert.deepEqual(
    createResumeState({ agentdockEventState: { logicalSequence: 0 } }, ""),
    { status: "invalid_checkpoint" },
  );
});
