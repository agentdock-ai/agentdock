import assert from "node:assert/strict";
import { test } from "vitest";
import { FakeToolCallingModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import {
  createAgentReducerState,
  reduceAgentEvent,
} from "@agentdock/contracts";
import { AgentDock, AgentEventType, ToolRegistry } from "../../src/index.js";
import {
  createToolCallArgumentChunks,
  createScriptedChatModel,
  createScriptedMessageChunks,
} from "../helpers/stream-fixtures.mjs";

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

function contentText(content) {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function messageToolResults(message) {
  return message.content.flatMap((part) =>
    part.type === "tool-result" ? [part.result] : [],
  );
}

function createAgent(toolCalls, registry = new ToolRegistry()) {
  return new AgentDock({
    model: new FakeToolCallingModel({ toolCalls }),
    registry,
    defaults: { maxSteps: 4 },
  });
}

test.each([
  ["identical chunks", ["same", "same", "same"], "samesamesame"],
  ["repeated spaces", ["a", " ", " ", "b"], "a  b"],
  ["repeated punctuation", ["!", "!", "!"], "!!!"],
  ["repeated words", ["go ", "go ", "go"], "go go go"],
  ["unicode", ["你", "你", "👋"], "你你👋"],
  ["empty chunks", ["", "hello", "", " world"], "hello world"],
])(
  "preserves every streamed text delta for %s",
  async (_label, chunks, expected) => {
    const agent = new AgentDock({
      model: createScriptedChatModel({
        chunks: createScriptedMessageChunks(chunks, { includeIds: false }),
        response: expected,
      }),
    });
    const streamed = await agent.stream(
      "Stream this answer.",
      {},
      { sessionId: `session-stream-${_label}`, runId: `run-stream-${_label}` },
    );
    const events = await collect(streamed.stream);
    const result = await streamed.result;

    assert.equal(result.status, "completed");
    assert.equal(contentText(result.content), expected);
    assert.equal(
      events
        .filter((event) => event.type === AgentEventType.MessagePartDelta)
        .map((event) => event.part.text)
        .join(""),
      expected,
    );
    assert.equal(
      new Set(
        events
          .filter((event) => event.type === AgentEventType.MessagePartDelta)
          .map((event) => event.messageId),
      ).size,
      1,
    );
  },
);

test("streams structured reasoning and text without flattening either part", async () => {
  const agent = new AgentDock({
    model: createScriptedChatModel({
      chunks: createScriptedMessageChunks(
        [
          [{ type: "reasoning", reasoning: "Check the inputs." }],
          [{ type: "text", text: "Final answer." }],
        ],
        { includeIds: false },
      ),
      response: [
        { type: "reasoning", reasoning: "Check the inputs." },
        { type: "text", text: "Final answer." },
      ],
    }),
  });
  const execution = await agent.stream(
    "Use structured output.",
    {},
    { sessionId: "structured-stream", runId: "structured-stream" },
  );
  const eventsPromise = collect(execution.stream);
  const result = await execution.result;
  const events = await eventsPromise;
  const deltas = events
    .filter((event) => event.type === AgentEventType.MessagePartDelta)
    .map((event) => event.part);
  const completed = events.find(
    (event) => event.type === AgentEventType.MessageCompleted,
  );

  assert.deepEqual(deltas, [
    { type: "reasoning", text: "Check the inputs." },
    { type: "text", text: "Final answer." },
  ]);
  assert.deepEqual(result.content, [
    { type: "reasoning", text: "Check the inputs." },
    { type: "text", text: "Final answer." },
  ]);
  assert.deepEqual(completed.content, result.content);
  await agent.close();
});

test("does not publish a partial tool call before its final arguments are available", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "lookup_weather",
    description: "Look up weather.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    execute: async ({ input }) => {
      executions += 1;
      return { city: input.city, forecast: "sunny" };
    },
  });
  const model = createScriptedChatModel({
    streamSequences: [
      createToolCallArgumentChunks({
        name: "lookup_weather",
        toolCallId: "call-partial",
        input: { city: "Lahore" },
        chunkCount: 3,
      }),
      [],
    ],
    responses: ["", "The weather is sunny."],
  });
  const agent = new AgentDock({ model, registry, defaults: { maxSteps: 2 } });

  const streamed = await agent.stream(
    "What is the weather?",
    {},
    { sessionId: "session-partial-tool", runId: "run-partial-tool" },
  );
  const events = await collect(streamed.stream);
  const result = await streamed.result;

  const called = events.filter(
    (event) => event.type === AgentEventType.ToolCalled,
  );
  assert.equal(called.length, 1);
  assert.deepEqual(called[0].toolCall.input, { city: "Lahore" });
  assert.equal(executions, 1);
  assert.equal(result.toolCalls[0].toolCallId, "call-partial");
});

