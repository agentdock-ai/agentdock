import assert from "node:assert/strict";
import { test } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import {
  GraphInterrupt,
  MemorySaver,
  emptyCheckpoint,
} from "@langchain/langgraph";
import { FakeToolCallingModel } from "langchain";
import {
  AgentCheckpointPersistenceError,
  AgentDock,
  AgentEventType,
  ToolRegistry,
  createThreadId,
} from "../../src/index.js";
import {
  findFinalContent,
  normalizeMessages,
} from "../../src/agent/workflows/tool-calling/message-adapter.js";
import {
  createScriptedChatModel,
  createScriptedMessageChunks,
  createCooperativeTimeoutTool,
} from "../helpers/stream-fixtures.mjs";
import { HumanMessage } from "@langchain/core/messages";

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

class SnapshotSaver extends MemorySaver {
  constructor({ failStatuses = [], abortStatuses = [] } = {}) {
    super();
    this.failStatuses = new Set(failStatuses);
    this.abortStatuses = new Set(abortStatuses);
    this.failGetTuple = false;
    this.persistedSnapshots = [];
  }

  async getTuple(config) {
    if (this.failGetTuple) {
      throw new Error("checkpoint read failed during cancellation");
    }
    return super.getTuple(config);
  }

  async put(config, checkpoint, metadata) {
    const snapshot = checkpoint.channel_values?.agentdockRunSnapshot;
    if (snapshot && this.abortStatuses.has(snapshot.status)) {
      throw new GraphInterrupt([]);
    }
    if (snapshot && this.failStatuses.has(snapshot.status)) {
      throw new Error(`checkpoint write failed for ${snapshot.status}`);
    }
    if (snapshot) this.persistedSnapshots.push(snapshot);
    return super.put(config, checkpoint, metadata);
  }
}

class ThrowingChatModel extends BaseChatModel {
  constructor() {
    super({});
  }

  bindTools() {
    return this;
  }

  _llmType() {
    return "agentdock-throwing-test";
  }

  async _generate() {
    throw new Error("model execution failed");
  }
}

class ProfiledChatModel extends BaseChatModel {
  constructor({ maxInputTokens, response = "primary response", usage } = {}) {
    super({});
    this.maxInputTokens = maxInputTokens;
    this.response = response;
    this.usage = usage;
    this.calls = [];
  }

  get profile() {
    return { maxInputTokens: this.maxInputTokens };
  }

  bindTools() {
    return this;
  }

  _llmType() {
    return "agentdock-protocol-remediation-context";
  }

  async _generate(messages) {
    this.calls.push(messages);
    return {
      generations: [
        {
          message: new AIMessage({
            content: this.response,
            ...(this.usage ? { usage_metadata: this.usage } : {}),
          }),
        },
      ],
    };
  }
}

function longPrompt(label) {
  return `${label}: ${"context ".repeat(250)}`;
}

function terminalEvents(events) {
  return events.filter((event) =>
    [
      AgentEventType.RunCompleted,
      AgentEventType.RunFailed,
      AgentEventType.RunCancelled,
    ].includes(event.type),
  );
}

function completionToolParts(events) {
  return events
    .filter((event) => event.type === AgentEventType.RunCompleted)
    .flatMap((event) => event.content)
    .filter((part) => part.type === "tool-call" || part.type === "tool-result");
}

test("run.completed is observable only after its final snapshot is persisted", async () => {
  const saver = new SnapshotSaver();
  const agent = new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    checkpointer: saver,
  });
  const sessionId = "session-terminal-persistence-order";
  const execution = await agent.stream(
    "Finish successfully.",
    {},
    { sessionId, runId: "run-terminal-persistence-order" },
  );

  let snapshotAtCompletion = null;
  const events = [];
  for await (const event of execution.stream) {
    events.push(event);
    if (event.type === AgentEventType.RunCompleted) {
      snapshotAtCompletion = saver.persistedSnapshots.at(-1) ?? null;
    }
  }
  const result = await execution.result;

  assert.equal(result.status, "completed");
  assert.equal(snapshotAtCompletion?.status, "completed");
  assert.equal(snapshotAtCompletion?.runId, result.runId);
  assert.equal(terminalEvents(events).length, 1);
  await agent.close();
});

