import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { FakeToolCallingModel } from "langchain";
import { SqliteCheckpoint } from "@agentdock/checkpoint-sqlite";
import { AgentDock, ToolRegistry } from "../../src/index.js";

test("persists a pending approval across AgentDock recreation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentdock-agent-"));
  const databasePath = path.join(directory, "checkpoints.sqlite");
  let executions = 0;

  try {
    const registry = new ToolRegistry();
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

    const firstAgent = new AgentDock({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: "publish_report",
              args: { reportId: "report-1" },
              id: "call-publish",
            },
          ],
        ],
      }),
      registry,
      checkpoint: new SqliteCheckpoint({ path: databasePath }),
    });

    const waiting = await firstAgent.run(
      "Publish the report.",
      {},
      { sessionId: "session-persisted", runId: "run-persisted" },
    );
    assert.equal(waiting.status, "waiting_for_approval");
    await firstAgent.close();

    const secondAgent = new AgentDock({
      model: new FakeToolCallingModel({ toolCalls: [[]] }),
      registry,
      checkpoint: new SqliteCheckpoint({ path: databasePath }),
    });

    const resumed = await secondAgent.resume(
      {
        runId: "run-persisted",
        approvals: [
          {
            approvalId: waiting.approvalRequests[0].approvalId,
            approved: true,
          },
        ],
      },
      {},
      { sessionId: "session-persisted" },
    );

    assert.equal(resumed.status, "completed");
    assert.equal(resumed.toolResults[0].output, "published");
    assert.equal(executions, 1);

    const session = await secondAgent.getSession("session-persisted");
    assert.ok(
      session.messages.some(
        (message) => message.content === "Publish the report.",
      ),
    );
    assert.ok(
      session.messages.some((message) => message.content.includes("published")),
    );
    await secondAgent.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restarts SQLite approval phases without replaying prior actions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentdock-agent-"));
  const databasePath = path.join(directory, "checkpoints.sqlite");
  const executions = [];
  const registry = new ToolRegistry();

  try {
    registry.register({
      name: "first_protected",
      description: "First protected action.",
      parameters: { type: "object", properties: {} },
      requiresApproval: true,
      execute: async () => {
        executions.push("first");
        return "first done";
      },
    });
    registry.register({
      name: "middle_unprotected",
      description: "Middle unprotected action.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        executions.push("middle");
        return "middle done";
      },
    });
    registry.register({
      name: "last_protected",
      description: "Last protected action.",
      parameters: { type: "object", properties: {} },
      requiresApproval: true,
      execute: async () => {
        executions.push("last");
        return "last done";
      },
    });

    const model = new FakeToolCallingModel({
      toolCalls: [
        [{ name: "first_protected", args: {}, id: "call-first" }],
        [{ name: "middle_unprotected", args: {}, id: "call-middle" }],
        [{ name: "last_protected", args: {}, id: "call-last" }],
        [],
      ],
    });
    const firstAgent = new AgentDock({
      model,
      registry,
      checkpoint: new SqliteCheckpoint({ path: databasePath }),
    });
    const firstWaiting = await firstAgent.run(
      "Run the three actions.",
      {},
      { sessionId: "session-sqlite-phases", runId: "run-sqlite-phases" },
    );
    assert.deepEqual(
      firstWaiting.approvalRequests.map((request) => request.approvalId),
      ["call-first"],
    );
    await firstAgent.close();

    const secondAgent = new AgentDock({
      model,
      registry,
      checkpoint: new SqliteCheckpoint({ path: databasePath }),
    });
    const secondWaiting = await secondAgent.resume(
      {
        runId: "run-sqlite-phases",
        approvals: [{ approvalId: "call-first", approved: true }],
      },
      {},
      { sessionId: "session-sqlite-phases" },
    );
    assert.deepEqual(
      secondWaiting.approvalRequests.map((request) => request.approvalId),
      ["call-last"],
    );
    assert.deepEqual(executions, ["first", "middle"]);
    await secondAgent.close();

    const thirdAgent = new AgentDock({
      model,
      registry,
      checkpoint: new SqliteCheckpoint({ path: databasePath }),
    });
    const completed = await thirdAgent.resume(
      {
        runId: "run-sqlite-phases",
        approvals: [{ approvalId: "call-last", approved: true }],
      },
      {},
      { sessionId: "session-sqlite-phases" },
    );

    assert.equal(completed.status, "completed");
    assert.deepEqual(executions, ["first", "middle", "last"]);
    await thirdAgent.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects incomplete or stale approval decisions against SQLite checkpoints", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentdock-agent-"));
  const databasePath = path.join(directory, "checkpoints.sqlite");
  let executions = 0;

  try {
    const registry = new ToolRegistry();
    for (const name of ["write_first", "write_second"]) {
      registry.register({
        name,
        description: `${name} protected data.`,
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        requiresApproval: true,
        execute: async () => {
          executions += 1;
          return "written";
        },
      });
    }

    const firstAgent = new AgentDock({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            { name: "write_first", args: { value: "one" }, id: "call-first" },
            { name: "write_second", args: { value: "two" }, id: "call-second" },
          ],
        ],
      }),
      registry,
      checkpoint: new SqliteCheckpoint({ path: databasePath }),
    });

    const waiting = await firstAgent.run(
      "Write both values.",
      {},
      { sessionId: "session-approvals", runId: "run-approvals" },
    );
    assert.equal(waiting.status, "waiting_for_approval");
    assert.deepEqual(
      waiting.approvalRequests.map((request) => request.approvalId),
      ["call-first", "call-second"],
    );
    await firstAgent.close();

    const secondAgent = new AgentDock({
      model: new FakeToolCallingModel({ toolCalls: [[]] }),
      registry,
      checkpoint: new SqliteCheckpoint({ path: databasePath }),
    });
    const firstApproval = {
      approvalId: "call-first",
      approved: true,
    };

    await assert.rejects(
      secondAgent.resume(
        { runId: "run-approvals", approvals: [firstApproval] },
        {},
        { sessionId: "session-approvals" },
      ),
      /Approval decisions do not match a pending AgentDock run/,
    );
    await assert.rejects(
      secondAgent.resume(
        {
          runId: "run-approvals",
          approvals: [
            firstApproval,
            { approvalId: "stale-approval", approved: true },
          ],
        },
        {},
        { sessionId: "session-approvals" },
      ),
      /Approval decisions do not match a pending AgentDock run/,
    );
    assert.equal(executions, 0);

    const resumed = await secondAgent.resume(
      {
        runId: "run-approvals",
        approvals: [
          firstApproval,
          { approvalId: "call-second", approved: true },
        ],
      },
      {},
      { sessionId: "session-approvals" },
    );

    assert.equal(resumed.status, "completed");
    assert.equal(executions, 2);

    await assert.rejects(
      secondAgent.resume(
        {
          runId: "run-approvals",
          approvals: [
            firstApproval,
            { approvalId: "call-second", approved: true },
          ],
        },
        {},
        { sessionId: "session-approvals" },
      ),
      /Approval decisions do not match a pending AgentDock run/,
    );
    await secondAgent.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
