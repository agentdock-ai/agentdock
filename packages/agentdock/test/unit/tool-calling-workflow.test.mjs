import assert from "node:assert/strict";
import { test } from "vitest";
import { FakeToolCallingModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { AgentDock, AgentEventType, ToolRegistry } from "../../src/index.js";

class InitializationScopedSaver extends MemorySaver {
  expectedOwner = null;
  activeOwner = null;

  getTuple(...args) {
    this.assertInitialized();
    return super.getTuple(...args);
  }

  put(...args) {
    this.assertInitialized();
    return super.put(...args);
  }

  putWrites(...args) {
    this.assertInitialized();
    return super.putWrites(...args);
  }

  assertInitialized() {
    if (this.expectedOwner !== this.activeOwner) {
      throw new Error("Checkpoint adapter was not initialized.");
    }
  }
}

class InitializationScopedCheckpoint {
  constructor(saver) {
    this.saver = saver;
    this.owner = Symbol("checkpoint-owner");
    saver.expectedOwner = this.owner;
  }

  initialize() {
    this.saver.activeOwner = this.owner;
    return Promise.resolve();
  }

  close() {
    return Promise.resolve();
  }
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function createAgent(toolCalls, registry = new ToolRegistry()) {
  return new AgentDock({
    model: new FakeToolCallingModel({ toolCalls }),
    registry,
    defaults: { maxSteps: 4 },
  });
}

test("AgentDock streams the default tool-calling workflow and persists session memory in checkpoints", async () => {
  const agent = createAgent([[]]);
  const streamed = await agent.stream(
    "Summarize this request.",
    { userId: "user-1" },
    { sessionId: "session-stream", runId: "run-stream" },
  );
  const events = await collect(streamed.stream);
  const result = await streamed.result;
  const session = await agent.getSession("session-stream");

  assert.equal(result.status, "completed");
  assert.equal(result.content, "Summarize this request.");
  assert.equal(events[0].type, AgentEventType.RunStarted);
  assert.equal(events.at(-1).type, AgentEventType.RunCompleted);
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1),
  );
  assert.deepEqual(
    session.messages.map((message) => message.content),
    ["Summarize this request.", "Summarize this request."],
  );
});

test("AgentDock exposes the default workflow through toolCalling", async () => {
  const agent = createAgent([[]]);
  const streamed = await agent.toolCalling.stream(
    "Use the tool-calling workflow.",
    {},
    { sessionId: "session-tool-calling", runId: "run-tool-calling" },
  );

  await collect(streamed.stream);
  const result = await streamed.result;

  assert.equal(result.status, "completed");
  assert.equal(result.content, "Use the tool-calling workflow.");
});

test("AgentDock executes tool-calling tools through the shared registry and context", async () => {
  const registry = new ToolRegistry();
  let received = null;
  registry.register({
    name: "lookup_weather",
    description: "Look up weather by city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    execute: async ({ input, ctx }) => {
      received = { input, ctx };
      return { forecast: "sunny" };
    },
  });
  const agent = createAgent(
    [
      [
        {
          name: "lookup_weather",
          args: { city: "Lahore" },
          id: "call-weather",
        },
      ],
      [],
    ],
    registry,
  );

  const streamed = await agent.stream(
    "What is the weather?",
    { userId: "user-weather" },
    {
      sessionId: "session-weather",
      runId: "run-weather",
    },
  );
  const events = await collect(streamed.stream);
  const result = await streamed.result;

  assert.deepEqual(received, {
    input: { city: "Lahore" },
    ctx: { userId: "user-weather" },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.toolCalls, [
    {
      toolCallId: "call-weather",
      name: "lookup_weather",
      input: { city: "Lahore" },
    },
  ]);
  assert.deepEqual(result.toolResults[0].output, { forecast: "sunny" });
  assert.ok(events.some((event) => event.type === AgentEventType.ToolCalled));
  assert.ok(events.some((event) => event.type === AgentEventType.ToolResult));
});

test("AgentDock pauses approved tools in a LangGraph checkpoint and resumes once", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "publish_report",
    description: "Publish a report.",
    parameters: {
      type: "object",
      properties: { reportId: { type: "string" } },
      required: ["reportId"],
      additionalProperties: false,
    },
    requiresApproval: true,
    execute: async () => {
      executions += 1;
      return "published";
    },
  });
  const agent = createAgent(
    [
      [
        {
          name: "publish_report",
          args: { reportId: "report-1" },
          id: "call-publish",
        },
      ],
      [],
    ],
    registry,
  );

  const waiting = await agent.run(
    "Publish the report.",
    { userId: "user-publish" },
    { sessionId: "session-publish", runId: "run-publish" },
  );

  assert.equal(waiting.status, "waiting_for_approval");
  assert.equal(waiting.approvalRequests[0].approvalId, "call-publish");
  assert.equal(executions, 0);

  const resumed = await agent.resume(
    {
      runId: "run-publish",
      approvals: [{ approvalId: "call-publish", approved: true }],
    },
    { userId: "user-publish" },
    { sessionId: "session-publish" },
  );

  assert.equal(resumed.status, "completed");
  assert.equal(executions, 1);
  assert.equal(resumed.toolResults[0].output, "published");
});

