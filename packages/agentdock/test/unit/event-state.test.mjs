import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_EVENT_STATE_KEY,
  agentEventStateSchema,
  parseAgentEventState,
  readAgentEventState,
  withAgentEventState,
} from "../../src/langgraph/event-state.js";
import { z } from "zod";

test("event state schema supplies an empty sequence by default", () => {
  assert.deepEqual(agentEventStateSchema.parse({}), {
    agentdockEventState: { logicalSequence: 0 },
  });
});

test("reader accepts only the namespaced event state and known field types", () => {
  assert.deepEqual(
    readAgentEventState({
      [AGENT_EVENT_STATE_KEY]: {
        runId: "run-1",
        logicalSequence: 4,
        pendingInterruptId: "interrupt-1",
      },
    }),
    {
      runId: "run-1",
      logicalSequence: 4,
      pendingInterruptId: "interrupt-1",
    },
  );
  assert.equal(readAgentEventState({}), null);
  assert.equal(readAgentEventState(null), null);
  assert.equal(
    readAgentEventState({ [AGENT_EVENT_STATE_KEY]: { runId: 12 } }),
    null,
  );
});

test("event state preserves valid pending interrupt payloads and legacy IDs", () => {
  const interrupt = {
    kind: "custom",
    interruptId: "interrupt-2",
    prompt: "Continue?",
    payload: { reason: "review" },
    actions: [{ id: "yes", name: "continue", input: { enabled: true } }],
  };
  assert.deepEqual(
    readAgentEventState({
      [AGENT_EVENT_STATE_KEY]: {
        runId: "run-2",
        logicalSequence: 5,
        pendingInterruptId: "interrupt-2",
        pendingInterrupt: interrupt,
      },
    })?.pendingInterrupt,
    interrupt,
  );
  assert.equal(
    readAgentEventState({
      [AGENT_EVENT_STATE_KEY]: {
        runId: "legacy-run",
        logicalSequence: 2,
        pendingInterruptId: "legacy-interrupt",
      },
    })?.pendingInterrupt,
    undefined,
  );
  assert.equal(
    readAgentEventState({
      [AGENT_EVENT_STATE_KEY]: {
        pendingInterrupt: { ...interrupt, payload: { invalid: undefined } },
      },
    }),
    null,
  );
  assert.equal(
    parseAgentEventState({
      [AGENT_EVENT_STATE_KEY]: {
        runId: "run-2",
        logicalSequence: 5,
        pendingInterruptId: "different-id",
        pendingInterrupt: interrupt,
      },
    }).status,
    "invalid",
  );
});

test("withAgentEventState composes the reserved field and application fields", () => {
  const schema = withAgentEventState({ notes: z.string().default("") });
  assert.deepEqual(schema.parse({}), {
    agentdockEventState: { logicalSequence: 0 },
    notes: "",
  });
  assert.throws(
    () => withAgentEventState({ agentdockEventState: z.string() }),
    /reserved by Agentdock/,
  );
});
