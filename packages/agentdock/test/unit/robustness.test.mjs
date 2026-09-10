import assert from "node:assert/strict";
import { test } from "vitest";
import { FakeToolCallingModel, createMiddleware } from "langchain";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import {
  AgentDock,
  ToolRegistry,
  createAgentDock,
  defineTool,
  validateToolInput,
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

function contentText(content) {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
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

test("malformed finalized tool input fails with a stable code", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "malformed_input",
    description: "Reject non-object model input.",
    parameters: { type: "object", properties: {} },
    execute: async () => "unreachable",
  });
  const agent = createAgent(
    [[{ name: "malformed_input", args: [], id: "call-malformed" }]],
    registry,
  );

  const result = await agent.run(
    "Call with malformed input.",
    {},
    { sessionId: "malformed-input", runId: "malformed-input" },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "tool_input_invalid");
  assert.match(result.error, /invalid tool input/);
  await agent.close();
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

test("the easy and advanced APIs run caller-provided middleware", async () => {
  let easyCalls = 0;
  let advancedCalls = 0;
  const easyMiddleware = createMiddleware({
    name: "easy-observer",
    afterModel: () => {
      easyCalls += 1;
    },
  });
  const advancedMiddleware = createMiddleware({
    name: "advanced-observer",
    afterModel: () => {
      advancedCalls += 1;
    },
  });
  const easyAgent = createAgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    middleware: [easyMiddleware],
  });
  const advancedAgent = new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    middleware: [advancedMiddleware],
  });

  const [easyResult, advancedResult] = await Promise.all([
    easyAgent.run("Easy.", {}, { sessionId: "easy-middleware" }),
    advancedAgent.run("Advanced.", {}, { sessionId: "advanced-middleware" }),
  ]);

  assert.equal(easyResult.status, "completed");
  assert.equal(advancedResult.status, "completed");
  assert.equal(easyCalls, 1);
  assert.equal(advancedCalls, 1);
  await Promise.all([easyAgent.close(), advancedAgent.close()]);
});

test("the easy and advanced APIs produce equivalent canonical results", async () => {
  const easyAgent = createAgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    instructions: "Be concise.",
  });
  const advancedAgent = new AgentDock({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    defaults: { systemPrompt: "Be concise." },
  });
  const easyExecution = await easyAgent.stream(
    "Equivalent.",
    {},
    { sessionId: "easy-equivalent", runId: "easy-equivalent" },
  );
  const advancedExecution = await advancedAgent.stream(
    "Equivalent.",
    {},
    { sessionId: "advanced-equivalent", runId: "advanced-equivalent" },
  );
  const [easyEvents, advancedEvents, easyResult, advancedResult] =
    await Promise.all([
      collect(easyExecution.stream),
      collect(advancedExecution.stream),
      easyExecution.result,
      advancedExecution.result,
    ]);

  assert.deepEqual(
    easyEvents.map((event) => event.type),
    advancedEvents.map((event) => event.type),
  );
  assert.equal(easyResult.status, advancedResult.status);
  assert.deepEqual(easyResult.content, advancedResult.content);
  assert.deepEqual(
    easyResult.messages.map(({ role, content }) => ({ role, content })),
    advancedResult.messages.map(({ role, content }) => ({ role, content })),
  );
  await Promise.all([easyAgent.close(), advancedAgent.close()]);
});

test("an approval-enabled typed tool uses its inferred validated input", async () => {
  let received;
  const publish = defineTool({
    name: "publish_typed",
    description: "Publish a typed report.",
    input: z.object({ reportId: z.string() }),
    requiresApproval: true,
    run: async ({ reportId }) => {
      received = reportId;
      return { published: reportId };
    },
  });
  const agent = createAgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: "publish_typed",
            args: { reportId: "report-1" },
            id: "call-publish-typed",
          },
        ],
        [],
      ],
    }),
    tools: { publish },
  });

  const waiting = await agent.run(
    "Publish.",
    {},
    { sessionId: "typed-approval", runId: "typed-approval" },
  );
  assert.equal(waiting.status, "waiting_for_approval");
  assert.deepEqual(waiting.approvalRequests[0].toolCall.input, {
    reportId: "report-1",
  });
  const completed = await agent.resume(
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
    { sessionId: "typed-approval" },
  );

  assert.equal(completed.status, "completed");
  assert.equal(received, "report-1");
  assert.deepEqual(completed.toolResults[0].output, {
    published: "report-1",
  });
  await agent.close();
});

