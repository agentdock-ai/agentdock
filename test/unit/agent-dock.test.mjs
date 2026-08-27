import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  AgentDock,
  AgentEventType,
  InMemoryAgentStore,
  ToolRegistry,
} from "../../src/index.js";
import {
  createFailingModel,
  createScriptedModel,
  textResponse,
  toolCallResponse,
} from "../fixtures/models.mjs";
import { stopRunController } from "../../src/agent/runs/runtime.js";

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function createAgent(model, store = new InMemoryAgentStore(), registry = new ToolRegistry()) {
  return new AgentDock({
    model,
    store,
    registry,
    defaults: {
      systemPrompt: "You are a report assistant.",
      maxSteps: 3,
    },
  });
}

test("AgentDock persists runs and loads the session history for later runs", async () => {
  const model = createScriptedModel([
    textResponse("The first report is ready."),
    textResponse("The second report is ready."),
  ]);
  const store = new InMemoryAgentStore();
  const agent = createAgent(model, store);

  const first = await agent.run(
    "Prepare the first report.",
    { userId: "user-report" },
    { sessionId: "session-report", runId: "run-report-1" },
  );
  const second = await agent.run(
    "Prepare the second report.",
    { userId: "user-report" },
    { sessionId: "session-report", runId: "run-report-2" },
  );

  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(first.sessionId, "session-report");
  assert.equal(second.sessionId, "session-report");
  assert.equal((await agent.getRun("run-report-1")).sessionId, "session-report");
  assert.equal((await agent.getSession("session-report")).latestRunId, "run-report-2");
  assert.deepEqual(
    (await agent.getSession("session-report")).messages.map((message) => message.content),
    [
      "You are a report assistant.",
      "Prepare the first report.",
      "The first report is ready.",
      "Prepare the second report.",
      "The second report is ready.",
    ],
  );
  assert.match(JSON.stringify(model.doStreamCalls[1].prompt), /Prepare the first report/);
  assert.match(JSON.stringify(model.doStreamCalls[1].prompt), /The first report is ready/);
});

test("AgentDock isolates histories between sessions", async () => {
  const model = createScriptedModel([
    textResponse("Weather for Lahore."),
    textResponse("Weather for Karachi."),
  ]);
  const agent = createAgent(model);

  await agent.run(
    "Check Lahore.",
    { userId: "user-weather" },
    { sessionId: "session-lahore", runId: "run-lahore" },
  );
  await agent.run(
    "Check Karachi.",
    { userId: "user-weather" },
    { sessionId: "session-karachi", runId: "run-karachi" },
  );

  assert.doesNotMatch(JSON.stringify(model.doStreamCalls[1].prompt), /Check Lahore/);
  assert.deepEqual(
    (await agent.getSession("session-karachi")).messages.map((message) => message.content),
    ["You are a report assistant.", "Check Karachi.", "Weather for Karachi."],
  );
});

test("AgentDock exposes normalized stream events and persists completion", async () => {
  const agent = createAgent(createScriptedModel([textResponse("The report is complete.")]));

  const streamed = await agent.stream(
    "Complete the report.",
    { userId: "user-report" },
    { sessionId: "session-stream", runId: "run-stream" },
  );
  const events = await collect(streamed.stream);
  const result = await streamed.result;

  assert.deepEqual(events.map((event) => event.type), [
    AgentEventType.RunStarted,
    AgentEventType.StreamStarted,
    AgentEventType.StepStarted,
    AgentEventType.TextStarted,
    AgentEventType.TextDelta,
    AgentEventType.TextCompleted,
    AgentEventType.StepCompleted,
    AgentEventType.StreamFinished,
    AgentEventType.RunCompleted,
  ]);
  assert.equal(result.status, "completed");
  assert.equal((await agent.getRun("run-stream")).status, "completed");
});

