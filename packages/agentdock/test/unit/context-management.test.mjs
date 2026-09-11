import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { SqliteCheckpoint } from "@agentdock/checkpoint-sqlite";
import { AgentDock, ToolRegistry } from "../../src/index.js";
import {
  ContextCapacityError,
  ContextManagement,
} from "../../src/agent/context-management.js";

class ProfiledChatModel extends BaseChatModel {
  constructor({
    maxInputTokens,
    response = "ok",
    responses,
    toolCalls,
    fail = false,
  } = {}) {
    super({});
    this.maxInputTokens = maxInputTokens;
    this.response = response;
    this.responses = responses;
    this.toolCalls = toolCalls ?? [];
    this.toolCallIndex = 0;
    this.fail = fail;
    this.calls = [];
  }

  get profile() {
    return this.maxInputTokens === undefined
      ? {}
      : { maxInputTokens: this.maxInputTokens };
  }

  bindTools() {
    return this;
  }

  _llmType() {
    return "agentdock-context-test";
  }

  async _generate(messages) {
    this.calls.push(messages);
    if (this.fail) throw new Error("summary provider unavailable");
    const response = this.responses?.[this.toolCallIndex] ?? this.response;
    const toolCalls = this.toolCalls[this.toolCallIndex] ?? [];
    this.toolCallIndex += 1;
    return {
      generations: [
        {
          message: new AIMessage({
            content: toolCalls.length > 0 ? "" : response,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          }),
        },
      ],
    };
  }
}

function longPrompt(label) {
  return `${label}: ${"context ".repeat(250)}`;
}

function allText(messages) {
  return messages.map((message) => String(message.content)).join("\n");
}

test("does not call the summary model for a small history", async () => {
  const model = new ProfiledChatModel({ maxInputTokens: 1_000 });
  const summaryModel = new ProfiledChatModel({ maxInputTokens: 500 });
  const dock = new AgentDock({
    model,
    contextManagement: { summarization: { summaryModel, trigger: "auto" } },
  });

  const result = await dock.run(
    "A short question.",
    {},
    { sessionId: "small-context" },
  );

  assert.equal(result.status, "completed");
  assert.equal(summaryModel.calls.length, 0);
  await dock.close();
});

test("uses the primary-model profile for auto compaction, even with a smaller summary model", async () => {
  const model = new ProfiledChatModel({ maxInputTokens: 1_000 });
  const summaryModel = new ProfiledChatModel({
    maxInputTokens: 100,
    response: "durable facts",
  });
  const dock = new AgentDock({
    model,
    contextManagement: { summarization: { summaryModel, trigger: "auto" } },
  });

  await dock.run(longPrompt("first"), {}, { sessionId: "primary-budget" });
  assert.equal(summaryModel.calls.length, 0);

  const result = await dock.run(
    longPrompt("second"),
    {},
    { sessionId: "primary-budget" },
  );

  assert.equal(result.status, "completed");
  assert.equal(summaryModel.calls.length, 1);
  assert.match(
    allText(model.calls.at(-1)),
    /Conversation summary:\n\ndurable facts/,
  );
  await dock.close();
});

test("requires a verified profile only for automatic or fractional policies", async () => {
  const unknown = new ProfiledChatModel();
  assert.throws(
    () =>
      new AgentDock({
        model: unknown,
        contextManagement: { summarization: { trigger: "auto" } },
      }),
    /requires a verified primary model profile/,
  );

  const explicit = new ProfiledChatModel();
  const dock = new AgentDock({
    model: explicit,
    contextManagement: {
      summarization: { trigger: { messages: 10 }, keep: { messages: 2 } },
    },
  });
  const result = await dock.run(
    "Explicit policies work without profile lookup.",
    {},
    { sessionId: "explicit-policy" },
  );
  assert.equal(result.status, "completed");
  await dock.close();
});

test("resolves fractions from the primary profile and validates explicit configuration", () => {
  const primary = new ProfiledChatModel({ maxInputTokens: 1_000 });
  const summary = new ProfiledChatModel({ maxInputTokens: 200 });
  const resolved = ContextManagement.create(primary, {
    summarization: {
      summaryModel: summary,
      trigger: { fraction: 0.6 },
      keep: { fraction: 0.2 },
    },
  });

  assert.deepEqual(resolved.trigger, { kind: "tokens", value: 600 });
  assert.deepEqual(resolved.keep, { kind: "tokens", value: 200 });
  assert.equal(resolved.summaryInputTokens, 100);

  assert.throws(
    () =>
      ContextManagement.create(primary, {
        summarization: { trigger: { tokens: 20, messages: 2 } },
      }),
    /exactly one/,
  );
  assert.throws(
    () =>
      ContextManagement.create(primary, {
        summarization: { trigger: { tokens: 2_000 } },
      }),
    /cannot exceed/,
  );
  assert.throws(
    () =>
      ContextManagement.create(new ProfiledChatModel(), {
        summarization: {
          summaryModel: new ProfiledChatModel(),
          trigger: { messages: 2 },
          primaryModelProfile: { maxInputTokens: 1_000 },
        },
      }),
    /requires a verified summary model profile/,
  );
});