test("raw object schemas validate nested arrays, unions, enums, constants, and booleans", () => {
  const schema = {
    type: "object",
    properties: {
      mode: {
        anyOf: [
          { type: "string", enum: ["fast", "safe"] },
          { type: "integer" },
        ],
      },
      profile: {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" } } },
        required: ["tags"],
        additionalProperties: false,
      },
      kind: { const: "report" },
      metadata: { additionalProperties: { type: "boolean" } },
    },
    required: ["mode", "profile", "kind"],
    additionalProperties: false,
  };

  const valid = {
    mode: "safe",
    profile: { tags: ["daily", "important"] },
    kind: "report",
    metadata: { urgent: true },
  };
  assert.deepEqual(validateToolInput(schema, valid, "report"), valid);
  assert.throws(
    () => validateToolInput(schema, { ...valid, mode: false }, "report"),
    /Invalid input at \$\.mode/,
  );
  assert.throws(
    () => validateToolInput(schema, { ...valid, kind: "draft" }, "report"),
    /Invalid input at \$\.kind/,
  );
  assert.throws(
    () =>
      validateToolInput(
        schema,
        { ...valid, profile: { tags: ["ok", 1] } },
        "report",
      ),
    /Invalid input at \$\.profile\.tags\[1\]/,
  );
  assert.throws(
    () => validateToolInput(schema, { ...valid, extra: true }, "report"),
    /Unexpected input \$\.extra/,
  );
});

test("raw tool registration requires an object root and snapshots schema mutations", () => {
  const registry = new ToolRegistry();
  assert.throws(
    () =>
      registry.register({
        name: "text",
        description: "Text",
        parameters: { type: "string" },
        execute: async () => "ok",
      }),
    /object root/,
  );
  assert.throws(
    () =>
      registry.register({
        name: "array",
        description: "Array",
        parameters: { type: "array", items: { type: "string" } },
        execute: async () => "ok",
      }),
    /object root/,
  );
  assert.throws(
    () =>
      registry.register({
        name: "unsupported",
        description: "Unsupported",
        parameters: {
          type: "object",
          properties: { value: { type: "string", minLength: 2 } },
        },
        execute: async () => "ok",
      }),
    /unsupported JSON schema keyword minLength/,
  );

  const parameters = {
    type: "object",
    properties: { city: { type: "string" } },
  };
  registry.register({
    name: "weather",
    description: "Weather",
    parameters,
    execute: async () => "ok",
  });
  parameters.properties.city.type = "number";
  const registered = registry.get("weather");
  assert.equal(registered.parameters.properties.city.type, "string");
  registered.parameters.properties.city.type = "boolean";
  assert.equal(
    registry.get("weather").parameters.properties.city.type,
    "string",
  );
});

test("typed tools receive the validated context, abort signal, and tool-call id", async () => {
  let observed;
  const typed = defineTool({
    name: "observe_runtime",
    description: "Observe runtime values.",
    input: z.object({ value: z.string() }),
    run: async ({ value }, ctx, signal, _reportProgress, toolCallId) => {
      observed = { value, ctx, aborted: signal.aborted, toolCallId };
      return "observed";
    },
  });
  const agent = createAgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: "observe_runtime",
            args: { value: "ok" },
            id: "call-runtime",
          },
        ],
        [],
      ],
    }),
    tools: { typed },
  });
  const result = await agent.run(
    "Observe.",
    { tenant: "tenant-1" },
    { sessionId: "runtime-values" },
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(observed, {
    value: "ok",
    ctx: { tenant: "tenant-1" },
    aborted: false,
    toolCallId: "call-runtime",
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
  const result = await execution.result;
  const events = await eventsPromise;
  const usage = events.find((event) => event.type === "usage.updated");
  const completed = events.at(-1);

  assert.deepEqual(usage.usage, {
    inputTokens: 3,
    cachedInputTokens: 1,
    outputTokens: 2,
    reasoningTokens: 1,
    totalTokens: 5,
    costUsd: 0.002,
    model: "usage-model",
    provider: "test-provider",
  });
  assert.deepEqual(completed.usage, usage.usage);
  assert.deepEqual(result.usage, usage.usage);
  assert.equal(result.finishReason, "stop");
  await agent.close();
});

test("usage remains logical-run-wide across an approval resume", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "usage_approval",
    description: "Require approval between model calls.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    execute: async () => "approved",
  });
  const agent = new AgentDock({ model: new ApprovalUsageModel(), registry });

  const waiting = await agent.run(
    "Use the tool.",
    {},
    { sessionId: "approval-usage", runId: "approval-usage" },
  );
  assert.equal(waiting.usage.totalTokens, 3);
  const completed = await agent.resume(
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
    { sessionId: "approval-usage" },
  );

  assert.deepEqual(completed.usage, {
    inputTokens: 3,
    outputTokens: 3,
    totalTokens: 6,
    model: "approval-usage-model",
    provider: "test-provider",
  });
  await agent.close();
});