test("AgentDock persists failed runs and surfaces the model error", async () => {
  const agent = createAgent(createFailingModel(new Error("Model unavailable")));
  const logError = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    await assert.rejects(
      agent.run(
        "Prepare the report.",
        { userId: "user-report" },
        { sessionId: "session-failed", runId: "run-failed" },
      ),
      /No output generated/,
    );
  } finally {
    logError.mockRestore();
  }

  const run = await agent.getRun("run-failed");
  assert.equal(run.status, "failed");
  assert.equal(run.error, "No output generated. Check the stream for errors.");
});

test("AgentDock stops an active run and returns a cancelled result", async () => {
  const agent = createAgent(createScriptedModel([textResponse("This run will be stopped.")]));
  const streamed = await agent.stream(
    "Start a cancellable report.",
    { userId: "user-report" },
    { sessionId: "session-cancelled", runId: "run-cancelled" },
  );

  await agent.stop("run-cancelled");
  const result = await streamed.result;
  const events = await collect(streamed.stream);

  assert.equal(result.status, "cancelled");
  assert.equal((await agent.getRun("run-cancelled")).status, "cancelled");
  assert.equal(events.at(-1).type, AgentEventType.RunCancelled);
  await agent.stop("run-cancelled");
  await assert.rejects(agent.stop("missing-run"), /Agent run not found: missing-run/);
});

test("AgentDock pauses for approval and resumes the same run", async () => {
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
      return { published: true };
    },
  });
  const model = createScriptedModel([
    toolCallResponse({
      toolCallId: "call-publish-report",
      toolName: "publish_report",
      input: { reportId: "report-monthly" },
    }),
    textResponse("The report was published."),
  ]);
  const store = new InMemoryAgentStore();
  const agent = createAgent(model, store, registry);

  const waiting = await agent.run(
    "Publish the monthly report.",
    { userId: "user-report" },
    { sessionId: "session-approval", runId: "run-approval" },
  );

  assert.equal(waiting.status, "waiting_for_approval");
  assert.equal(waiting.approvalRequests.length, 1);
  assert.equal(executions, 0);
  assert.equal((await agent.getRun("run-approval")).status, "waiting_for_approval");

  const resumed = await agent.resume(
    {
      runId: waiting.runId,
      approvals: [{
        approvalId: waiting.approvalRequests[0].approvalId,
        approved: true,
      }],
    },
    { userId: "user-report" },
  );

  assert.equal(resumed.runId, waiting.runId);
  assert.equal(resumed.sessionId, waiting.sessionId);
  assert.equal(resumed.status, "completed");
  assert.equal((await agent.getRun("run-approval")).status, "completed");
});

test("AgentDock rejects a second approval claim for the same run", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "send_report",
    description: "Send a report.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    execute: async () => ({ sent: true }),
  });
  const model = createScriptedModel([toolCallResponse({
    toolCallId: "call-send-report",
    toolName: "send_report",
    input: {},
  }), textResponse("The report was sent.")]);
  const agent = createAgent(model, new InMemoryAgentStore(), registry);
  const waiting = await agent.run(
    "Send the report.",
    { userId: "user-report" },
    { sessionId: "session-approval", runId: "run-approval-once" },
  );
  const decision = {
    approvalId: waiting.approvalRequests[0].approvalId,
    approved: true,
  };

  const resumed = await agent.resume(
    { runId: waiting.runId, approvals: [decision] },
    { userId: "user-report" },
  );
  assert.equal(resumed.status, "completed");

  await assert.rejects(
    agent.resume({ runId: waiting.runId, approvals: [decision] }, { userId: "user-report" }),
    /approval claim failed/,
  );
});

test("AgentDock does not consume approvals when the session ID is wrong", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "publish_report",
    description: "Publish a report.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    execute: async () => ({ published: true }),
  });
  const agent = createAgent(
    createScriptedModel([toolCallResponse({
      toolCallId: "call-publish-report",
      toolName: "publish_report",
      input: {},
    })]),
    new InMemoryAgentStore(),
    registry,
  );

  const waiting = await agent.run(
    "Publish the report.",
    {},
    { sessionId: "session-owner", runId: "run-session-owner" },
  );

  await assert.rejects(
    agent.resume(
      {
        runId: waiting.runId,
        approvals: [{
          approvalId: waiting.approvalRequests[0].approvalId,
          approved: true,
        }],
      },
      {},
      { sessionId: "session-attacker" },
    ),
    /does not belong to session/,
  );
  assert.equal((await agent.getRun(waiting.runId)).status, "waiting_for_approval");
});

