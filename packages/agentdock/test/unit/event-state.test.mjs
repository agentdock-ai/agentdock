import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_EVENT_STATE_KEY,
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

test("the legacy schema still validates saved pending interrupt fields", () => {
  const schema = withAgentEventState({});
  const interrupt = {
    kind: "custom",
    interruptId: "i",
    prompt: "Choose",
    actions: [],
    payload: { reason: "review" },
  };
  const value = {
    agentEventState: {
      runId: "old-run",
      logicalSequence: 5,
      pendingInterrupt: interrupt,
    },
  };
  assert.deepEqual(schema.parse(value), value);
  assert.throws(() =>
    schema.parse({
      agentEventState: { ...value.agentEventState, unexpected: "field" },
    }),
  );
  assert.throws(() =>
    schema.parse({
      agentEventState: {
        ...value.agentEventState,
        pendingInterrupt: { ...interrupt, payload: { invalid: undefined } },
      },
    }),
  );
});

test("withAgentEventState rejects an application-owned reserved field", () => {
  assert.throws(
    () => withAgentEventState({ agentEventState: z.string() }),
    /reserved by Agentdock/,
  );
});
