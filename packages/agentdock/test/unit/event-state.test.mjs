import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_EVENT_STATE_KEY,
  parseAgentEventState,
  withAgentEventState,
} from "../../src/langgraph/event-state.js";
import { z } from "zod";

test("the composed schema adds the Agentdock checkpoint field by default", () => {
  const schema = withAgentEventState({ notes: z.string().default("") });
  assert.deepEqual(schema.parse({}), {
    agentEventState: { logicalSequence: 0 },
    notes: "",
  });
  assert.equal(AGENT_EVENT_STATE_KEY, "agentEventState");
});

test("the Agentdock state parser accepts complete state and rejects malformed state", () => {
  const interrupt = {
    kind: "custom",
    interruptId: "interrupt-1",
    prompt: "Continue?",
    payload: { reason: "review" },
    actions: [{ id: "yes", name: "continue", input: { enabled: true } }],
  };
  const parsed = parseAgentEventState({
    agentEventState: {
      runId: "run-1",
      logicalSequence: 5,
      pendingInterrupt: interrupt,
    },
  });

  assert.deepEqual(parsed, {
    status: "valid",
    state: {
      runId: "run-1",
      logicalSequence: 5,
      pendingInterrupt: interrupt,
    },
  });
  assert.deepEqual(parseAgentEventState({}), { status: "missing" });
  assert.deepEqual(
    parseAgentEventState({ agentEventState: { logicalSequence: 0 } }),
    {
      status: "valid",
      state: { logicalSequence: 0 },
    },
  );
  assert.deepEqual(
    parseAgentEventState({
      agentEventState: {
        runId: "run-1",
        logicalSequence: 5,
        unexpected: "field",
      },
    }),
    { status: "invalid" },
  );
  assert.deepEqual(
    parseAgentEventState({
      agentEventState: {
        runId: "run-1",
        logicalSequence: 5,
        pendingInterrupt: { ...interrupt, payload: { invalid: undefined } },
      },
    }),
    { status: "invalid" },
  );
});

test("withAgentEventState rejects an application-owned reserved field", () => {
  assert.throws(
    () => withAgentEventState({ agentEventState: z.string() }),
    /reserved by Agentdock/,
  );
});