test("AgentDock rejects duplicate run IDs without replacing the original run", async () => {
  const agent = createAgent(createScriptedModel([
    textResponse("The original run is complete."),
    textResponse("The duplicate run must not execute."),
  ]));

  await agent.run(
    "Create the original run.",
    {},
    { sessionId: "session-duplicate", runId: "run-duplicate" },
  );

  await assert.rejects(
    agent.run(
      "Reuse the run ID.",
      {},
      { sessionId: "session-duplicate", runId: "run-duplicate" },
    ),
    /already exists/,
  );
  assert.equal(
    (await agent.getRun("run-duplicate")).messages.at(-1).content,
    "The original run is complete.",
  );
});

test("AgentDock preserves both histories for concurrent runs in one session", async () => {
  const baseStore = new InMemoryAgentStore();
  let sessionReads = 0;
  const store = {
    runs: baseStore.runs,
    sessions: {
      get(sessionId) {
        if (sessionReads++ < 4) return null;
        return baseStore.sessions.get(sessionId);
      },
      save(record) {
        return baseStore.sessions.save(record);
      },
      update(sessionId, update) {
        return baseStore.sessions.update(sessionId, update);
      },
    },
  };
  const agent = createAgent(createScriptedModel([
    textResponse("First result."),
    textResponse("Second result."),
  ]), store);

  await Promise.all([
    agent.run("First request.", {}, { sessionId: "session-concurrent", runId: "run-first" }),
    agent.run("Second request.", {}, { sessionId: "session-concurrent", runId: "run-second" }),
  ]);

  const contents = (await agent.getSession("session-concurrent")).messages
    .map((message) => message.content);
  assert.ok(contents.includes("First request."));
  assert.ok(contents.includes("Second request."));
  assert.ok(contents.includes("First result."));
  assert.ok(contents.includes("Second result."));
});

test("AgentDock does not leave a run when session persistence fails", async () => {
  const baseStore = new InMemoryAgentStore();
  const store = {
    runs: baseStore.runs,
    sessions: {
      get: () => null,
      save: () => {
        throw new Error("Session persistence unavailable");
      },
      update: () => {
        throw new Error("Session persistence unavailable");
      },
    },
  };
  const agent = createAgent(createScriptedModel([textResponse("Unreachable.")]), store);

  await assert.rejects(
    agent.run(
      "Persist this run.",
      {},
      { sessionId: "session-persistence", runId: "run-persistence" },
    ),
    /Session persistence unavailable/,
  );
  assert.equal(await baseStore.runs.get("run-persistence"), null);
});

test("AgentDock clears the controller when terminal persistence fails", async () => {
  const baseStore = new InMemoryAgentStore();
  const store = {
    runs: baseStore.runs,
    sessions: {
      get: (sessionId) => baseStore.sessions.get(sessionId),
      save: (record) => baseStore.sessions.save(record),
      update: () => {
        throw new Error("Session update unavailable");
      },
    },
  };
  const agent = createAgent(createScriptedModel([textResponse("Complete.")]), store);

  await assert.rejects(
    agent.run(
      "Complete the run.",
      {},
      { sessionId: "session-controller", runId: "run-controller" },
    ),
  );
  assert.equal(stopRunController("run-controller"), false);
});

test("AgentDock reports that stopping a terminal run was ignored", async () => {
  const agent = createAgent(createScriptedModel([textResponse("Complete.")]));

  await agent.run(
    "Complete the run.",
    {},
    { sessionId: "session-terminal-stop", runId: "run-terminal-stop" },
  );

  assert.equal(await agent.stop("run-terminal-stop"), false);
});