test("model call limits produce stable terminal metadata", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "continue_once",
    description: "Force another model call.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      executions += 1;
      return "continue";
    },
  });
  const agent = createAgent(
    [[{ name: "continue_once", args: {}, id: "call-limit" }], []],
    registry,
  );
  const execution = await agent.stream(
    "Reach the limit.",
    {},
    { sessionId: "limit-session", runId: "limit-run", maxSteps: 1 },
  );
  const eventsPromise = collect(execution.stream);
  const result = await execution.result;
  const events = await eventsPromise;
  const terminal = events.at(-1);

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "agent_step_limit");
  assert.equal(result.finishReason, "limit");
  assert.deepEqual(result.limit, { kind: "model_calls", limit: 1, used: 1 });
  assert.equal(terminal.type, "run.failed");
  assert.equal(terminal.code, "agent_step_limit");
  assert.deepEqual(terminal.limit, result.limit);
  assert.equal(executions, 1);
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

test("invalid protected tool input is rejected before authorization and approval", async () => {
  const registry = new ToolRegistry();
  let authorizations = 0;
  let executions = 0;
  registry.register({
    name: "protected_lookup",
    description: "Look up protected data.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    requiresApproval: true,
    authorize: () => {
      authorizations += 1;
      return { allowed: true };
    },
    execute: async () => {
      executions += 1;
      return "unexpected";
    },
  });
  const agent = createAgent(
    [
      [{ name: "protected_lookup", args: {}, id: "call-invalid-protected" }],
      [],
    ],
    registry,
  );

  const result = await agent.run(
    "Look up protected data.",
    {},
    { sessionId: "invalid-protected", runId: "invalid-protected" },
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(result.approvalRequests, []);
  assert.equal(result.toolErrors[0].code, "tool_input_invalid");
  assert.equal(authorizations, 0);
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

test("authorization receives an abort signal at its hard deadline", async () => {
  const registry = new ToolRegistry();
  let observedAbort = false;
  registry.register({
    name: "cooperative_authorization",
    description: "Authorization observes cancellation.",
    parameters: { type: "object", properties: {} },
    authorize: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve({ allowed: false, reason: "aborted" });
          },
          { once: true },
        );
      }),
    execute: async () => "unreachable",
  });
  const agent = createAgent(
    [
      [
        {
          name: "cooperative_authorization",
          args: {},
          id: "call-cooperative-auth",
        },
      ],
      [],
    ],
    registry,
  );

  const result = await agent.run(
    "Run the tool.",
    {},
    {
      sessionId: "cooperative-authorization-timeout",
      runId: "cooperative-authorization-timeout",
      authorizationTimeout: 20,
    },
  );

  assert.equal(observedAbort, true);
  assert.equal(result.toolErrors[0].code, "authorization_timeout");
  await agent.close();
});

test.each([
  [
    "throws",
    () => {
      throw new Error("policy unavailable");
    },
    "authorization_failed",
  ],
  [
    "returns invalid data",
    () => ({ reason: "missing allowed" }),
    "authorization_invalid",
  ],
])(
  "authorization that %s has a stable error code",
  async (_label, authorize, code) => {
    const registry = new ToolRegistry();
    registry.register({
      name: "invalid_authorization",
      description: "Exercise policy failure handling.",
      parameters: { type: "object", properties: {} },
      authorize,
      execute: async () => "unreachable",
    });
    const agent = createAgent(
      [[{ name: "invalid_authorization", args: {}, id: `call-${code}` }], []],
      registry,
    );

    const result = await agent.run(
      "Run the tool.",
      {},
      { sessionId: `session-${code}`, runId: `run-${code}` },
    );

    assert.equal(result.status, "completed");
    assert.equal(result.toolErrors[0].code, code);
    await agent.close();
  },
);

