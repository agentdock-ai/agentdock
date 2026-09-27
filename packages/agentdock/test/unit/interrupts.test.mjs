import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENTDOCK_APPROVAL_INTERRUPT_PROTOCOL,
  readApprovalInterruptFromCheckpoint,
  readApprovalInterruptFromPayload,
} from "../../src/agent/workflows/tool-calling/interrupts.js";

const finalizedCalls = [
  { toolCallId: "call-first", name: "same_tool", input: { value: 1 } },
  { toolCallId: "call-second", name: "same_tool", input: { value: 1 } },
];

function interruptValue(actions) {
  return {
    agentdockApprovalProtocol: AGENTDOCK_APPROVAL_INTERRUPT_PROTOCOL,
    actionRequests: actions,
  };
}

test("joins same-name, same-input approval actions only by exact toolCallId", () => {
  const interrupt = readApprovalInterruptFromPayload(
    {
      __interrupt__: [
        {
          id: "interrupt-exact-ids",
          value: interruptValue([
            {
              id: "call-second",
              toolCallId: "call-second",
              name: "same_tool",
              args: { value: 1 },
            },
            {
              id: "call-first",
              toolCallId: "call-first",
              name: "same_tool",
              args: { value: 1 },
            },
          ]),
        },
      ],
    },
    finalizedCalls,
  );

  assert.deepEqual(
    interrupt.requests.map(({ approvalId, toolCall }) => [
      approvalId,
      toolCall.toolCallId,
    ]),
    [
      ["call-second", "call-second"],
      ["call-first", "call-first"],
    ],
  );
});

test("reads AgentDock approvals from checkpoint pending writes", () => {
  const interrupt = readApprovalInterruptFromCheckpoint(
    {
      pendingWrites: [
        [
          "task-1",
          "__interrupt__",
          {
            id: "interrupt-checkpoint",
            value: interruptValue([
              {
                id: "call-first",
                toolCallId: "call-first",
                name: "same_tool",
                args: { value: 1 },
              },
            ]),
          },
        ],
      ],
    },
    finalizedCalls,
  );

  assert.equal(interrupt.interruptId, "interrupt-checkpoint");
  assert.equal(interrupt.requests[0].toolCall.toolCallId, "call-first");
});

test("rejects actions that lack an exact toolCallId instead of guessing", () => {
  assert.throws(
    () =>
      readApprovalInterruptFromPayload(
        {
          __interrupt__: [
            {
              id: "interrupt-missing-id",
              value: interruptValue([
                {
                  id: "approval",
                  name: "same_tool",
                  args: { value: 1 },
                },
              ]),
            },
          ],
        },
        finalizedCalls,
      ),
    /without exact tool-call identity/,
  );
});

test("rejects legacy LangChain HITL checkpoints without resuming them", () => {
  assert.throws(
    () =>
      readApprovalInterruptFromCheckpoint(
        {
          tasks: [
            {
              interrupts: [
                {
                  id: "legacy-interrupt",
                  value: {
                    actionRequests: [{ name: "same_tool", args: { value: 1 } }],
                    reviewConfigs: [],
                  },
                },
              ],
            },
          ],
        },
        finalizedCalls,
      ),
    /legacy HITL flow and cannot be resumed/,
  );
});

test("ignores unrelated custom interrupts", () => {
  assert.equal(
    readApprovalInterruptFromPayload(
      {
        __interrupt__: [
          {
            id: "custom-interrupt",
            value: { prompt: "Continue?", actions: [{ name: "continue" }] },
          },
        ],
      },
      finalizedCalls,
    ),
    null,
  );
});