test("AgentDock resumes a checkpoint from a recreated instance", async () => {
  const checkpointer = new InitializationScopedSaver();
  const firstCheckpoint = new InitializationScopedCheckpoint(checkpointer);
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "send_message",
    description: "Send a message.",
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    requiresApproval: true,
    execute: async () => {
      executions += 1;
      return "sent";
    },
  });
  const firstDock = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{ name: "send_message", args: { message: "Hello" }, id: "call-send" }],
      ],
    }),
    registry,
    checkpoint: firstCheckpoint,
  });
  const waiting = await firstDock.run(
    "Send the message.",
    {},
    { sessionId: "session-recreated", runId: "run-recreated" },
  );
  const resumedCheckpoint = new InitializationScopedCheckpoint(checkpointer);
  const resumedDock = new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    registry,
    checkpoint: resumedCheckpoint,
  });

  const resumed = await resumedDock.resume(
    {
      runId: "run-recreated",
      approvals: [
        { approvalId: waiting.approvalRequests[0].approvalId, approved: true },
      ],
    },
    {},
    { sessionId: "session-recreated" },
  );

  assert.equal(resumed.status, "completed");
  assert.equal(executions, 1);
});

test("AgentDock reports tool exceptions as typed tool errors", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "failing_tool",
    description: "Always fails.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("Tool is unavailable.");
    },
  });
  const agent = createAgent(
    [[{ name: "failing_tool", args: {}, id: "call-failing" }], []],
    registry,
  );

  const streamed = await agent.stream(
    "Run the failing tool.",
    {},
    { sessionId: "session-failing-tool", runId: "run-failing-tool" },
  );
  const events = await collect(streamed.stream);
  const result = await streamed.result;

  assert.equal(result.status, "completed");
  assert.equal(result.toolErrors[0].error, "Tool is unavailable.");
  assert.equal(result.toolResults[0].isError, true);
  assert.ok(events.some((event) => event.type === AgentEventType.ToolError));
});

test("AgentDock reports authorization denial as a typed tool error", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "restricted_tool",
    description: "A tool the current user may not run.",
    parameters: { type: "object", properties: {} },
    authorize: () => ({
      allowed: false,
      reason: "Current user is not authorized.",
    }),
    execute: async () => {
      executions += 1;
      return "unreachable";
    },
  });
  const agent = createAgent(
    [[{ name: "restricted_tool", args: {}, id: "call-restricted" }], []],
    registry,
  );

  const result = await agent.run(
    "Run the restricted tool.",
    {},
    {
      sessionId: "session-authorization",
      runId: "run-authorization",
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(executions, 0);
  assert.equal(result.toolErrors[0].error, "Current user is not authorized.");
});

test("AgentDock validates public runtime input before starting a model call", async () => {
  const model = new FakeToolCallingModel({ toolCalls: [[]] });
  const agent = new AgentDock({ model });

  await assert.rejects(
    agent.stream("", {}, { sessionId: "session-invalid-prompt" }),
    /Agent prompt must be a non-empty string/,
  );
  await assert.rejects(
    agent.stream("Valid prompt", {}, { sessionId: " " }),
    /Agent session ID must be a non-empty string/,
  );
  await assert.rejects(
    agent.stream("Valid prompt", [], { sessionId: "session-invalid-context" }),
    /Agent context must be an object/,
  );
  await assert.rejects(
    agent.stream(
      "Valid prompt",
      {},
      { sessionId: "session-invalid-steps", maxSteps: 0 },
    ),
    /Agent maxSteps must be a positive integer/,
  );
  assert.equal(model.index, 0);
});

test("AgentDock rejects an approval without running the protected tool", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "delete_report",
    description: "Delete a report.",
    parameters: {
      type: "object",
      properties: { reportId: { type: "string" } },
      required: ["reportId"],
      additionalProperties: false,
    },
    requiresApproval: true,
    execute: async () => {
      executions += 1;
      return "deleted";
    },
  });
  const agent = createAgent(
    [
      [
        {
          name: "delete_report",
          args: { reportId: "report-1" },
          id: "call-delete",
        },
      ],
      [],
    ],
    registry,
  );

  const waiting = await agent.run(
    "Delete the report.",
    {},
    { sessionId: "session-rejected", runId: "run-rejected" },
  );
  const rejected = await agent.resume(
    {
      runId: "run-rejected",
      approvals: [
        { approvalId: "call-delete", approved: false, reason: "Not allowed." },
      ],
    },
    {},
    { sessionId: "session-rejected" },
  );

  assert.equal(waiting.status, "waiting_for_approval");
  assert.equal(rejected.status, "completed");
  assert.equal(executions, 0);
});