test("a protected authorization failure never creates an approval prompt", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "protected_policy_failure",
    description: "Fail before approval.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    authorize: () => {
      throw new Error("policy unavailable");
    },
    execute: async () => "unreachable",
  });
  const agent = createAgent(
    [
      [
        {
          name: "protected_policy_failure",
          args: {},
          id: "call-protected-policy-failure",
        },
      ],
    ],
    registry,
  );

  const result = await agent.run(
    "Run protected tool.",
    {},
    {
      sessionId: "protected-policy-failure",
      runId: "protected-policy-failure",
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "authorization_failed");
  assert.deepEqual(result.approvalRequests, []);
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

test("the default coordinator rejects same-instance overlap and active deletion", async () => {
  const agent = new AgentDock({ model: new NeverModel() });
  await agent.stream(
    "Hold this session.",
    {},
    { sessionId: "same-instance-session", runId: "same-instance-run" },
  );

  await assert.rejects(
    agent.run(
      "Run concurrently.",
      {},
      { sessionId: "same-instance-session", runId: "second-run" },
    ),
    /already has an active run/,
  );
  await assert.rejects(
    agent.deleteSession("same-instance-session"),
    /active run/,
  );
  await agent.close({ gracePeriodMs: 10 });
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

test("checkpoint initialization happens under the coordinator lease and releases on failure", async () => {
  const coordinator = new TrackingCoordinator();
  let initializationAttempts = 0;
  let modelCalls = 0;
  const checkpoint = {
    saver: new MemorySaver(),
    initialize: async () => {
      initializationAttempts += 1;
      if (initializationAttempts === 1) {
        throw new Error("checkpoint unavailable");
      }
    },
    close: async () => {},
  };
  const middleware = createMiddleware({
    name: "countModelCallsAfterCheckpointInitialization",
    wrapModelCall: async (request, handler) => {
      modelCalls += 1;
      return handler(request);
    },
  });
  const agent = createAgent([[]], new ToolRegistry(), {
    checkpoint,
    coordinator,
    middleware: [middleware],
  });

  await assert.rejects(
    agent.run(
      "Initialization fails.",
      {},
      { sessionId: "initialization-lease", runId: "initialization-failed" },
    ),
    /checkpoint unavailable/,
  );
  assert.equal(modelCalls, 0);

  const completed = await agent.run(
    "Initialization succeeds.",
    {},
    { sessionId: "initialization-lease", runId: "initialization-succeeded" },
  );
  assert.equal(completed.status, "completed");
  assert.equal(modelCalls, 1);
  assert.deepEqual(coordinator.releasedRunIds, [
    "initialization-failed",
    "initialization-succeeded",
  ]);
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
    fresh.messages.map((message) => contentText(message.content)),
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

  assert.deepEqual(
    (await agent.getSession("same-id", { sessionNamespace: "tenant-a" }))
      .messages[0].content,
    [{ type: "text", text: "Namespace A." }],
  );
  assert.deepEqual(
    (await agent.getSession("same-id", { sessionNamespace: "tenant-b" }))
      .messages[0].content,
    [{ type: "text", text: "Namespace B." }],
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
              input_token_details: { cache_read: 1 },
              output_tokens: 2,
              output_token_details: { reasoning: 1 },
              total_tokens: 5,
              cost_usd: 0.002,
            },
            response_metadata: {
              model_name: "usage-model",
              model_provider: "test-provider",
            },
          }),
        },
      ],
    };
  }
}

class ApprovalUsageModel extends BaseChatModel {
  index = 0;

  constructor() {
    super({});
  }

  bindTools() {
    return this;
  }

  _llmType() {
    return "approval-usage-model";
  }

  async _generate() {
    const first = this.index === 0;
    this.index += 1;
    return {
      generations: [
        {
          message: new AIMessage({
            id: `approval-usage-${this.index}`,
            content: first ? "" : "Finished.",
            ...(first
              ? {
                  tool_calls: [
                    { name: "usage_approval", args: {}, id: "call-usage" },
                  ],
                }
              : {}),
            usage_metadata: {
              input_tokens: first ? 1 : 2,
              output_tokens: first ? 2 : 1,
              total_tokens: 3,
            },
            response_metadata: {
              model_name: "approval-usage-model",
              model_provider: "test-provider",
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
