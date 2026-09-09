import assert from "node:assert/strict";
import { test } from "vitest";
import { FakeToolCallingModel } from "langchain";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";
import {
  AgentDock,
  ToolRegistry,
  createAgentDock,
  defineTool,
} from "../../src/index.js";

function createAgent(toolCalls, registry = new ToolRegistry(), options = {}) {
  return new AgentDock({
    model: new FakeToolCallingModel({ toolCalls }),
    registry,
    ...options,
  });
}

test("strict context validation rejects non-JSON values with a path", async () => {
  const agent = createAgent([[]]);
  const cyclic = {};
  cyclic.self = cyclic;

  await assert.rejects(
    agent.run(
      "Reject this context.",
      { nested: cyclic },
      { sessionId: "strict-context" },
    ),
    /Agent context\.nested\.self contains a circular reference/,
  );
  await assert.rejects(
    agent.run(
      "Reject this context.",
      { created: new Date() },
      { sessionId: "strict-date" },
    ),
    /Agent context\.created must contain only JSON objects and arrays/,
  );
  await agent.close();
});

test("JSON Schema input validation blocks missing, wrong, and extra fields", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "lookup",
    description: "Look up a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    execute: async () => {
      executions += 1;
      return "ok";
    },
  });

  for (const [args, runId] of [
    [{}, "missing"],
    [{ city: 42 }, "wrong"],
    [{ city: "Lahore", extra: true }, "extra"],
  ]) {
    const agent = createAgent(
      [[{ name: "lookup", args, id: `call-${runId}` }], []],
      registry,
    );
    const result = await agent.run(
      "Look up the city.",
      {},
      { sessionId: `schema-${runId}`, runId },
    );
    assert.equal(result.status, "completed");
    assert.equal(result.toolResults.length, 1);
    assert.equal(result.toolResults[0].isError, true);
    await agent.close();
  }

  assert.equal(executions, 0);
});

test("defineTool infers and validates typed input at the execution boundary", async () => {
  let received;
  const weather = defineTool({
    name: "get_weather",
    description: "Look up weather.",
    input: z.object({ city: z.string() }),
    run: async ({ city }, ctx) => {
      received = { city, ctx };
      return { city, forecast: "sunny" };
    },
  });
  const agent = createAgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{ name: "get_weather", args: { city: "Lahore" }, id: "call-weather" }],
        [],
      ],
    }),
    tools: { weather },
  });

  const result = await agent.run(
    "What is the weather?",
    { userId: "user-1" },
    { sessionId: "typed-weather", runId: "typed-weather" },
  );

  assert.deepEqual(received, { city: "Lahore", ctx: { userId: "user-1" } });
  assert.deepEqual(result.toolResults[0].output, {
    city: "Lahore",
    forecast: "sunny",
  });
  await agent.close();
});

test("unauthorized protected tools do not create approval interrupts", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "delete_account",
    description: "Delete an account.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    authorize: () => ({ allowed: false, reason: "Policy denied." }),
    execute: async () => {
      executions += 1;
      return "deleted";
    },
  });
  const agent = createAgent(
    [[{ name: "delete_account", args: {}, id: "call-delete" }], []],
    registry,
  );

  const result = await agent.run(
    "Delete the account.",
    {},
    { sessionId: "unauthorized-protected", runId: "unauthorized-protected" },
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(result.approvalRequests, []);
  assert.equal(result.toolErrors[0].code, "authorization_denied");
  assert.equal(executions, 0);
  await agent.close();
});

test("authorization timeout is distinct from tool timeout", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "authorization_wait",
    description: "Authorization never settles.",
    parameters: { type: "object", properties: {} },
    authorize: async () => new Promise(() => {}),
    execute: async () => "unreachable",
  });
  const agent = createAgent(
    [[{ name: "authorization_wait", args: {}, id: "call-auth-timeout" }], []],
    registry,
  );

  const result = await agent.run(
    "Run the tool.",
    {},
    {
      sessionId: "authorization-timeout",
      runId: "authorization-timeout",
      authorizationTimeout: 20,
    },
  );

  assert.equal(result.toolErrors[0].code, "authorization_timeout");
  await agent.close();
});

test("authorization is rechecked after approval", async () => {
  const registry = new ToolRegistry();
  let allowed = true;
  let executions = 0;
  registry.register({
    name: "send_payment",
    description: "Send a payment.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    authorize: () => ({
      allowed,
      ...(allowed ? {} : { reason: "Authorization changed." }),
    }),
    execute: async () => {
      executions += 1;
      return "sent";
    },
  });
  const agent = createAgent(
    [[{ name: "send_payment", args: {}, id: "call-payment" }], []],
    registry,
  );

  const waiting = await agent.run(
    "Send payment.",
    {},
    { sessionId: "auth-recheck", runId: "auth-recheck" },
  );
  allowed = false;
  const result = await agent.resume(
    {
      runId: "auth-recheck",
      approvals: [{ approvalId: "call-payment", approved: true }],
    },
    {},
    { sessionId: "auth-recheck" },
  );

  assert.equal(waiting.status, "waiting_for_approval");
  assert.equal(result.toolErrors[0].code, "authorization_denied");
  assert.equal(executions, 0);
  await agent.close();
});