test("keeps multiple anonymous assistant messages distinct", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "anonymous_lookup",
    description: "Return one value.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    execute: async ({ input }) => input.value,
  });
  const agent = new AgentDock({
    model: createScriptedChatModel({
      streamSequences: [
        createToolCallArgumentChunks({
          name: "anonymous_lookup",
          toolCallId: "call-anonymous",
          input: { value: "done" },
        }),
        createScriptedMessageChunks(["Final", " answer."], {
          includeIds: false,
        }),
      ],
      responses: ["", "Final answer."],
    }),
    registry,
  });

  const execution = await agent.stream(
    "Run the lookup.",
    {},
    { sessionId: "anonymous-messages", runId: "anonymous-messages" },
  );
  const eventsPromise = collect(execution.stream);
  const result = await execution.result;
  const events = await eventsPromise;
  const completedMessages = events.filter(
    (event) => event.type === AgentEventType.MessageCompleted,
  );

  assert.equal(result.status, "completed");
  assert.equal(contentText(result.content), "Final answer.");
  assert.equal(completedMessages.length, 2);
  assert.equal(
    new Set(completedMessages.map((event) => event.messageId)).size,
    2,
  );
  assert.equal(completedMessages[0].content[0].type, "tool-call");
  assert.deepEqual(completedMessages[1].content, [
    { type: "text", text: "Final answer." },
  ]);
  await agent.close();
});

test("run and stream return the same normalized final assistant content", async () => {
  const chunks = ["Hello", " ", "world", "!"];
  const create = () =>
    new AgentDock({
      model: createScriptedChatModel({
        chunks: createScriptedMessageChunks(chunks, { includeIds: false }),
        response: "Hello world!",
      }),
    });
  const streamed = await create().stream(
    "Say hello.",
    {},
    {
      sessionId: "session-stream-equivalence",
      runId: "run-stream-equivalence",
    },
  );
  await collect(streamed.stream);
  const streamResult = await streamed.result;
  const runResult = await create().run(
    "Say hello.",
    {},
    { sessionId: "session-run-equivalence", runId: "run-run-equivalence" },
  );

  assert.deepEqual(streamResult.content, runResult.content);
  assert.deepEqual(
    streamResult.messages.map((message) => [message.role, message.content]),
    runResult.messages.map((message) => [message.role, message.content]),
  );
});

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
  assert.equal(contentText(result.content), "Summarize this request.");
  assert.equal(events[0].type, AgentEventType.RunStarted);
  assert.equal(events.at(-1).type, AgentEventType.RunCompleted);
  assert.equal(events[0].sessionId, "session-stream");
  assert.ok(
    events.some((event) => event.type === AgentEventType.MessagePartDelta),
  );
  assert.ok(
    events.some((event) => event.type === AgentEventType.MessageCompleted),
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1),
  );
  assert.deepEqual(
    session.messages.map((message) => contentText(message.content)),
    ["Summarize this request.", "Summarize this request."],
  );
});

