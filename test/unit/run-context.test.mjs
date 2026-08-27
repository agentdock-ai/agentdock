import assert from "node:assert/strict";
import { test } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import {
  buildModelRequest,
  prepareAgentRunFromHistory,
} from "../../src/agent/runtime/run-context.js";

function createPrepared(registry, permissionMode = "normal") {
  return {
    model: {},
    modelInput: { messages: [] },
    maxSteps: 3,
    permissionMode,
    registry,
    ctx: { userId: "user-123" },
    tools: {},
    onStepStart: () => {},
    onStepFinish: () => {},
  };
}

function createTool(overrides = {}) {
  return {
    name: "send_report",
    description: "Send a report.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ sent: true }),
    ...overrides,
  };
}

async function evaluateApproval(tool, permissionMode = "normal") {
  const registry = new ToolRegistry();
  registry.register(tool);
  const request = buildModelRequest(createPrepared(registry, permissionMode));
  return request.toolApproval({
    toolCall: {
      toolCallId: "call-send-report",
      toolName: tool.name,
      input: { recipient: "team@example.com" },
    },
  });
}

test("prepareAgentRunFromHistory requires a session ID, model, and registry", async () => {
  await assert.rejects(
    prepareAgentRunFromHistory([], {}, { model: {} }, 0),
    /No sessionId configured/,
  );
  await assert.rejects(
    prepareAgentRunFromHistory([], {}, { sessionId: "session-1" }, 0),
    /No model configured/,
  );
  await assert.rejects(
    prepareAgentRunFromHistory([], {}, { sessionId: "session-1", model: {} }, 0),
    /No tool registry configured/,
  );
});

test("prepareAgentRunFromHistory rejects invalid and exhausted step budgets", async () => {
  const options = {
    sessionId: "session-1",
    model: {},
    registry: new ToolRegistry(),
  };

  await assert.rejects(
    prepareAgentRunFromHistory([], {}, { ...options, maxSteps: 0 }, 0),
    /maxSteps/,
  );
  await assert.rejects(
    prepareAgentRunFromHistory([], {}, { ...options, maxSteps: 3 }, 3),
    /maxSteps|steps/i,
  );
});

test("buildModelRequest approves tools that do not require user approval", async () => {
  assert.equal(await evaluateApproval(createTool()), "approved");
});

test("buildModelRequest requests approval for approval-required tools", async () => {
  assert.equal(
    await evaluateApproval(createTool({ requiresApproval: true })),
    "user-approval",
  );
});

test("approve_all bypasses user approval but still runs authorization", async () => {
  assert.equal(
    await evaluateApproval(createTool({ requiresApproval: true }), "approve_all"),
    "approved",
  );
  assert.deepEqual(
    await evaluateApproval(createTool({
      authorize: () => ({ allowed: false, reason: "Recipient is blocked." }),
    }), "approve_all"),
    { type: "denied", reason: "Recipient is blocked." },
  );
});

test("authorization denial and authorization errors deny the tool call", async () => {
  assert.deepEqual(
    await evaluateApproval(createTool({
      authorize: () => ({ allowed: false, reason: "Not permitted." }),
    })),
    { type: "denied", reason: "Not permitted." },
  );
  assert.deepEqual(
    await evaluateApproval(createTool({
      authorize: () => {
        throw new Error("authorization service unavailable");
      },
    })),
    { type: "denied", reason: "Tool authorization check failed" },
  );
});

test("unknown tools are denied", async () => {
  const request = buildModelRequest(createPrepared(new ToolRegistry()));

  assert.deepEqual(
    await request.toolApproval({
      toolCall: {
        toolCallId: "call-unknown",
        toolName: "unknown_tool",
        input: {},
      },
    }),
    { type: "denied", reason: "Unknown tool: unknown_tool" },
  );
});
