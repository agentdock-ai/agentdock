import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_EVENT_STATE_KEY,
  agentEventStateSchema,
  readAgentEventState,
} from "../../src/serving/event-state.js";

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
