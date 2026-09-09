import assert from "node:assert/strict";
import { test } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { collectToolCalls } from "../../src/agent/workflows/tool-calling/message-adapter.js";
import {
  readApprovalRequestsFromCheckpoint,
  readApprovalRequestsFromPayload,
} from "../../src/agent/workflows/tool-calling/interrupts.js";

const finalizedCalls = [
  { toolCallId: "call-first", name: "same_tool", input: { value: 1 } },
  { toolCallId: "call-second", name: "same_tool", input: { value: 1 } },
];

test("reads only the current checkpoint interrupt and preserves action order", () => {
  const requests = readApprovalRequestsFromCheckpoint(
    {
      tasks: [
        {
          interrupts: [
            {
              id: "interrupt-current",
              value: {
                actionRequests: [
                  { name: "same_tool", args: { value: 1 } },
                  { name: "same_tool", args: { value: 1 } },
                ],
              },
            },
          ],
        },
      ],
    },
    finalizedCalls,
  );

  assert.deepEqual(
    requests.map((request) => request.approvalId),
    ["call-first", "call-second"],
  );
  assert.deepEqual(
    requests.map((request) => request.toolCall.input),
    [{ value: 1 }, { value: 1 }],
  );
});

test("does not silently accept an interrupt action without a finalized call", () => {
  assert.throws(
    () =>
      readApprovalRequestsFromPayload(
        {
          __interrupt__: [
            { value: { actionRequests: [{ name: "missing_tool", args: {} }] } },
          ],
        },
        [],
      ),
    /unknown finalized tool call: missing_tool/,
  );
});

test("rejects conflicting finalized tool-call records with the same ID", () => {
  assert.throws(
    () =>
      collectToolCalls([
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-conflict", name: "lookup", args: { id: 1 } },
          ],
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-conflict", name: "lookup", args: { id: 2 } },
          ],
        }),
      ]),
    /conflicting finalized tool calls for ID: call-conflict/,
  );
});
