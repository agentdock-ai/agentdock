import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_EVENT_PROTOCOL_VERSION,
  AgentEventType,
} from "../../src/agent/events.js";
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
  assert.equal(event.protocolVersion, AGENT_EVENT_PROTOCOL_VERSION);
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

test("AgentEventStream continues the logical sequence across phases", async () => {
  const first = new AgentEventStream("run-phases", "session-phases");
  first.emit({ type: AgentEventType.RunStarted });
  const firstEvent = (await first[Symbol.asyncIterator]().next()).value;
  first.close();

  const second = new AgentEventStream("run-phases", "session-phases");
  second.setLogicalSequenceStart(firstEvent.logicalSequence);
  second.emit({
    type: AgentEventType.RunCompleted,
    finishReason: "stop",
    content: [],
  });
  const secondEvent = (await second[Symbol.asyncIterator]().next()).value;

  assert.equal(firstEvent.sequence, 1);
  assert.equal(secondEvent.sequence, 1);
  assert.equal(secondEvent.logicalSequence, 2);
  assert.notEqual(firstEvent.phaseId, secondEvent.phaseId);
  assert.throws(
    () => second.setLogicalSequenceStart(10),
    /cannot start after emission/,
  );
  second.close();
});

test("AgentEventStream rejects a non-JSON event payload before sequencing it", async () => {
  const stream = new AgentEventStream(
    "run-invalid-event",
    "session-invalid-event",
  );

  assert.throws(
    () =>
      stream.emit({
        type: AgentEventType.MessagePartDelta,
        messageId: "message-invalid-event",
        part: {
          type: "custom",
          name: "invalid",
          data: { nested: 1n },
        },
      }),
    /Agent event input\.part\.data\.nested is not JSON-serializable/,
  );
  stream.emit({ type: AgentEventType.RunStarted });
  const event = (await stream[Symbol.asyncIterator]().next()).value;
  assert.equal(event.sequence, 1);
  assert.equal(event.logicalSequence, 1);
  stream.close();
});
