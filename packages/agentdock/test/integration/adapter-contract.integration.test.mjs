import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import { FakeToolCallingModel } from "langchain";
import { MemoryCheckpoint } from "@agentdock/checkpoint";
import { MongoDBCheckpoint } from "@agentdock/checkpoint-mongodb";
import { PostgresCheckpoint } from "@agentdock/checkpoint-postgres";
import { RedisCheckpoint } from "@agentdock/checkpoint-redis";
import { SqliteCheckpoint } from "@agentdock/checkpoint-sqlite";
import { AgentDock, ToolRegistry, createThreadId } from "../../src/index.js";

const externalId = crypto.randomUUID().replaceAll("-", "");
const requireExternalServices = process.env.AGENTDOCK_REQUIRE_SERVICES === "1";
const testId = (value) => `${value}-${externalId}`;

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

const adapterFactories = [
  {
    name: "Memory",
    enabled: true,
    async createStorage() {
      const adapter = new MemoryCheckpoint();
      return {
        create: () => adapter,
        dispose: async () => {},
      };
    },
  },
  {
    name: "SQLite",
    enabled: true,
    async createStorage() {
      const directory = await mkdtemp(path.join(tmpdir(), "agentdock-"));
      const databasePath = path.join(directory, "checkpoints.sqlite");
      return {
        create: () => new SqliteCheckpoint({ path: databasePath }),
        dispose: () => rm(directory, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "PostgreSQL",
    enabled:
      requireExternalServices ||
      Boolean(process.env.AGENTDOCK_TEST_POSTGRES_URL),
    async createStorage() {
      const connectionString = process.env.AGENTDOCK_TEST_POSTGRES_URL;
      if (!connectionString) throw new Error("PostgreSQL test URL is missing.");
      const schema = `agentdock_${externalId}`;
      return {
        create: () => new PostgresCheckpoint({ connectionString, schema }),
        dispose: async () => {},
      };
    },
  },
  {
    name: "MongoDB",
    enabled:
      requireExternalServices ||
      Boolean(process.env.AGENTDOCK_TEST_MONGODB_URL),
    async createStorage() {
      const connectionString = process.env.AGENTDOCK_TEST_MONGODB_URL;
      if (!connectionString) throw new Error("MongoDB test URL is missing.");
      return {
        create: () =>
          new MongoDBCheckpoint({
            connectionString,
            database: `agentdock_${externalId}`,
            collection: "checkpoints",
            writesCollection: "checkpoint_writes",
          }),
        dispose: async () => {},
      };
    },
  },
  {
    name: "Redis",
    enabled:
      requireExternalServices || Boolean(process.env.AGENTDOCK_TEST_REDIS_URL),
    async createStorage() {
      const url = process.env.AGENTDOCK_TEST_REDIS_URL;
      if (!url) throw new Error("Redis test URL is missing.");
      return {
        create: () => new RedisCheckpoint({ url }),
        dispose: async () => {},
      };
    },
  },
].filter((factory) => factory.enabled);

for (const factory of adapterFactories) {
  describe(`${factory.name} AgentDock adapter contract`, () => {
    test("initializes and closes idempotently", async () => {
      const storage = await factory.createStorage();
      const adapter = storage.create();
      await Promise.all([adapter.initialize(), adapter.initialize()]);
      await adapter.initialize();
      await adapter.close();
      await adapter.close();
      await storage.dispose();
    });

    test("persists tool messages and structured output across restart", async () => {
      const storage = await factory.createStorage();
      let executions = 0;
      const registry = new ToolRegistry();
      registry.register({
        name: "lookup_weather",
        description: "Look up weather.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
        execute: async () => {
          executions += 1;
          return { city: "Lahore", forecast: "sunny" };
        },
      });

      const firstAdapter = storage.create();
      const first = new AgentDock({
        model: new FakeToolCallingModel({
          toolCalls: [
            [
              {
                name: "lookup_weather",
                args: { city: "Lahore" },
                id: "call-weather",
              },
            ],
            [],
          ],
        }),
        registry,
        checkpoint: firstAdapter,
      });
      const result = await first.run(
        "What is the weather?",
        {},
        { sessionId: testId("adapter-session"), runId: testId("adapter-run") },
      );
      assert.equal(result.status, "completed");
      await first.close();

      const second = new AgentDock({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        registry,
        checkpoint: storage.create(),
      });
      const session = await second.getSession(testId("adapter-session"));
      assert.ok(session);
      assert.equal(executions, 1);
      assert.ok(
        session.messages.some(
          (message) =>
            message.role === "tool" &&
            messageToolResults(message)[0].output.forecast === "sunny",
        ),
      );
      await second.close();
      await storage.dispose();
    });

    test("persists approval interruption and resumes exactly once after restart", async () => {
      const storage = await factory.createStorage();
      let executions = 0;
      const executedToolCallIds = [];
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
        execute: async ({ toolCallId }) => {
          executions += 1;
          executedToolCallIds.push(toolCallId);
          return "published";
        },
      });

      const firstAdapter = storage.create();
      const first = new AgentDock({
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
        checkpoint: firstAdapter,
      });
      const waiting = await first.run(
        "Publish the report.",
        {},
        {
          sessionId: testId("approval-session"),
          runId: testId("approval-run"),
        },
      );
      assert.equal(waiting.status, "waiting_for_approval");
      const checkpoint = await firstAdapter.saver.getTuple({
        configurable: {
          thread_id: createThreadId(testId("approval-session"), undefined),
        },
      });
      assert.ok(checkpoint);
      assert.ok(checkpoint.pendingWrites.length > 0);
      assert.equal(
        checkpoint.checkpoint.channel_values.agentdockRunId,
        testId("approval-run"),
      );
      await first.close();

      const second = new AgentDock({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        registry,
        checkpoint: storage.create(),
      });
      const resumed = await second.resume(
        {
          runId: testId("approval-run"),
          approvals: [
            {
              approvalId: waiting.approvalRequests[0].approvalId,
              approved: true,
            },
          ],
        },
        {},
        { sessionId: testId("approval-session") },
      );
      assert.equal(resumed.status, "completed");
      assert.equal(resumed.toolResults.length, 1);
      assert.equal(executions, 1);
      assert.deepEqual(executedToolCallIds, ["call-publish"]);
      await second.close();
      await storage.dispose();
    });

    test("resumes sequential approval phases across restarts without replay", async () => {
      const storage = await factory.createStorage();
      const executions = [];
      const registry = new ToolRegistry();
      for (const name of ["first_protected", "second_protected"]) {
        registry.register({
          name,
          description: `${name} action.`,
          parameters: { type: "object", properties: {} },
          requiresApproval: true,
          execute: async () => {
            executions.push(name);
            return `${name} complete`;
          },
        });
      }
      const model = new FakeToolCallingModel({
        toolCalls: [
          [{ name: "first_protected", args: {}, id: "call-first" }],
          [{ name: "second_protected", args: {}, id: "call-second" }],
          [],
        ],
      });
      const sessionId = testId("sequential-session");
      const runId = testId("sequential-run");

      const first = new AgentDock({
        model,
        registry,
        checkpoint: storage.create(),
      });
      const firstWaiting = await first.run(
        "Run both.",
        {},
        { sessionId, runId },
      );
      assert.deepEqual(
        firstWaiting.approvalRequests.map(
          (request) => request.toolCall.toolCallId,
        ),
        ["call-first"],
      );
      await first.close();

      const second = new AgentDock({
        model,
        registry,
        checkpoint: storage.create(),
      });
      const secondWaiting = await second.resume(
        {
          runId,
          approvals: [
            {
              approvalId: firstWaiting.approvalRequests[0].approvalId,
              approved: true,
            },
          ],
        },
        {},
        { sessionId },
      );
      assert.equal(secondWaiting.status, "waiting_for_approval");
      assert.deepEqual(
        secondWaiting.approvalRequests.map(
          (request) => request.toolCall.toolCallId,
        ),
        ["call-second"],
      );
      await second.close();

      const third = new AgentDock({
        model,
        registry,
        checkpoint: storage.create(),
      });
      const completed = await third.resume(
        {
          runId,
          approvals: [
            {
              approvalId: secondWaiting.approvalRequests[0].approvalId,
              approved: true,
            },
          ],
        },
        {},
        { sessionId },
      );
      assert.equal(completed.status, "completed");
      assert.deepEqual(executions, ["first_protected", "second_protected"]);
      assert.deepEqual(
        completed.toolResults.map((result) => result.toolCallId),
        ["call-first", "call-second"],
      );
      await third.close();
      await storage.dispose();
    });

    test("persists normalized session history across restart", async () => {
      const storage = await factory.createStorage();
      const sessionId = testId("history-session");
      const first = new AgentDock({
        model: new FakeToolCallingModel({ toolCalls: [[], []] }),
        checkpoint: storage.create(),
      });
      await first.run(
        "First message.",
        {},
        {
          sessionId,
          runId: testId("history-run-one"),
        },
      );
      await first.run(
        "Second message.",
        {},
        {
          sessionId,
          runId: testId("history-run-two"),
        },
      );
      await first.close();

      const second = new AgentDock({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        checkpoint: storage.create(),
      });
      const history = await second.getSessionHistory(sessionId);
      assert.ok(history.current);
      assert.deepEqual(
        history.current.messages
          .filter((message) => message.role === "user")
          .map((message) => contentText(message.content)),
        ["First message.", "Second message."],
      );
      assert.ok(history.checkpoints.length >= 2);
      assert.ok(
        history.checkpoints.some(
          (checkpoint) => checkpoint.runId === testId("history-run-two"),
        ),
      );
      await second.close();
      await storage.dispose();
    });

    test("writes different sessions concurrently without collision", async () => {
      const storage = await factory.createStorage();
      const agent = new AgentDock({
        model: new FakeToolCallingModel({ toolCalls: [[], []] }),
        checkpoint: storage.create(),
      });
      const [first, second] = await Promise.all([
        agent.run(
          "Session one.",
          {},
          {
            sessionId: testId("concurrent-one"),
            runId: testId("concurrent-run-one"),
          },
        ),
        agent.run(
          "Session two.",
          {},
          {
            sessionId: testId("concurrent-two"),
            runId: testId("concurrent-run-two"),
          },
        ),
      ]);
      assert.equal(first.status, "completed");
      assert.equal(second.status, "completed");
      assert.equal(
        contentText(
          (await agent.getSession(testId("concurrent-one"))).messages[0]
            .content,
        ),
        "Session one.",
      );
      assert.equal(
        contentText(
          (await agent.getSession(testId("concurrent-two"))).messages[0]
            .content,
        ),
        "Session two.",
      );
      await agent.close();
      await storage.dispose();
    });

    test("deletes model-visible history and permits clean session reuse", async () => {
      const storage = await factory.createStorage();
      const first = new AgentDock({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        checkpoint: storage.create(),
      });
      await first.run(
        "Old session message.",
        {},
        { sessionId: testId("delete-session"), runId: testId("delete-run") },
      );
      await first.close();

      const second = new AgentDock({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        checkpoint: storage.create(),
      });
      await second.deleteSession(testId("delete-session"));
      assert.equal(await second.getSession(testId("delete-session")), null);
      await second.close();

      const third = new AgentDock({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        checkpoint: storage.create(),
      });
      await third.run(
        "New session message.",
        {},
        { sessionId: testId("delete-session"), runId: testId("new-run") },
      );
      const session = await third.getSession(testId("delete-session"));
      assert.ok(session);
      assert.ok(
        session.messages.every(
          (message) => contentText(message.content) !== "Old session message.",
        ),
      );
      await third.close();
      await storage.dispose();
    });

    test("deletes an interrupted session after recreation", async () => {
      const storage = await factory.createStorage();
      const registry = new ToolRegistry();
      registry.register({
        name: "delete_pending",
        description: "Create a pending approval.",
        parameters: { type: "object", properties: {} },
        requiresApproval: true,
        execute: async () => "unexpected",
      });
      const sessionId = testId("delete-interrupted-session");
      const runId = testId("delete-interrupted-run");
      const first = new AgentDock({
        model: new FakeToolCallingModel({
          toolCalls: [
            [{ name: "delete_pending", args: {}, id: "call-delete-pending" }],
          ],
        }),
        registry,
        checkpoint: storage.create(),
      });
      const waiting = await first.run(
        "Wait for approval.",
        {},
        {
          sessionId,
          runId,
        },
      );
      assert.equal(waiting.status, "waiting_for_approval");
      await first.close();

      const second = new AgentDock({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        registry,
        checkpoint: storage.create(),
      });
      await second.deleteSession(sessionId);
      assert.equal(await second.getSession(sessionId), null);
      await assert.rejects(
        second.resume(
          {
            runId,
            approvals: [
              {
                approvalId: waiting.approvalRequests[0].approvalId,
                approved: true,
              },
            ],
          },
          {},
          { sessionId },
        ),
        /run ID does not match the checkpoint/,
      );
      const fresh = await second.run(
        "Fresh after deletion.",
        {},
        {
          sessionId,
          runId: testId("fresh-after-interrupt-delete"),
        },
      );
      assert.deepEqual(
        fresh.messages
          .filter((message) => message.role === "user")
          .map((message) => contentText(message.content)),
        ["Fresh after deletion."],
      );
      await second.close();
      await storage.dispose();
    });
  });
}

test.skipIf(!process.env.AGENTDOCK_TEST_POSTGRES_URL)(
  "PostgreSQL schemas isolate identical session IDs",
  async () => {
    const connectionString = process.env.AGENTDOCK_TEST_POSTGRES_URL;
    const sessionId = testId("postgres-schema-session");
    const first = new AgentDock({
      model: new FakeToolCallingModel({ toolCalls: [[]] }),
      checkpoint: new PostgresCheckpoint({
        connectionString,
        schema: `agentdock_${externalId}_a`,
      }),
    });
    const second = new AgentDock({
      model: new FakeToolCallingModel({ toolCalls: [[]] }),
      checkpoint: new PostgresCheckpoint({
        connectionString,
        schema: `agentdock_${externalId}_b`,
      }),
    });
    await first.run("Schema A.", {}, { sessionId, runId: testId("schema-a") });
    await second.run("Schema B.", {}, { sessionId, runId: testId("schema-b") });

    assert.equal(
      contentText((await first.getSession(sessionId)).messages[0].content),
      "Schema A.",
    );
    assert.equal(
      contentText((await second.getSession(sessionId)).messages[0].content),
      "Schema B.",
    );
    await Promise.all([first.close(), second.close()]);
  },
);

test.skipIf(!process.env.AGENTDOCK_TEST_MONGODB_URL)(
  "MongoDB collection pairs isolate identical session IDs",
  async () => {
    const connectionString = process.env.AGENTDOCK_TEST_MONGODB_URL;
    const database = `agentdock_${externalId}_collections`;
    const sessionId = testId("mongo-collection-session");
    const createCheckpoint = (suffix) =>
      new MongoDBCheckpoint({
        connectionString,
        database,
        collection: `checkpoints_${suffix}`,
        writesCollection: `writes_${suffix}`,
      });
    const first = new AgentDock({
      model: new FakeToolCallingModel({ toolCalls: [[]] }),
      checkpoint: createCheckpoint("a"),
    });
    const second = new AgentDock({
      model: new FakeToolCallingModel({ toolCalls: [[]] }),
      checkpoint: createCheckpoint("b"),
    });
    await first.run(
      "Collection A.",
      {},
      {
        sessionId,
        runId: testId("collection-a"),
      },
    );
    await second.run(
      "Collection B.",
      {},
      {
        sessionId,
        runId: testId("collection-b"),
      },
    );

    assert.equal(
      contentText((await first.getSession(sessionId)).messages[0].content),
      "Collection A.",
    );
    assert.equal(
      contentText((await second.getSession(sessionId)).messages[0].content),
      "Collection B.",
    );
    await Promise.all([first.close(), second.close()]);
  },
);

test.skipIf(!process.env.AGENTDOCK_TEST_REDIS_URL)(
  "Redis expires checkpoint state according to its TTL",
  async () => {
    const sessionId = testId("redis-ttl-session");
    const agent = new AgentDock({
      model: new FakeToolCallingModel({ toolCalls: [[]] }),
      checkpoint: new RedisCheckpoint({
        url: process.env.AGENTDOCK_TEST_REDIS_URL,
        ttl: { defaultTTL: 0.02, refreshOnRead: false },
      }),
    });
    await agent.run(
      "Expires.",
      {},
      {
        sessionId,
        runId: testId("redis-ttl-run"),
      },
    );
    assert.ok(await agent.getSession(sessionId));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(await agent.getSession(sessionId), null);
    await agent.close();
  },
);