test("a final checkpoint failure emits one failed terminal event and never completed", async () => {
  const saver = new SnapshotSaver({ failStatuses: ["completed"] });
  const agent = new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    checkpointer: saver,
  });
  const execution = await agent.stream(
    "The final write will fail.",
    {},
    {
      sessionId: "session-final-write-failure",
      runId: "run-final-write-failure",
    },
  );
  const events = await collect(execution.stream);

  await assert.rejects(
    execution.result,
    (error) =>
      error instanceof AgentCheckpointPersistenceError &&
      error.code === "agent_checkpoint_persistence_failed",
  );
  assert.equal(
    events.filter((event) => event.type === AgentEventType.RunCompleted).length,
    0,
  );
  assert.deepEqual(
    terminalEvents(events).map((event) => event.type),
    [AgentEventType.RunFailed],
  );
  assert.equal(
    terminalEvents(events)[0].code,
    "agent_checkpoint_persistence_failed",
  );
  await agent.close();
});

test("a failed final write does not create a false durable run-history entry", async () => {
  const saver = new SnapshotSaver({ failStatuses: ["completed"] });
  const agent = new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    checkpointer: saver,
  });
  const execution = await agent.stream(
    "The final write will fail.",
    {},
    {
      sessionId: "session-history-final-write-failure",
      runId: "run-history-final-write-failure",
    },
  );
  await collect(execution.stream);
  await assert.rejects(
    execution.result,
    (error) => error instanceof AgentCheckpointPersistenceError,
  );

  const history = await agent.getSessionRunHistory(
    "session-history-final-write-failure",
  );
  assert.deepEqual(history.runs, []);
  await agent.close();
});

test("a later run in one session starts after the prior logical event boundary", async () => {
  const agent = new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[], []] }),
  });
  const first = await agent.stream(
    "First run.",
    {},
    { sessionId: "session-logical-boundary", runId: "run-logical-one" },
  );
  const firstEvents = await collect(first.stream);
  await first.result;

  const second = await agent.stream(
    "Second run.",
    {},
    { sessionId: "session-logical-boundary", runId: "run-logical-two" },
  );
  const secondEvents = await collect(second.stream);
  await second.result;

  assert.ok(
    secondEvents[0].logicalSequence > firstEvents.at(-1).logicalSequence,
  );
  await agent.close();
});

test("a failed run rejects with the execution and checkpoint causes separately", async () => {
  const saver = new SnapshotSaver({ failStatuses: ["failed"] });
  const agent = new AgentDock({
    model: new ThrowingChatModel(),
    checkpointer: saver,
  });
  const execution = await agent.stream(
    "The model will fail.",
    {},
    { sessionId: "session-failed-durability", runId: "run-failed-durability" },
  );
  const events = await collect(execution.stream);

  await assert.rejects(
    execution.result,
    (error) =>
      error instanceof AgentCheckpointPersistenceError &&
      error.code === "agent_checkpoint_persistence_failed" &&
      error.executionCause?.message === "model execution failed" &&
      error.persistenceCause?.message === "checkpoint write failed for failed",
  );
  assert.deepEqual(
    terminalEvents(events).map((event) => event.type),
    [AgentEventType.RunFailed],
  );
  await agent.close();
});

test("the recognized graph-abort checkpoint condition does not mask a failed result", async () => {
  const saver = new SnapshotSaver({ abortStatuses: ["failed"] });
  const agent = new AgentDock({
    model: new ThrowingChatModel(),
    checkpointer: saver,
  });
  const execution = await agent.stream(
    "The model will fail but graph abort is expected.",
    {},
    { sessionId: "session-expected-abort", runId: "run-expected-abort" },
  );
  const events = await collect(execution.stream);
  const result = await execution.result;

  assert.equal(result.status, "failed");
  assert.equal(result.error, "model execution failed");
  assert.equal(terminalEvents(events).length, 1);
  await agent.close();
});