test("separate runs in one session keep independent result snapshots", async () => {
  const agent = new AgentDock({
    model: createScriptedChatModel({
      streamSequences: [
        createScriptedMessageChunks(["First run."], {
          id: "independent-assistant-one",
        }),
        createScriptedMessageChunks(["Second run."], {
          id: "independent-assistant-two",
        }),
      ],
    }),
  });
  const first = await agent.run(
    "First run.",
    {},
    { sessionId: "shared-session-runs", runId: "independent-run-one" },
  );
  const second = await agent.run(
    "Second run.",
    {},
    { sessionId: "shared-session-runs", runId: "independent-run-two" },
  );
  const session = await agent.getSession("shared-session-runs");
  const history = await agent.getSessionHistory("shared-session-runs");

  assert.equal(first.runId, "independent-run-one");
  assert.equal(second.runId, "independent-run-two");
  assert.deepEqual(
    first.messages.map((message) => contentText(message.content)),
    ["First run.", "First run."],
  );
  assert.deepEqual(
    second.messages.map((message) => contentText(message.content)),
    ["Second run.", "Second run."],
  );
  assert.deepEqual(
    session.messages.map((message) => contentText(message.content)),
    ["First run.", "First run.", "Second run.", "Second run."],
  );
  assert.ok(
    history.checkpoints.some(
      (checkpoint) => checkpoint.runId === "independent-run-one",
    ),
  );
  assert.ok(
    history.checkpoints.some(
      (checkpoint) => checkpoint.runId === "independent-run-two",
    ),
  );
  await agent.close();
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
  assert.equal(contentText(result.content), "Use the tool-calling workflow.");
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
  assert.ok(
    events.some((event) => event.type === AgentEventType.ToolCompleted),
  );
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

test("AgentDock resumes multiple sequential approval boundaries", async () => {
  const registry = new ToolRegistry();
  const executions = [];
  for (const name of ["first_action", "second_action"]) {
    registry.register({
      name,
      description: `${name} requires approval.`,
      parameters: { type: "object", properties: {} },
      requiresApproval: true,
      execute: async () => {
        executions.push(name);
        return `${name} done`;
      },
    });
  }
  const agent = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{ name: "first_action", args: {}, id: "call-first" }],
        [{ name: "second_action", args: {}, id: "call-second" }],
        [],
      ],
    }),
    registry,
  });

  const firstWaiting = await agent.run(
    "Run both actions.",
    {},
    {
      sessionId: "session-sequential-approval",
      runId: "run-sequential-approval",
    },
  );
  assert.deepEqual(
    firstWaiting.approvalRequests.map((request) => request.approvalId),
    ["call-first"],
  );

  const secondWaiting = await agent.resume(
    {
      runId: "run-sequential-approval",
      approvals: [{ approvalId: "call-first", approved: true }],
    },
    {},
    { sessionId: "session-sequential-approval" },
  );
  assert.equal(secondWaiting.status, "waiting_for_approval");
  assert.equal(secondWaiting.stepsCompleted, 2);
  assert.deepEqual(
    secondWaiting.approvalRequests.map((request) => request.approvalId),
    ["call-second"],
  );

  await assert.rejects(
    agent.resume(
      {
        runId: "run-sequential-approval",
        approvals: [{ approvalId: "call-first", approved: true }],
      },
      {},
      { sessionId: "session-sequential-approval" },
    ),
    /do not match a pending AgentDock run/,
  );

  const completed = await agent.resume(
    {
      runId: "run-sequential-approval",
      approvals: [{ approvalId: "call-second", approved: true }],
    },
    {},
    { sessionId: "session-sequential-approval" },
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.stepsCompleted, 3);
  assert.deepEqual(executions, ["first_action", "second_action"]);
  assert.deepEqual(
    completed.toolCalls.map((toolCall) => toolCall.toolCallId),
    ["call-first", "call-second"],
  );
  assert.deepEqual(
    completed.toolResults.map((result) => result.toolCallId),
    ["call-first", "call-second"],
  );
});

test("approval resume events reduce as one logical run without replaying tool calls", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "publish_once",
    description: "Publish once.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    execute: async () => "published",
  });
  const agent = createAgent(
    [[{ name: "publish_once", args: {}, id: "call-publish-once" }], []],
    registry,
  );

  const first = await agent.stream(
    "Publish once.",
    {},
    { sessionId: "session-reducer-resume", runId: "run-reducer-resume" },
  );
  const firstEvents = await collect(first.stream);
  const waiting = await first.result;
  const required = firstEvents.find(
    (event) => event.type === AgentEventType.InterruptRequired,
  );

  const second = await agent.resumeStream(
    {
      runId: waiting.runId,
      approvals: [{ approvalId: "call-publish-once", approved: true }],
    },
    {},
    { sessionId: "session-reducer-resume" },
  );
  const secondEvents = await collect(second.stream);
  await second.result;
  const resolved = secondEvents.find(
    (event) => event.type === AgentEventType.InterruptResolved,
  );
  const allEvents = [...firstEvents, ...secondEvents];
  const reduced = allEvents.reduce(reduceAgentEvent, createAgentReducerState());

  assert.equal(reduced.status, "completed");
  assert.equal(required.interrupt.interruptId, resolved.interruptId);
  assert.equal(
    allEvents.filter(
      (event) =>
        event.type === AgentEventType.ToolCalled &&
        event.toolCall.toolCallId === "call-publish-once",
    ).length,
    1,
  );
  await agent.close();
});