test("tool timeout returns by deadline even when the tool ignores abort", async () => {
  const registry = new ToolRegistry();
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  registry.register({
    name: "uncooperative",
    description: "Never settles.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      started();
      return new Promise(() => {});
    },
  });
  const agent = createAgent(
    [[{ name: "uncooperative", args: {}, id: "call-timeout" }], []],
    registry,
  );

  const begin = Date.now();
  const result = await agent.run(
    "Run the uncooperative tool.",
    {},
    {
      sessionId: "hard-timeout",
      runId: "hard-timeout",
      toolTimeout: 20,
    },
  );

  await startedPromise;
  assert.ok(Date.now() - begin < 500);
  assert.equal(result.toolErrors[0].code, "tool_timeout");
  await agent.close({ gracePeriodMs: 1 });
});

test("close is bounded and reports runs that ignore cancellation", async () => {
  const agent = new AgentDock({ model: new NeverModel() });
  await agent.stream(
    "Close this.",
    {},
    { sessionId: "bounded-close", runId: "bounded-close" },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));

  const begin = Date.now();
  await agent.close({ gracePeriodMs: 20 });
  assert.ok(Date.now() - begin < 500);
  assert.deepEqual(agent.getUnfinishedRunIds(), []);
});

test("a shared coordinator protects a session across AgentDock instances", async () => {
  const coordinator = new MapCoordinator();
  const first = createAgent([[]], new ToolRegistry(), { coordinator });
  const second = createAgent([[]], new ToolRegistry(), { coordinator });
  const firstRun = await first.stream(
    "First run.",
    {},
    { sessionId: "shared-session", runId: "first-run" },
  );

  await assert.rejects(
    second.run(
      "Second run.",
      {},
      { sessionId: "shared-session", runId: "second-run" },
    ),
    /already has an active run/,
  );
  await firstRun.result;
  await first.close();
  await second.close();
});

test("deleteSession removes model-visible context and namespaces do not collide", async () => {
  const checkpointer = new (
    await import("@langchain/langgraph-checkpoint")
  ).MemorySaver();
  const first = createAgent([[]], new ToolRegistry(), { checkpointer });
  await first.run("Old context.", {}, { sessionId: "reusable", runId: "old" });
  assert.ok((await first.getSession("reusable"))?.messages.length);
  const history = await first.getSessionHistory("reusable");
  assert.ok(history.current);
  assert.ok(history.checkpoints.length > 0);
  await first.deleteSession("reusable");
  assert.equal(await first.getSession("reusable"), null);
  await first.close();

  const second = createAgent([[]], new ToolRegistry(), { checkpointer });
  const fresh = await second.run(
    "Fresh context.",
    {},
    { sessionId: "reusable", runId: "fresh" },
  );
  assert.deepEqual(
    fresh.messages.map((message) => message.content),
    ["Fresh context.", "Fresh context."],
  );
  await second.close();
});

test("session namespaces isolate checkpoint threads", async () => {
  const checkpointer = new (
    await import("@langchain/langgraph-checkpoint")
  ).MemorySaver();
  const agent = createAgent([[]], new ToolRegistry(), { checkpointer });
  await agent.run(
    "Namespace A.",
    {},
    {
      sessionId: "same-id",
      sessionNamespace: "tenant-a",
      runId: "tenant-a-run",
    },
  );
  await agent.run(
    "Namespace B.",
    {},
    {
      sessionId: "same-id",
      sessionNamespace: "tenant-b",
      runId: "tenant-b-run",
    },
  );

  assert.equal(
    (await agent.getSession("same-id", { sessionNamespace: "tenant-a" }))
      .messages[0].content,
    "Namespace A.",
  );
  assert.equal(
    (await agent.getSession("same-id", { sessionNamespace: "tenant-b" }))
      .messages[0].content,
    "Namespace B.",
  );
  await agent.close();
});

class MapCoordinator {
  sessions = new Set();
  runs = new Set();

  async acquire({ sessionKey, runId }) {
    if (this.runs.has(runId)) throw new Error("run already active");
    if (this.sessions.has(sessionKey))
      throw new Error("session already has an active run");
    this.runs.add(runId);
    this.sessions.add(sessionKey);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.runs.delete(runId);
        this.sessions.delete(sessionKey);
      },
    };
  }
}

class NeverModel extends BaseChatModel {
  constructor() {
    super({});
  }

  _llmType() {
    return "never";
  }

  async _generate() {
    return new Promise(() => {});
  }
}
