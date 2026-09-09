import assert from "node:assert/strict";
import { test } from "vitest";
import { FakeToolCallingModel } from "langchain";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  AgentDock,
  ToolRegistry,
  createAgentDock,
  defineTool,
} from "../../src/index.js";
import {
  createNeverSettlingAuthorization,
  createUncooperativeTool,
} from "../helpers/stream-fixtures.mjs";

function createAgent(toolCalls, registry = new ToolRegistry(), options = {}) {
  return new AgentDock({
    model: new FakeToolCallingModel({ toolCalls }),
    registry,
    ...options,
  });
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
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

test("tool progress is emitted through the canonical stream before completion", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "progress_tool",
    description: "Reports progress.",
    parameters: { type: "object", properties: {} },
    execute: async ({ reportProgress }) => {
      reportProgress("started");
      reportProgress("finished");
      return "done";
    },
  });
  const agent = createAgent(
    [[{ name: "progress_tool", args: {}, id: "call-progress" }], []],
    registry,
  );

  const execution = await agent.stream(
    "Run the progress tool.",
    {},
    { sessionId: "progress-session", runId: "progress-run" },
  );
  const eventsPromise = collect(execution.stream);
  const result = await execution.result;
  const events = await eventsPromise;

  assert.equal(result.status, "completed");
  const progress = events.filter((event) => event.type === "tool.progress");
  assert.deepEqual(
    progress.map((event) => event.content[0].text),
    ["started", "finished"],
  );
  assert.ok(
    events.findIndex((event) => event.type === "tool.progress") <
      events.findIndex((event) => event.type === "tool.completed"),
  );
  await agent.close();
});