test("AgentDock resumes three approval boundaries after recreating the runtime", async () => {
  const checkpointer = new MemorySaver();
  const registry = new ToolRegistry();
  const executions = [];
  const calls = ["call-one", "call-two", "call-three"];
  for (const name of ["one", "two", "three"]) {
    registry.register({
      name: `step_${name}`,
      description: `Step ${name}.`,
      parameters: { type: "object", properties: {} },
      requiresApproval: true,
      execute: async () => {
        executions.push(name);
        return `${name} complete`;
      },
    });
  }

  const createPhaseAgent = (toolCalls) =>
    new AgentDock({
      model: new FakeToolCallingModel({ toolCalls }),
      registry,
      checkpointer,
    });

  const first = await createPhaseAgent([
    [{ name: "step_one", args: {}, id: calls[0] }],
  ]).run(
    "Run all steps.",
    {},
    { sessionId: "session-three-boundaries", runId: "run-three-boundaries" },
  );
  assert.deepEqual(
    first.approvalRequests.map((request) => request.approvalId),
    [calls[0]],
  );

  const second = await createPhaseAgent([
    [{ name: "step_two", args: {}, id: calls[1] }],
  ]).resume(
    {
      runId: "run-three-boundaries",
      approvals: [{ approvalId: calls[0], approved: true }],
    },
    {},
    { sessionId: "session-three-boundaries" },
  );
  assert.deepEqual(
    second.approvalRequests.map((request) => request.approvalId),
    [calls[1]],
  );

  const third = await createPhaseAgent([
    [{ name: "step_three", args: {}, id: calls[2] }],
  ]).resume(
    {
      runId: "run-three-boundaries",
      approvals: [{ approvalId: calls[1], approved: true }],
    },
    {},
    { sessionId: "session-three-boundaries" },
  );
  assert.deepEqual(
    third.approvalRequests.map((request) => request.approvalId),
    [calls[2]],
  );

  const completed = await createPhaseAgent([[]]).resume(
    {
      runId: "run-three-boundaries",
      approvals: [{ approvalId: calls[2], approved: true }],
    },
    {},
    { sessionId: "session-three-boundaries" },
  );

  assert.equal(completed.status, "completed");
  assert.deepEqual(executions, ["one", "two", "three"]);
  assert.deepEqual(completed.approvalRequests, []);
});

test("AgentDock keeps a checkpointed approval bound to its finalized call after registry changes", async () => {
  const checkpointer = new MemorySaver();
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "mutable_action",
    description: "An action whose policy changes after pausing.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    execute: async () => {
      executions += 1;
      return "done";
    },
  });
  const first = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [[{ name: "mutable_action", args: {}, id: "call-mutable" }]],
    }),
    registry,
    checkpointer,
  });
  const waiting = await first.run(
    "Run the mutable action.",
    {},
    { sessionId: "session-mutable-approval", runId: "run-mutable-approval" },
  );

  registry.clear();
  registry.register({
    name: "mutable_action",
    description: "The same action has updated metadata.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    execute: async () => {
      executions += 1;
      return "done after metadata change";
    },
  });
  const resumed = await new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    registry,
    checkpointer,
  }).resume(
    {
      runId: "run-mutable-approval",
      approvals: [
        { approvalId: waiting.approvalRequests[0].approvalId, approved: true },
      ],
    },
    {},
    { sessionId: "session-mutable-approval" },
  );

  assert.equal(resumed.status, "completed");
  assert.equal(executions, 1);
});

test("logical cancellation preserves activity from an earlier approval phase", async () => {
  const registry = new ToolRegistry();
  let secondStarted;
  const secondStartedPromise = new Promise((resolve) => {
    secondStarted = resolve;
  });
  registry.register({
    name: "approved_first",
    description: "First approved action.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    execute: async () => "first complete",
  });
  registry.register({
    name: "cancelled_second",
    description: "Second action that waits for cancellation.",
    parameters: { type: "object", properties: {} },
    execute: async ({ signal }) => {
      secondStarted();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return resolve;
    },
  });
  const agent = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{ name: "approved_first", args: {}, id: "call-approved-first" }],
        [{ name: "cancelled_second", args: {}, id: "call-cancelled-second" }],
      ],
    }),
    registry,
  });

  const waiting = await agent.run(
    "Run both actions.",
    {},
    {
      sessionId: "session-cancel-after-approval",
      runId: "run-cancel-after-approval",
    },
  );
  const resumed = await agent.resumeStream(
    {
      runId: "run-cancel-after-approval",
      approvals: [{ approvalId: "call-approved-first", approved: true }],
    },
    {},
    { sessionId: "session-cancel-after-approval" },
  );
  await secondStartedPromise;
  assert.equal(await agent.stop("run-cancel-after-approval"), true);
  await collect(resumed.stream);
  const cancelled = await resumed.result;

  assert.equal(waiting.status, "waiting_for_approval");
  assert.equal(cancelled.status, "cancelled");
  assert.ok(
    cancelled.toolResults.some(
      (result) => result.toolCallId === "call-approved-first",
    ),
  );
  assert.ok(
    cancelled.messages.some(
      (message) =>
        message.role === "tool" &&
        messageToolResults(message)[0]?.output === "first complete",
    ),
  );
});