test("middleware preserves a system message and complete assistant/tool groups", async () => {
  const model = new ProfiledChatModel({ maxInputTokens: 1_000 });
  const summary = new ProfiledChatModel({
    maxInputTokens: 1_000,
    response: [{ type: "text", text: "structured summary" }],
  });
  const config = ContextManagement.create(model, {
    summarization: {
      summaryModel: summary,
      trigger: { messages: 1 },
      keep: { messages: 1 },
    },
  });
  const middleware = config.asMiddleware();
  const toolRequest = new AIMessage({
    content: "I will use the tool.",
    tool_calls: [{ id: "call-1", name: "lookup", args: {} }],
  });
  const update = await middleware.beforeModel(
    {
      messages: [
        new SystemMessage("Never reveal secrets."),
        new HumanMessage("Old request."),
        toolRequest,
        new ToolMessage({
          content: "Old tool result.",
          tool_call_id: "call-1",
        }),
        new HumanMessage("Current request."),
      ],
    },
    {},
  );

  assert.equal(summary.calls.length, 1);
  assert.equal(update.messages[1] instanceof SystemMessage, true);
  assert.equal(
    update.messages[2].content,
    "Conversation summary:\n\nstructured summary",
  );
  assert.equal(update.messages.at(-1).content, "Current request.");
  assert.ok(update.messages.every((message) => message.id));
});

test("middleware skips compaction when an uncompactable request still fits", async () => {
  const model = new ProfiledChatModel({ maxInputTokens: 100 });
  const config = ContextManagement.create(model, {
    summarization: { trigger: { tokens: 10 }, keep: { tokens: 1 } },
  });
  const middleware = config.asMiddleware();
  const update = await middleware.beforeModel(
    { messages: [new HumanMessage("still fits ".repeat(20))] },
    {},
  );

  assert.equal(update, undefined);
});

test("middleware exposes the stable capacity error for an impossible retained context", async () => {
  const model = new ProfiledChatModel({ maxInputTokens: 100 });
  const config = ContextManagement.create(model, {
    summarization: { trigger: { tokens: 10 }, keep: { tokens: 1 } },
  });
  const middleware = config.asMiddleware();

  await assert.rejects(
    middleware.beforeModel(
      { messages: [new HumanMessage("cannot fit ".repeat(200))] },
      {},
    ),
    (error) =>
      error instanceof ContextCapacityError &&
      error.code === "agent_context_capacity",
  );
});

test("middleware keeps a pending tool call intact instead of compacting it away", async () => {
  const model = new ProfiledChatModel({ maxInputTokens: 1_000 });
  const config = ContextManagement.create(model, {
    summarization: { trigger: { messages: 1 }, keep: { messages: 1 } },
  });
  const middleware = config.asMiddleware();
  const update = await middleware.beforeModel(
    {
      messages: [
        new HumanMessage("Older request."),
        new AIMessage({
          content: "Waiting for a tool result.",
          tool_calls: [{ id: "pending-call", name: "write", args: {} }],
        }),
        new HumanMessage("New request."),
      ],
    },
    {},
  );

  assert.equal(update, undefined);
});

test("trims an oversized generated summary to the primary-model budget", async () => {
  const model = new ProfiledChatModel({ maxInputTokens: 300 });
  const summary = new ProfiledChatModel({
    maxInputTokens: 1_000,
    response: "summary ".repeat(500),
  });
  const config = ContextManagement.create(model, {
    summarization: {
      summaryModel: summary,
      trigger: { messages: 1 },
      keep: { messages: 1 },
    },
  });
  const middleware = config.asMiddleware();
  const update = await middleware.beforeModel(
    {
      messages: [
        new HumanMessage("Older request."),
        new HumanMessage("Current request."),
      ],
    },
    {},
  );

  const summaryMessage = update.messages[1];
  assert.ok(String(summaryMessage.content).length < summary.response.length);
});

