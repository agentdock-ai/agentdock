import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentEventType } from "@agentdock-ai/contracts";
import { EventContext } from "../../src/serving/event-context.js";

test("each graph update starts a phase with a fresh local sequence", () => {
  const context = new EventContext("phase-run", "phase-session", 4);
  const first = context.emit({ type: AgentEventType.RunStarted });

  context.advancePhase();
  const second = context.emit({
    type: AgentEventType.MessageStarted,
    messageId: "message-1",
    role: "assistant",
  });

  assert.notEqual(second.phaseId, first.phaseId);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 1);
  assert.equal(second.logicalSequence, first.logicalSequence + 1);
});