test("session reconstruction preserves structured output while waiting for a later approval", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "structured_first",
    description: "Return structured data.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ city: "Lahore", forecast: "sunny" }),
  });
  registry.register({
    name: "approved_second",
    description: "Require approval after structured output.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    execute: async () => "second complete",
  });
  const agent = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{ name: "structured_first", args: {}, id: "call-structured-first" }],
        [{ name: "approved_second", args: {}, id: "call-approved-second" }],
      ],
    }),
    registry,
  });

  const waiting = await agent.run(
    "Return weather and then publish it.",
    {},
    {
      sessionId: "session-structured-waiting",
      runId: "run-structured-waiting",
    },
  );
  const session = await agent.getSession("session-structured-waiting");
  const toolMessage = session.messages.find(
    (message) =>
      message.role === "tool" &&
      messageToolResults(message)[0]?.toolCallId === "call-structured-first",
  );

  assert.equal(waiting.status, "waiting_for_approval");
  assert.deepEqual(messageToolResults(toolMessage)[0].output, {
    city: "Lahore",
    forecast: "sunny",
  });
});

test("logical resume preserves earlier results when a later tool fails", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "successful_first",
    description: "Return a successful first result.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    execute: async () => "first result",
  });
  registry.register({
    name: "failing_second",
    description: "Fail after the approval phase.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("second tool failed");
    },
  });
  const agent = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{ name: "successful_first", args: {}, id: "call-successful-first" }],
        [{ name: "failing_second", args: {}, id: "call-failing-second" }],
        [],
      ],
    }),
    registry,
  });

  await agent.run(
    "Run and preserve both outcomes.",
    {},
    { sessionId: "session-logical-error", runId: "run-logical-error" },
  );
  const result = await agent.resume(
    {
      runId: "run-logical-error",
      approvals: [{ approvalId: "call-successful-first", approved: true }],
    },
    {},
    { sessionId: "session-logical-error" },
  );

  assert.equal(result.status, "completed");
  assert.ok(
    result.toolResults.some(
      (toolResult) => toolResult.toolCallId === "call-successful-first",
    ),
  );
  assert.ok(
    result.toolErrors.some(
      (toolError) =>
        toolError.toolCallId === "call-failing-second" &&
        toolError.error === "second tool failed",
    ),
  );
  assert.ok(result.messages.some((message) => message.role === "tool"));
});

test("AgentDock keeps logical event ordering across an approval restart", async () => {
  const checkpointer = new MemorySaver();
  const registry = new ToolRegistry();
  registry.register({
    name: "publish_once",
    description: "Publish once.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    execute: async () => "published",
  });
  const firstAgent = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{ name: "publish_once", args: {}, id: "call-publish-once" }],
      ],
    }),
    registry,
    checkpointer,
  });

  const first = await firstAgent.stream(
    "Publish once.",
    {},
    { sessionId: "session-event-order", runId: "run-event-order" },
  );
  const firstEventsPromise = collect(first.stream);
  const waiting = await first.result;
  const firstEvents = await firstEventsPromise;
  await firstAgent.close();

  const secondAgent = new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    registry,
    checkpointer,
  });
  const second = await secondAgent.resumeStream(
    {
      runId: "run-event-order",
      approvals: [
        { approvalId: waiting.approvalRequests[0].approvalId, approved: true },
      ],
    },
    {},
    { sessionId: "session-event-order" },
  );
  const secondEventsPromise = collect(second.stream);
  await second.result;
  const secondEvents = await secondEventsPromise;

  assert.ok(firstEvents.length > 0);
  assert.ok(secondEvents.length > 0);
  assert.ok(
    secondEvents[0].logicalSequence > firstEvents.at(-1).logicalSequence,
  );
  await secondAgent.close();
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
  assert.deepEqual(Object.keys(result.toolResults[0]).sort(), [
    "input",
    "isError",
    "name",
    "output",
    "toolCallId",
  ]);
  assert.ok(events.some((event) => event.type === AgentEventType.ToolFailed));
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
  let observedAbort = false;
  registry.register({
    name: "slow_tool",
    description: "Never completes before its timeout.",
    parameters: { type: "object", properties: {} },
    execute: async ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            reject(signal.reason);
          },
          { once: true },
        );
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
  assert.equal(observedAbort, true);
  assert.equal(result.toolErrors.length, 1);
  assert.equal(result.toolErrors[0].code, "tool_timeout");
  assert.equal(
    result.toolResults.filter(
      (toolResult) => toolResult.toolCallId === "call-timeout",
    ).length,
    1,
  );
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
