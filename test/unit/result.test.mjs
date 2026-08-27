import assert from "node:assert/strict";
import { test } from "vitest";
import { createAgentRunResult } from "../../src/agent/runtime/result.js";

function createPrepared() {
  return {
    runId: "run-report-3",
    sessionId: "session-report",
    history: [{ role: "user", content: "Find the report." }],
    toolErrors: [],
  };
}

test("createAgentRunResult appends response messages and preserves run identity", () => {
  const prepared = createPrepared();
  const result = createAgentRunResult(
    prepared,
    "The report is ready.",
    [
      {
        role: "assistant",
        content: "The report is ready.",
      },
    ],
    [{
      toolCallId: "call-lookup-report",
      toolName: "lookup_report",
      input: { reportId: "report-2026-08" },
    }],
    [{
      toolCallId: "call-lookup-report",
      toolName: "lookup_report",
      input: { reportId: "report-2026-08" },
      output: { found: true },
    }],
    [],
    1,
  );

  assert.equal(result.runId, "run-report-3");
  assert.equal(result.sessionId, "session-report");
  assert.equal(result.status, "completed");
  assert.equal(result.content, "The report is ready.");
  assert.deepEqual(result.messages, [
    { role: "user", content: "Find the report." },
    { role: "assistant", content: "The report is ready." },
  ]);
  assert.deepEqual(result.toolCalls, [{
    toolCallId: "call-lookup-report",
    name: "lookup_report",
    input: { reportId: "report-2026-08" },
  }]);
  assert.deepEqual(result.toolResults, [{
    toolCallId: "call-lookup-report",
    name: "lookup_report",
    input: { reportId: "report-2026-08" },
    output: { found: true },
  }]);
  assert.deepEqual(result.approvalRequests, []);
});

test("createAgentRunResult extracts manual approval requests", () => {
  const result = createAgentRunResult(
    createPrepared(),
    "",
    [{
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-send-report",
          toolName: "send_report",
          input: { recipient: "team@example.com" },
        },
        {
          type: "tool-approval-request",
          approvalId: "approval-send-report",
          toolCallId: "call-send-report",
        },
      ],
    }],
    [],
    [],
    [{
      type: "tool-approval-request",
      approvalId: "approval-send-report",
      isAutomatic: false,
      toolCall: {
        toolCallId: "call-send-report",
        toolName: "send_report",
        input: { recipient: "team@example.com" },
      },
    }],
    1,
  );

  assert.deepEqual(result.approvalRequests, [{
    approvalId: "approval-send-report",
    toolCall: {
      toolCallId: "call-send-report",
      name: "send_report",
      input: { recipient: "team@example.com" },
    },
  }]);
});