test("falls back to deterministic trimming when summary generation fails", async () => {
  const model = new ProfiledChatModel({ maxInputTokens: 1_000 });
  const summaryModel = new ProfiledChatModel({
    maxInputTokens: 500,
    fail: true,
  });
  const dock = new AgentDock({
    model,
    contextManagement: { summarization: { summaryModel, trigger: "auto" } },
  });

  await dock.run(longPrompt("first"), {}, { sessionId: "summary-fallback" });
  const result = await dock.run(
    longPrompt("second"),
    {},
    { sessionId: "summary-fallback" },
  );

  assert.equal(result.status, "completed");
  assert.equal(summaryModel.calls.length, 1);
  assert.doesNotMatch(allText(model.calls.at(-1)), /Error generating summary/);
  await dock.close();
});

test("persists compacted state across AgentDock recreation with SQLite", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentdock-context-"));
  const databasePath = path.join(directory, "checkpoints.sqlite");
  const firstModel = new ProfiledChatModel({ maxInputTokens: 1_000 });
  const first = new AgentDock({
    model: firstModel,
    checkpoint: new SqliteCheckpoint({ path: databasePath }),
    contextManagement: { summarization: { trigger: "auto" } },
  });

  try {
    await first.initialize();
    await first.run(longPrompt("first"), {}, { sessionId: "durable-context" });
    await first.close();

    const summaryModel = new ProfiledChatModel({
      maxInputTokens: 1_000,
      response: "restored durable facts",
    });
    const second = new AgentDock({
      model: new ProfiledChatModel({ maxInputTokens: 1_000 }),
      checkpoint: new SqliteCheckpoint({ path: databasePath }),
      contextManagement: { summarization: { summaryModel, trigger: "auto" } },
    });
    try {
      await second.initialize();
      const result = await second.run(
        longPrompt("second"),
        {},
        { sessionId: "durable-context" },
      );
      const history = await second.getSessionHistory("durable-context");

      assert.equal(result.status, "completed");
      assert.equal(summaryModel.calls.length, 1);
      assert.match(
        JSON.stringify(history.current.messages),
        /restored durable facts/,
      );
    } finally {
      await second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resumes an approval after compaction without replaying the side effect", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentdock-context-"));
  const databasePath = path.join(directory, "checkpoints.sqlite");
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "publish_report",
    description: "Publish a report.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    requiresApproval: true,
    execute: async () => {
      executions += 1;
      return "published";
    },
  });

  try {
    const summaryModel = new ProfiledChatModel({
      maxInputTokens: 1_000,
      response: "compacted facts before publishing",
    });
    const firstModel = new ProfiledChatModel({
      maxInputTokens: 1_000,
      toolCalls: [
        [],
        [{ name: "publish_report", args: {}, id: "publish-after-summary" }],
        [],
      ],
    });
    const first = new AgentDock({
      model: firstModel,
      registry,
      checkpoint: new SqliteCheckpoint({ path: databasePath }),
      contextManagement: {
        summarization: { summaryModel, trigger: "auto" },
      },
    });
    await first.initialize();
    await first.run(
      longPrompt("initial history"),
      {},
      { sessionId: "approval-after-summary" },
    );
    const waiting = await first.run(
      longPrompt("publish this"),
      {},
      { sessionId: "approval-after-summary", runId: "approval-after-summary" },
    );

    assert.equal(waiting.status, "waiting_for_approval");
    assert.equal(summaryModel.calls.length, 1);
    assert.equal(executions, 0);
    await first.close();

    const second = new AgentDock({
      model: new ProfiledChatModel({ maxInputTokens: 1_000, toolCalls: [[]] }),
      registry,
      checkpoint: new SqliteCheckpoint({ path: databasePath }),
      contextManagement: { summarization: { trigger: "auto" } },
    });
    await second.initialize();
    const completed = await second.resume(
      {
        runId: waiting.runId,
        approvals: [
          {
            approvalId: waiting.approvalRequests[0].approvalId,
            approved: true,
          },
        ],
      },
      {},
      { sessionId: "approval-after-summary" },
    );

    assert.equal(completed.status, "completed");
    assert.equal(completed.toolResults[0].output, "published");
    assert.equal(executions, 1);
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails before the primary model call when the retained request cannot fit", async () => {
  const model = new ProfiledChatModel({ maxInputTokens: 100 });
  const dock = new AgentDock({
    model,
    contextManagement: { summarization: { trigger: "auto" } },
  });

  const result = await dock.run(
    "oversized: ".repeat(300),
    {},
    { sessionId: "context-capacity" },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "agent_context_capacity");
  assert.equal(model.calls.length, 0);
  await dock.close();
});
