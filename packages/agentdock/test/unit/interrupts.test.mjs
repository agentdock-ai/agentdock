import assert from "node:assert/strict";
import { test } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { collectToolCalls } from "../../src/agent/workflows/tool-calling/message-adapter.js";
import {
  readApprovalInterruptFromCheckpoint,
  readApprovalInterruptFromPayload,
} from "../../src/agent/workflows/tool-calling/interrupts.js";

const finalizedCalls = [
  { toolCallId: "call-first", name: "same_tool", input: { value: 1 } },
  { toolCallId: "call-second", name: "same_tool", input: { value: 1 } },
];

test("reads only the current checkpoint interrupt and preserves action order", () => {
  const interrupt = readApprovalInterruptFromCheckpoint(
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
  const requests = interrupt.requests;

  assert.equal(interrupt.interruptId, "interrupt-current");
  assert.deepEqual(
    requests.map((request) => request.approvalId),
    ["call-first", "call-second"],
  );
  assert.deepEqual(
    requests.map((request) => request.toolCall.input),
    [{ value: 1 }, { value: 1 }],
  );
});

test("the installed LangChain HITL payload has no canonical tool-call identity", () => {
  const payload = {
    __interrupt__: [
      {
        id: "interrupt-identical-calls",
        value: {
          actionRequests: [
            { name: "same_tool", args: { value: 1 } },
            { name: "same_tool", args: { value: 1 } },
          ],
        },
      },
    ],
  };

  assert.deepEqual(payload.__interrupt__[0].value.actionRequests, [
    { name: "same_tool", args: { value: 1 } },
    { name: "same_tool", args: { value: 1 } },
  ]);
  assert.equal("id" in payload.__interrupt__[0].value.actionRequests[0], false);
  assert.equal(
    "toolCallId" in payload.__interrupt__[0].value.actionRequests[0],
    false,
  );

  const requests = readApprovalInterruptFromPayload(
    payload,
    finalizedCalls,
  ).requests;
  assert.deepEqual(
    requests.map((request) => request.toolCall.toolCallId),
    ["call-first", "call-second"],
  );
});

test("uses a canonical action toolCallId without relying on action order", () => {
  const interrupt = readApprovalInterruptFromPayload(
    {
      __interrupt__: [
        {
          id: "interrupt-canonical-ids",
          value: {
            actionRequests: [
              {
                name: "same_tool",
                args: { value: 1 },
                toolCallId: "call-second",
              },
              {
                name: "same_tool",
                args: { value: 1 },
                toolCallId: "call-first",
              },
            ],
          },
        },
      ],
    },
    finalizedCalls,
  );

  assert.deepEqual(
    interrupt.requests.map((request) => request.approvalId),
    ["call-second", "call-first"],
  );
  assert.deepEqual(
    [...interrupt.canonicalToolCallIds],
    ["call-second", "call-first"],
  );
});

test("rejects an invalid canonical action toolCallId", () => {
  assert.throws(
    () =>
      readApprovalInterruptFromPayload(
        {
          __interrupt__: [
            {
              id: "interrupt-invalid-tool-id",
              value: {
                actionRequests: [
                  { name: "same_tool", args: { value: 1 }, toolCallId: "" },
                ],
              },
            },
          ],
        },
        finalizedCalls,
      ),
    /invalid toolCallId/,
  );
});

test("does not silently accept an interrupt action without a finalized call", () => {
  assert.throws(
    () =>
      readApprovalInterruptFromPayload(
        {
          __interrupt__: [
            {
              id: "interrupt-missing",
              value: {
                actionRequests: [{ name: "missing_tool", args: {} }],
              },
            },
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
