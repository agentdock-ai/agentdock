import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import { FakeToolCallingModel } from "langchain";
import { MongoDBCheckpoint } from "@agentdock/checkpoint-mongodb";
import { PostgresCheckpoint } from "@agentdock/checkpoint-postgres";
import { RedisCheckpoint } from "@agentdock/checkpoint-redis";
import { SqliteCheckpoint } from "@agentdock/checkpoint-sqlite";
import { AgentDock, ToolRegistry } from "../../src/index.js";

const externalId = crypto.randomUUID().replaceAll("-", "");

const adapterFactories = [
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
    enabled: Boolean(process.env.AGENTDOCK_TEST_POSTGRES_URL),
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
    enabled: Boolean(process.env.AGENTDOCK_TEST_MONGODB_URL),
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
    enabled: Boolean(process.env.AGENTDOCK_TEST_REDIS_URL),
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
      await adapter.initialize();
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
        checkpoint: storage.create(),
      });
      const result = await first.run(
        "What is the weather?",
        {},
        { sessionId: "adapter-session", runId: "adapter-run" },
      );
      assert.equal(result.status, "completed");
      await first.close();

      const second = new AgentDock({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        registry,
        checkpoint: storage.create(),
      });
      const session = await second.getSession("adapter-session");
      assert.ok(session);
      assert.equal(executions, 1);
      assert.ok(
        session.messages.some(
          (message) =>
            message.role === "tool" &&
            message.toolResults[0].output.forecast === "sunny",
        ),
      );
      await second.close();
      await storage.dispose();
    });

    test("persists approval interruption and resumes exactly once after restart", async () => {
      const storage = await factory.createStorage();
      let executions = 0;
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
        checkpoint: storage.create(),
      });
      const waiting = await first.run(
        "Publish the report.",
        {},
        { sessionId: "approval-session", runId: "approval-run" },
      );
      assert.equal(waiting.status, "waiting_for_approval");
      await first.close();

      const second = new AgentDock({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        registry,
        checkpoint: storage.create(),
      });
      const resumed = await second.resume(
        {
          runId: "approval-run",
          approvals: [
            {
              approvalId: waiting.approvalRequests[0].approvalId,
              approved: true,
            },
          ],
        },
        {},
        { sessionId: "approval-session" },
      );
      assert.equal(resumed.status, "completed");
      assert.equal(resumed.toolResults.length, 1);
      assert.equal(executions, 1);
      await second.close();
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
        { sessionId: "delete-session", runId: "delete-run" },
      );
      await first.close();

      const second = new AgentDock({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        checkpoint: storage.create(),
      });
      await second.deleteSession("delete-session");
      assert.equal(await second.getSession("delete-session"), null);
      await second.close();

      const third = new AgentDock({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        checkpoint: storage.create(),
      });
      await third.run(
        "New session message.",
        {},
        { sessionId: "delete-session", runId: "new-run" },
      );
      const session = await third.getSession("delete-session");
      assert.ok(session);
      assert.ok(
        session.messages.every(
          (message) => message.content !== "Old session message.",
        ),
      );
      await third.close();
      await storage.dispose();
    });
  });
}