test("AgentDock validates approval decisions at runtime", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "protected_tool",
    description: "A protected tool.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    execute: async () => {
      executions += 1;
      return "done";
    },
  });
  const agent = createAgent(
    [[{ name: "protected_tool", args: {}, id: "call-protected" }], []],
    registry,
  );
  await agent.run(
    "Run the protected tool.",
    {},
    {
      sessionId: "session-invalid-approval",
      runId: "run-invalid-approval",
    },
  );

  await assert.rejects(
    agent.resume(
      {
        runId: "run-invalid-approval",
        approvals: [{ approvalId: "call-protected", approved: "yes" }],
      },
      {},
      { sessionId: "session-invalid-approval" },
    ),
    /approved must be a boolean/,
  );
  assert.equal(executions, 0);
});

test("AgentDock binds approvals to the checkpointed run and blocks concurrent resumes", async () => {
  const checkpointer = new MemorySaver();
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "send_invoice",
    description: "Send an invoice.",
    parameters: {
      type: "object",
      properties: { invoiceId: { type: "string" } },
      required: ["invoiceId"],
      additionalProperties: false,
    },
    requiresApproval: true,
    execute: async () => {
      executions += 1;
      return "sent";
    },
  });
  const agent = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: "send_invoice",
            args: { invoiceId: "invoice-1" },
            id: "call-invoice",
          },
        ],
        [],
      ],
    }),
    registry,
    checkpointer,
  });
  await agent.run(
    "Send the invoice.",
    {},
    {
      sessionId: "session-run-binding",
      runId: "run-bound",
    },
  );
  const restartedAgent = new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    registry,
    checkpointer,
  });

  await assert.rejects(
    restartedAgent.resume(
      {
        runId: "run-other",
        approvals: [{ approvalId: "call-invoice", approved: true }],
      },
      {},
      { sessionId: "session-run-binding" },
    ),
    /does not match the checkpoint/,
  );

  const approved = {
    runId: "run-bound",
    approvals: [{ approvalId: "call-invoice", approved: true }],
  };
  const [first, second] = await Promise.allSettled([
    restartedAgent.resume(approved, {}, { sessionId: "session-run-binding" }),
    restartedAgent.resume(approved, {}, { sessionId: "session-run-binding" }),
  ]);

  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.match(second.reason.message, /already active/);
  assert.equal(executions, 1);
});

test("AgentDock cancels an active tool run", async () => {
  const registry = new ToolRegistry();
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  registry.register({
    name: "wait_for_cancellation",
    description: "Wait until the run is cancelled.",
    parameters: { type: "object", properties: {} },
    execute: async ({ signal }) => {
      notifyStarted();
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return "unreachable";
    },
  });
  const agent = createAgent(
    [[{ name: "wait_for_cancellation", args: {}, id: "call-cancel" }]],
    registry,
  );

  const streamed = await agent.stream(
    "Cancel this run.",
    {},
    {
      sessionId: "session-cancelled",
      runId: "run-cancelled",
    },
  );
  await started;
  assert.equal(await agent.stop("run-cancelled"), true);
  const events = await collect(streamed.stream);
  const result = await streamed.result;

  assert.equal(result.status, "cancelled");
  assert.ok(events.some((event) => event.type === AgentEventType.RunCancelled));
  assert.equal(await agent.stop("run-cancelled"), false);
});

test("AgentDock reports a timed-out tool as a typed tool error", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "slow_tool",
    description: "Never completes before its timeout.",
    parameters: { type: "object", properties: {} },
    execute: async ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  const agent = createAgent(
    [[{ name: "slow_tool", args: {}, id: "call-timeout" }], []],
    registry,
  );

  const result = await agent.run(
    "Run the slow tool.",
    {},
    {
      sessionId: "session-timeout",
      runId: "run-timeout",
      toolTimeout: 10,
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.toolErrors.length, 1);
  assert.equal(result.toolResults[0].isError, true);
});

test("AgentDock enforces the configured model-call limit", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "repeat_tool",
    description: "Return a fixed value.",
    parameters: { type: "object", properties: {} },
    execute: async () => "done",
  });
  const model = new FakeToolCallingModel({
    toolCalls: [
      [{ name: "repeat_tool", args: {}, id: "call-first" }],
      [{ name: "repeat_tool", args: {}, id: "call-second" }],
    ],
  });
  const agent = new AgentDock({ model, registry });

  await agent.run(
    "Use the tool repeatedly.",
    {},
    {
      sessionId: "session-max-steps",
      runId: "run-max-steps",
      maxSteps: 1,
    },
  );

  assert.equal(model.index, 1);
});
