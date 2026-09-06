import assert from "node:assert/strict";
import { test } from "vitest";
import { FakeToolCallingModel } from "langchain";
import { AgentDock, ToolRegistry } from "../../src/index.js";

test("AgentDock closes active runs after aborting their tool work", async () => {
  const registry = new ToolRegistry();
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  registry.register({
    name: "wait_for_close",
    description: "Wait until AgentDock closes.",
    parameters: { type: "object", properties: {} },
    execute: async ({ signal }) => {
      notifyStarted();
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });

  const agent = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [[{ name: "wait_for_close", args: {}, id: "call-close" }]],
    }),
    registry,
  });
  const execution = await agent.stream(
    "Close this run.",
    {},
    { sessionId: "session-close", runId: "run-close" },
  );

  await started;
  const closing = agent.close();
  const result = await execution.result;
  await closing;

  assert.equal(result.status, "cancelled");
  await assert.rejects(
    () => agent.initialize(),
    /AgentDock is closed or closing/,
  );
});

test("AgentDock makes close idempotent while a run is active", async () => {
  const registry = new ToolRegistry();
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  registry.register({
    name: "wait_for_idempotent_close",
    description: "Wait until AgentDock closes.",
    parameters: { type: "object", properties: {} },
    execute: async ({ signal }) => {
      notifyStarted();
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });

  const agent = new AgentDock({
    model: new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: "wait_for_idempotent_close",
            args: {},
            id: "call-idempotent-close",
          },
        ],
      ],
    }),
    registry,
  });
  const execution = await agent.stream(
    "Close this run once.",
    {},
    { sessionId: "session-idempotent-close", runId: "run-idempotent-close" },
  );

  await started;
  const firstClose = agent.close();
  const secondClose = agent.close();
  assert.equal(firstClose, secondClose);

  await execution.result;
  await firstClose;
});
