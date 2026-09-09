import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentEventType } from "../../src/agent/events.js";
import { AgentEventStream } from "../../src/agent/workflows/event-stream.js";

test("AgentEventStream adds ordered event metadata and closes cleanly", async () => {
  const stream = new AgentEventStream("run-stream");
  const iterator = stream[Symbol.asyncIterator]();
  const pending = iterator.next();

  stream.emit({
    type: AgentEventType.RunStarted,
  });

  const event = (await pending).value;
  assert.equal(event.type, AgentEventType.RunStarted);
  assert.equal(event.runId, "run-stream");
  assert.equal(event.sessionId, "");
  assert.equal(event.logicalSequence, 1);
  assert.match(event.phaseId, /^[0-9a-f-]{36}$/);
  assert.equal(event.sequence, 1);
  assert.match(event.eventId, /^[0-9a-f-]{36}$/);
  assert.ok(event.timestamp);

  stream.close();
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
});

test("AgentEventStream drops queued events when the consumer stops", async () => {
  const stream = new AgentEventStream("run-stopped");
  const iterator = stream[Symbol.asyncIterator]();

  stream.emit({
    type: AgentEventType.RunStarted,
  });
  await iterator.return();

  stream.emit({
    type: AgentEventType.RunCompleted,
    finishReason: "stop",
    content: [{ type: "text", text: "ignored" }],
  });

  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
});