test("usage metadata is emitted and attached to the terminal event", async () => {
  const agent = new AgentDock({ model: new UsageModel() });
  const execution = await agent.stream(
    "Report usage.",
    {},
    { sessionId: "usage-session", runId: "usage-run" },
  );
  const eventsPromise = collect(execution.stream);
  await execution.result;
  const events = await eventsPromise;
  const usage = events.find((event) => event.type === "usage.updated");
  const completed = events.at(-1);

  assert.deepEqual(usage.usage, {
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
  });
  assert.deepEqual(completed.usage, usage.usage);
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
    authorize: createNeverSettlingAuthorization(),
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
    execute: createUncooperativeTool({ onStarted: () => started() }),
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

test("close reports a run whose coordinator release never settles", async () => {
  const coordinator = {
    acquire: async () => ({ release: () => new Promise(() => {}) }),
  };
  const agent = createAgent([[]], new ToolRegistry(), { coordinator });
  await agent.stream(
    "Finish but hold the lease.",
    {},
    { sessionId: "late-release", runId: "late-release" },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  const started = Date.now();
  await agent.close({ gracePeriodMs: 20 });

  assert.ok(Date.now() - started < 500);
  assert.deepEqual(agent.getUnfinishedRunIds(), ["late-release"]);
});

test("coordinator release failure is surfaced and does not leave a local lock", async () => {
  let releases = 0;
  const coordinator = {
    acquire: async () => ({
      release: () => {
        releases += 1;
        throw new Error("release failed");
      },
    }),
  };
  const agent = createAgent([[]], new ToolRegistry(), { coordinator });

  await assert.rejects(
    agent.run(
      "Release this run.",
      {},
      { sessionId: "release-failure", runId: "release-failure" },
    ),
    /release failed/,
  );
  assert.equal(releases, 1);

  await agent.close();
});

test("close is bounded when authorization ignores cancellation", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "authorization_never_settles",
    description: "Authorization never settles.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    authorize: createNeverSettlingAuthorization(),
    execute: async () => "unreachable",
  });
  const agent = createAgent(
    [
      [
        {
          name: "authorization_never_settles",
          args: {},
          id: "call-auth-close",
        },
      ],
    ],
    registry,
  );
  const execution = await agent.stream(
    "Close during authorization.",
    {},
    { sessionId: "authorization-close", runId: "authorization-close" },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  const started = Date.now();
  await agent.close({ gracePeriodMs: 20 });
  const result = await execution.result;

  assert.ok(Date.now() - started < 500);
  assert.equal(result.status, "cancelled");
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

test("coordinator releases after success, failure, cancellation, and timeout", async () => {
  const coordinator = new TrackingCoordinator();
  const success = createAgent([[]], new ToolRegistry(), { coordinator });
  await success.run(
    "Succeed.",
    {},
    { sessionId: "coord-success", runId: "coord-success" },
  );

  const failure = new AgentDock({ model: new ThrowingModel(), coordinator });
  const failed = await failure.run(
    "Fail.",
    {},
    { sessionId: "coord-failure", runId: "coord-failure" },
  );
  assert.equal(failed.status, "failed");

  const cancelledSignal = new AbortController();
  cancelledSignal.abort(new Error("cancel before execution"));
  const cancellation = createAgent([[]], new ToolRegistry(), { coordinator });
  const cancelled = await cancellation.run(
    "Cancel.",
    {},
    {
      sessionId: "coord-cancelled",
      runId: "coord-cancelled",
      abortSignal: cancelledSignal.signal,
    },
  );
  assert.equal(cancelled.status, "cancelled");

  const timeoutRegistry = new ToolRegistry();
  timeoutRegistry.register({
    name: "coord_timeout",
    description: "Never settles.",
    parameters: { type: "object", properties: {} },
    execute: async () => new Promise(() => {}),
  });
  const timeout = createAgent(
    [[{ name: "coord_timeout", args: {}, id: "coord-timeout-call" }], []],
    timeoutRegistry,
    { coordinator },
  );
  const timedOut = await timeout.run(
    "Timeout.",
    {},
    {
      sessionId: "coord-timeout",
      runId: "coord-timeout",
      toolTimeout: 20,
    },
  );
  assert.equal(timedOut.toolErrors[0].code, "tool_timeout");

  assert.deepEqual(coordinator.releasedRunIds.sort(), [
    "coord-cancelled",
    "coord-failure",
    "coord-success",
    "coord-timeout",
  ]);
  await success.close();
  await failure.close();
  await cancellation.close();
  await timeout.close({ gracePeriodMs: 1 });
});

test("coordinator acquisition failure prevents execution and does not leave a local lock", async () => {
  let executions = 0;
  const coordinator = {
    acquire: async () => {
      throw new Error("coordinator unavailable");
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: "must_not_run",
    description: "Must not execute.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      executions += 1;
      return "unexpected";
    },
  });
  const agent = createAgent(
    [[{ name: "must_not_run", args: {}, id: "must-not-run" }], []],
    registry,
    { coordinator },
  );

  await assert.rejects(
    agent.run(
      "Do not execute.",
      {},
      { sessionId: "coordinator-failure", runId: "coordinator-failure" },
    ),
    /coordinator unavailable/,
  );
  assert.equal(executions, 0);
  await agent.close();
});

test("coordinator waits for asynchronous release before resolving a run", async () => {
  const coordinator = new DelayedReleaseCoordinator(25);
  const agent = createAgent([[]], new ToolRegistry(), { coordinator });

  const started = Date.now();
  await agent.run(
    "Release slowly.",
    {},
    { sessionId: "delayed-release", runId: "delayed-release" },
  );
  assert.ok(Date.now() - started >= 20);

  await agent.run(
    "Run again.",
    {},
    { sessionId: "delayed-release", runId: "delayed-release-2" },
  );
  assert.deepEqual(coordinator.releasedRunIds, [
    "delayed-release",
    "delayed-release-2",
  ]);
  await agent.close();
});

test("the coordinator rejects an active run ID even across sessions", async () => {
  const coordinator = new MapCoordinator();
  const first = createAgent([[]], new ToolRegistry(), { coordinator });
  const second = createAgent([[]], new ToolRegistry(), { coordinator });
  const active = await first.stream(
    "Hold this run.",
    {},
    { sessionId: "run-id-a", runId: "same-run-id" },
  );

  await assert.rejects(
    second.run(
      "Duplicate run.",
      {},
      { sessionId: "run-id-b", runId: "same-run-id" },
    ),
    /run already active/,
  );
  await active.result;
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

class TrackingCoordinator extends MapCoordinator {
  releasedRunIds = [];

  async acquire(input) {
    const lease = await super.acquire(input);
    return {
      release: () => {
        this.releasedRunIds.push(input.runId);
        lease.release();
      },
    };
  }
}

class DelayedReleaseCoordinator extends MapCoordinator {
  releasedRunIds = [];

  constructor(delayMs) {
    super();
    this.delayMs = delayMs;
  }

  async acquire(input) {
    const lease = await super.acquire(input);
    return {
      release: async () => {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        this.releasedRunIds.push(input.runId);
        lease.release();
      },
    };
  }
}

class UsageModel extends BaseChatModel {
  constructor() {
    super({});
  }

  bindTools() {
    return this;
  }

  _llmType() {
    return "usage-model";
  }

  async _generate() {
    return {
      generations: [
        {
          message: new AIMessage({
            content: "Usage response.",
            usage_metadata: {
              input_tokens: 3,
              output_tokens: 2,
              total_tokens: 5,
            },
          }),
        },
      ],
    };
  }
}

class ThrowingModel extends BaseChatModel {
  constructor() {
    super({});
  }

  bindTools() {
    return this;
  }

  _llmType() {
    return "throwing-model";
  }

  async _generate() {
    throw new Error("model failed");
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
