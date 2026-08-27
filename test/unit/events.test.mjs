import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentEventType } from "../../src/agent/events.js";
import { AgentEventStream } from "../../src/agent/runtime/events.js";

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function completedResult(overrides = {}) {
  return {
    runId: "run-report-1",
    sessionId: "session-report",
    status: "completed",
    content: "The report is ready.",
    messages: [],
    toolCalls: [],
    toolResults: [],
    toolErrors: [],
    approvalRequests: [],
    stepsCompleted: 1,
    ...overrides,
  };
}

async function* streamParts(parts) {
  for (const part of parts) yield part;
}

test("AgentEventStream normalizes text, steps, tools, and stream completion", async () => {
  const stream = new AgentEventStream({
    runId: "run-report-1",
    rawStream: streamParts([
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "The report" },
      { type: "text-end", id: "text-1" },
      { type: "tool-input-start", id: "input-1", toolName: "lookup_report" },
      { type: "tool-input-delta", id: "input-1", delta: "{\"id\":" },
      { type: "tool-input-end", id: "input-1" },
      {
        type: "tool-call",
        toolCallId: "call-lookup-report",
        toolName: "lookup_report",
        input: { reportId: "report-2026-08" },
      },
      {
        type: "tool-result",
        toolCallId: "call-lookup-report",
        toolName: "lookup_report",
        input: { reportId: "report-2026-08" },
        output: { found: true },
      },
      { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 10 } },
    ]),
    result: Promise.resolve(completedResult()),
    getRun: async () => null,
    initialEvents: [{ type: AgentEventType.RunStarted }],
  });

  const events = await collect(stream);

  assert.deepEqual(events.map((event) => event.type), [
    AgentEventType.RunStarted,
    AgentEventType.StreamStarted,
    AgentEventType.StepStarted,
    AgentEventType.TextStarted,
    AgentEventType.TextDelta,
    AgentEventType.TextCompleted,
    AgentEventType.ToolInputStarted,
    AgentEventType.ToolInputDelta,
    AgentEventType.ToolInputCompleted,
    AgentEventType.ToolCalled,
    AgentEventType.ToolResult,
    AgentEventType.StreamFinished,
    AgentEventType.RunCompleted,
  ]);
  assert.deepEqual(events[4].text, "The report");
  assert.equal(events[2].step, 1);
  assert.deepEqual(events[9].toolCall, {
    toolCallId: "call-lookup-report",
    name: "lookup_report",
    input: { reportId: "report-2026-08" },
  });
  assert.deepEqual(events[10].result.output, { found: true });
  assert.equal(events.at(-1).content, "The report is ready.");
  assert.ok(events.every((event) => event.runId === "run-report-1"));
  assert.ok(events.every((event) => event.version === 1));
  assert.ok(events.every((event) => event.eventId));
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
});

test("AgentEventStream emits an approval request only once", async () => {
  const approvalPart = {
    type: "tool-approval-request",
    approvalId: "approval-send-report",
    toolCall: {
      toolCallId: "call-send-report",
      toolName: "send_report",
      input: { recipient: "team@example.com" },
    },
  };
  const stream = new AgentEventStream({
    runId: "run-report-2",
    rawStream: streamParts([approvalPart, approvalPart]),
    result: Promise.resolve(completedResult({
      runId: "run-report-2",
      status: "waiting_for_approval",
      approvalRequests: [{
        approvalId: "approval-send-report",
        toolCall: {
          toolCallId: "call-send-report",
          name: "send_report",
          input: { recipient: "team@example.com" },
        },
      }],
    })),
    getRun: async () => null,
  });

  const events = await collect(stream);
  const approvals = events.filter((event) => event.type === AgentEventType.ApprovalRequired);

  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].approvals[0], {
    approvalId: "approval-send-report",
    toolCall: {
      toolCallId: "call-send-report",
      name: "send_report",
      input: { recipient: "team@example.com" },
    },
  });
});

test("AgentEventStream reports failed results and cancellation", async () => {
  const failedStream = new AgentEventStream({
    runId: "run-failed",
    rawStream: streamParts([]),
    result: Promise.reject(new Error("Model unavailable")),
    getRun: async () => null,
  });
  const failedEvents = await collect(failedStream);
  assert.equal(failedEvents.at(-1).type, AgentEventType.RunFailed);
  assert.deepEqual(failedEvents.at(-1).error, {
    code: "Error",
    message: "Model unavailable",
  });

  const cancelledStream = new AgentEventStream({
    runId: "run-cancelled",
    rawStream: streamParts([]),
    result: Promise.resolve(completedResult({
      runId: "run-cancelled",
      status: "cancelled",
    })),
    getRun: async () => null,
  });
  const cancelledEvents = await collect(cancelledStream);
  assert.equal(cancelledEvents.at(-1).type, AgentEventType.RunCancelled);
});

test("AgentEventStream can only be consumed once", () => {
  const stream = new AgentEventStream({
    runId: "run-once",
    rawStream: streamParts([]),
    result: Promise.resolve(completedResult({ runId: "run-once" })),
    getRun: async () => null,
  });

  stream[Symbol.asyncIterator]();
  assert.throws(
    () => stream[Symbol.asyncIterator](),
    /AgentEventStream can only be consumed once/,
  );
});