test("cancellation followed by a checkpoint failure rejects without a second terminal event", async () => {
  const saver = new SnapshotSaver({ failStatuses: ["cancelled"] });
  const registry = new ToolRegistry();
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  registry.register({
    name: "wait_for_cancel",
    description: "Wait for cancellation.",
    parameters: { type: "object", properties: {} },
    execute: createCooperativeTimeoutTool({ onStart: started }),
  });
  const agent = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [[{ name: "wait_for_cancel", args: {}, id: "call-cancel" }]],
    }),
    registry,
    checkpointer: saver,
  });
  const execution = await agent.stream(
    "Cancel this run.",
    {},
    { sessionId: "session-cancel-durability", runId: "run-cancel-durability" },
  );
  await startedPromise;
  assert.equal(await agent.stop("run-cancel-durability"), true);
  saver.failGetTuple = true;
  const events = await collect(execution.stream);

  await assert.rejects(
    execution.result,
    (error) =>
      error instanceof AgentCheckpointPersistenceError &&
      error.executionCause?.message === "Agent run cancelled." &&
      error.persistenceCause?.message ===
        "checkpoint read failed during cancellation",
  );
  assert.deepEqual(
    terminalEvents(events).map((event) => event.type),
    [AgentEventType.RunCancelled],
  );
  await agent.close();
});

test("run.completed content contains only the final assistant content", async () => {
  const agent = new AgentDock({
    model: createScriptedChatModel({
      streamSequences: [
        createScriptedMessageChunks(["Final answer."], {
          id: "final-assistant",
        }),
      ],
    }),
  });
  const execution = await agent.stream(
    "Answer without tools.",
    {},
    { sessionId: "session-clean-completion", runId: "run-clean-completion" },
  );
  const events = await collect(execution.stream);
  const result = await execution.result;
  const completed = events.find(
    (event) => event.type === AgentEventType.RunCompleted,
  );

  assert.deepEqual(completed.content, [
    { type: "text", text: "Final answer." },
  ]);
  assert.deepEqual(result.content, completed.content);
  assert.deepEqual(completionToolParts(events), []);
  await agent.close();
});

test("tool lifecycle data stays out of completion content across a tool flow", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "create_file",
    description: "Create a file.",
    parameters: { type: "object", properties: {} },
    execute: async () => "created",
  });
  const agent = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{ name: "create_file", args: {}, id: "call-create-file" }],
        [],
      ],
    }),
    registry,
  });
  const execution = await agent.stream(
    "Create the file and report back.",
    {},
    {
      sessionId: "session-tool-clean-completion",
      runId: "run-tool-clean-completion",
    },
  );
  const events = await collect(execution.stream);
  const result = await execution.result;

  assert.equal(result.status, "completed");
  assert.deepEqual(completionToolParts(events), []);
  assert.ok(events.some((event) => event.type === AgentEventType.ToolCalled));
  assert.ok(
    events.some((event) => event.type === AgentEventType.ToolCompleted),
  );
  await agent.close();
});

test("final content strips tool protocol parts but preserves valid assistant parts", () => {
  const toolCall = {
    toolCallId: "call-final-candidate",
    name: "lookup",
    input: {},
  };
  const toolResult = { ...toolCall, output: "ok" };
  assert.deepEqual(
    findFinalContent([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Final." },
          { type: "tool-result", result: toolResult },
        ],
      },
    ]),
    [{ type: "text", text: "Final." }],
  );
  assert.deepEqual(
    findFinalContent([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCall }],
      },
    ]),
    [],
  );
  assert.deepEqual(
    findFinalContent([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Checked." },
          { type: "image", url: "https://example.test/image.png" },
          { type: "citation", url: "https://example.test/source" },
        ],
      },
    ]),
    [
      { type: "reasoning", text: "Checked." },
      { type: "image", url: "https://example.test/image.png" },
      { type: "citation", url: "https://example.test/source" },
    ],
  );
});

test("public normalization hides only marked context summaries", () => {
  const marked = new HumanMessage({
    content: "Conversation summary:\n\nGenerated facts.",
    additional_kwargs: { agentdock_context_summary: true },
  });
  const unmarked = new HumanMessage({
    content: "Conversation summary: user-authored text.",
  });
  const normalized = normalizeMessages([marked, unmarked], new Map());

  assert.deepEqual(normalized, [
    {
      role: "user",
      content: [
        { type: "text", text: "Conversation summary: user-authored text." },
      ],
    },
  ]);
});

test("context summaries remain in the checkpoint but not public session or checkpoint history", async () => {
  const saver = new MemorySaver();
  const first = new AgentDock({
    model: new ProfiledChatModel({ maxInputTokens: 1_000 }),
    checkpointer: saver,
    contextManagement: {
      summarization: {
        summaryModel: new ProfiledChatModel({
          maxInputTokens: 1_000,
          response: "internal durable facts",
        }),
        trigger: "auto",
      },
    },
  });
  const sessionId = "session-public-summary-filter";
  await first.run(longPrompt("first"), {}, { sessionId });
  await first.run(longPrompt("second"), {}, { sessionId });

  const rawTuples = [];
  for await (const tuple of saver.list({
    configurable: { thread_id: createThreadId(sessionId) },
  })) {
    rawTuples.push(tuple);
  }
  const rawMessages = rawTuples.flatMap(
    (tuple) => tuple.checkpoint.channel_values.messages ?? [],
  );
  assert.ok(
    rawMessages.some(
      (message) =>
        message.additional_kwargs?.agentdock_context_summary === true,
    ),
  );

  const session = await first.getSession(sessionId);
  const history = await first.getSessionHistory(sessionId);
  assert.ok(session);
  assert.doesNotMatch(JSON.stringify(session), /internal durable facts/);
  assert.doesNotMatch(JSON.stringify(history), /internal durable facts/);
  assert.match(JSON.stringify(session), /first|second/);

  const second = new AgentDock({
    model: new ProfiledChatModel({ maxInputTokens: 1_000 }),
    checkpointer: saver,
  });
  const continued = await second.run(longPrompt("third"), {}, { sessionId });
  assert.equal(continued.status, "completed");
  await second.close();
  await first.close();
});

test("durable run history stores one normalized completed run with tool state", async () => {
  const saver = new MemorySaver();
  const registry = new ToolRegistry();
  registry.register({
    name: "lookup",
    description: "Look up a value.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ value: 42 }),
  });
  const agent = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{ name: "lookup", args: {}, id: "call-history-lookup" }],
        [],
      ],
    }),
    registry,
    checkpointer: saver,
  });
  await agent.run(
    "Look up the value.",
    {},
    { sessionId: "session-run-history", runId: "run-history-complete" },
  );

  const history = await agent.getSessionRunHistory("session-run-history");
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].runId, "run-history-complete");
  assert.equal(history.runs[0].status, "completed");
  assert.equal(history.runs[0].toolCalls[0].toolCallId, "call-history-lookup");
  assert.deepEqual(history.runs[0].toolResults[0].output, { value: 42 });
  assert.ok(
    history.runs[0].messages.some((message) => message.role === "tool"),
  );
  await agent.close();
});

test("durable run history preserves transcript, usage, and finish metadata", async () => {
  const agent = new AgentDock({
    model: new ProfiledChatModel({
      maxInputTokens: 1_000,
      response: "Usage-aware answer.",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    }),
  });
  await agent.run(
    "Record this run.",
    {},
    {
      sessionId: "session-run-history-metadata",
      runId: "run-history-metadata",
    },
  );

  const history = await agent.getSessionRunHistory(
    "session-run-history-metadata",
  );
  const [run] = history.runs;
  assert.ok(run.messages.some((message) => message.role === "user"));
  assert.ok(run.messages.some((message) => message.role === "assistant"));
  assert.deepEqual(run.usage, {
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
  });
  assert.equal(run.finishReason, "stop");
  await agent.close();
});

test("legacy checkpoints without normalized run snapshots are ignored", async () => {
  const saver = new MemorySaver();
  const sessionId = "session-legacy-run-history";
  await saver.put(
    { configurable: { thread_id: createThreadId(sessionId) } },
    {
      ...emptyCheckpoint(),
      channel_values: { agentdockRunId: "legacy-run" },
    },
    { source: "input", step: 0, parents: {} },
    {},
  );
  const agent = new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    checkpointer: saver,
  });

  const history = await agent.getSessionRunHistory(sessionId);
  assert.deepEqual(history.runs, []);
  await agent.close();
});

test("durable run history keeps exact waiting approval state across runtime recreation", async () => {
  const saver = new MemorySaver();
  const registry = new ToolRegistry();
  registry.register({
    name: "publish",
    description: "Publish a report.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    execute: async () => "published",
  });
  const first = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [[{ name: "publish", args: {}, id: "call-history-publish" }]],
    }),
    registry,
    checkpointer: saver,
  });
  const waiting = await first.run(
    "Publish it.",
    {},
    { sessionId: "session-history-waiting", runId: "run-history-waiting" },
  );
  assert.equal(waiting.status, "waiting_for_approval");
  await first.close();

  const second = new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    registry,
    checkpointer: saver,
  });
  const history = await second.getSessionRunHistory("session-history-waiting");
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].status, "waiting_for_approval");
  assert.deepEqual(history.runs[0].approvalRequests[0], {
    approvalId: "call-history-publish",
    toolCall: {
      toolCallId: "call-history-publish",
      name: "publish",
      input: {},
    },
  });
  await second.close();
});

test("durable run history records a failed run with its terminal error", async () => {
  const saver = new MemorySaver();
  const agent = new AgentDock({
    model: new ThrowingChatModel(),
    checkpointer: saver,
  });
  const result = await agent.run(
    "Fail this run.",
    {},
    { sessionId: "session-history-failed", runId: "run-history-failed" },
  );

  assert.equal(result.status, "failed");
  const history = await agent.getSessionRunHistory("session-history-failed");
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].status, "failed");
  assert.equal(history.runs[0].errorCode, "agent_execution_failed");
  assert.equal(history.runs[0].error, "model execution failed");
  await agent.close();
});

test("durable run history records a cancelled run with its cancellation reason", async () => {
  const saver = new MemorySaver();
  const registry = new ToolRegistry();
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  registry.register({
    name: "history_wait_for_cancel",
    description: "Wait for cancellation.",
    parameters: { type: "object", properties: {} },
    execute: createCooperativeTimeoutTool({ onStart: started }),
  });
  const agent = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: "history_wait_for_cancel",
            args: {},
            id: "call-history-cancel",
          },
        ],
      ],
    }),
    registry,
    checkpointer: saver,
  });
  const execution = await agent.stream(
    "Cancel this run.",
    {},
    { sessionId: "session-history-cancelled", runId: "run-history-cancelled" },
  );
  await startedPromise;
  assert.equal(await agent.stop("run-history-cancelled"), true);
  await collect(execution.stream);
  const result = await execution.result;

  assert.equal(result.status, "cancelled");
  const history = await agent.getSessionRunHistory("session-history-cancelled");
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].status, "cancelled");
  assert.equal(history.runs[0].cancellationReason, "Agent run cancelled.");
  await agent.close();
});

test("durable run history pagination is chronological and duplicate-free", async () => {
  const saver = new MemorySaver();
  const agent = new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[], [], []] }),
    checkpointer: saver,
  });
  for (const [index, runId] of [
    "run-page-one",
    "run-page-two",
    "run-page-three",
  ].entries()) {
    await agent.run(
      `Run ${index + 1}.`,
      {},
      { sessionId: "session-run-history-pages", runId },
    );
  }

  const firstPage = await agent.getSessionRunHistory(
    "session-run-history-pages",
    {
      limit: 2,
    },
  );
  const secondPage = await agent.getSessionRunHistory(
    "session-run-history-pages",
    {
      limit: 2,
      cursor: firstPage.nextCursor,
    },
  );
  assert.deepEqual(
    firstPage.runs.map((run) => run.runId),
    ["run-page-one", "run-page-two"],
  );
  assert.ok(firstPage.nextCursor);
  assert.notEqual(firstPage.nextCursor, "2");
  assert.deepEqual(
    secondPage.runs.map((run) => run.runId),
    ["run-page-three"],
  );
  assert.equal(secondPage.nextCursor, undefined);
  assert.equal(
    new Set([...firstPage.runs, ...secondPage.runs].map((run) => run.runId))
      .size,
    3,
  );
  await assert.rejects(
    agent.getSessionRunHistory("session-run-history-pages", {
      cursor: "2",
    }),
    /cursor is invalid/,
  );
  await assert.rejects(
    agent.getSessionRunHistory("session-run-history-pages", { limit: 0 }),
    /positive integer/,
  );
  await agent.close();
});
