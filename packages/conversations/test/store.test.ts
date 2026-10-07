import { expect, it } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import {
  ConversationRecords,
  createInMemoryConversationStore,
  createPostgresConversationStore,
} from "../src/index.js";
import { verifyConversationRecords } from "./store-contract.js";

it("runs the shared record-isolation and globally ordered catalog contract in memory", async () => {
  await verifyConversationRecords(
    new ConversationRecords(createInMemoryConversationStore(), "contract"),
  );
});

it("keeps the caller revision unchanged when a thread write fails", async () => {
  const store = new InMemoryStore();
  const records = new ConversationRecords(store, "contract");
  const thread = {
    id: "thread",
    title: "Saved",
    ownerHash: records.ownerHash,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextPosition: 0,
    nextTurn: 0,
    lastOperation: null,
    revision: 0,
  };
  store.put = async () => {
    throw new Error("unavailable");
  };
  await expect(records.putThread(thread)).rejects.toThrow("unavailable");
  expect(thread.revision).toBe(0);
  expect(await records.getThread(thread.id)).toBeNull();
});

it("requires ordered catalog capability instead of silently sorting a partial page", async () => {
  const records = new ConversationRecords(new InMemoryStore(), "contract");
  await expect(records.listThreads(2, 0)).rejects.toThrow(
    "ordered conversation Store",
  );
});

it("rejects unsafe SQL schemas before invoking a database", async () => {
  let calls = 0;
  await expect(
    createPostgresConversationStore(
      new InMemoryStore(),
      {
        async query() {
          calls++;
          return { rows: [] };
        },
      },
      'public";DROP TABLE store;',
    ),
  ).rejects.toThrow("SQL identifier");
  expect(calls).toBe(0);
});

it.each([
  { createdAt: "not-a-date" },
  { updatedAt: "2026-01-01T01:00:00+01:00" },
  { revision: -1 },
  { nextPosition: -1 },
  { nextTurn: 1.5 },
])("rejects corrupt thread fields %j", async (patch) => {
  const store = new InMemoryStore();
  const records = new ConversationRecords(store, "contract");
  const value = {
    id: "thread",
    title: "Saved",
    ownerHash: records.ownerHash,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextPosition: 0,
    nextTurn: 0,
    lastOperation: null,
    revision: 0,
    ...patch,
  };
  await store.put(
    ["agentdock-conversations", "v1", records.ownerHash, "threads"],
    Buffer.from(value.id).toString("base64url"),
    value,
  );
  await expect(records.getThread(value.id)).rejects.toThrow();
});

it.each([
  { publishedPosition: -1 },
  { outcome: "unknown" },
  { updatedAt: "bad" },
  { status: "unknown" },
])("rejects corrupt operation fields %j", async (patch) => {
  const store = new InMemoryStore();
  const records = new ConversationRecords(store, "contract");
  const operation = {
    id: "operation",
    action: "start",
    requestHash: "hash",
    turnId: "turn",
    status: "accepted",
    runId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    publishedPosition: 0,
    ...patch,
  };
  await store.put(
    [
      "agentdock-conversations",
      "v1",
      records.ownerHash,
      "thread-data",
      Buffer.from("thread").toString("base64url"),
      "operations",
    ],
    Buffer.from(operation.id).toString("base64url"),
    operation,
  );
  await expect(records.getOperation("thread", operation.id)).rejects.toThrow(
    "operation is invalid",
  );
});

it.each([{ size: -1 }, { size: 0 }, { createdAt: "bad" }, { storageRef: "" }])(
  "rejects corrupt attachment fields %j",
  async (patch) => {
    const store = new InMemoryStore();
    const records = new ConversationRecords(store, "contract");
    const attachment = {
      id: "image",
      threadId: "thread",
      ownerHash: records.ownerHash,
      name: "image.png",
      mimeType: "image/png",
      size: 8,
      storageRef: "reference",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...patch,
    };
    await store.put(
      [
        "agentdock-conversations",
        "v1",
        records.ownerHash,
        "thread-data",
        Buffer.from("thread").toString("base64url"),
        "attachments",
      ],
      Buffer.from(attachment.id).toString("base64url"),
      attachment,
    );
    await expect(
      records.getAttachment("thread", attachment.id),
    ).rejects.toThrow("attachment is invalid");
  },
);

it("uses bounded SQL ordering and reconstructs native Store items", async () => {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const store = await createPostgresConversationStore(new InMemoryStore(), {
    async query(sql, values) {
      calls.push({ sql, values });
      return {
        rows: values
          ? [
              {
                namespace_path: "agentdock-conversations:v1:owner:threads",
                key: "key",
                value: { id: "thread", updatedAt: createdAt.toISOString() },
                created_at: createdAt,
                updated_at: createdAt,
              },
            ]
          : [],
      };
    },
  });
  const namespace = ["agentdock-conversations", "v1", "owner", "threads"];
  const items = await store.searchThreads!(namespace, 3, 2);
  expect(calls[0].sql).toContain("CREATE INDEX IF NOT EXISTS");
  expect(calls[1].sql).toContain("LIMIT $2 OFFSET $3");
  expect(calls[1].sql).toContain("expires_at > CURRENT_TIMESTAMP");
  expect(calls[1].values).toEqual([namespace.join(":"), 3, 2]);
  expect(items[0]).toEqual({
    namespace,
    key: "key",
    value: { id: "thread", updatedAt: createdAt.toISOString() },
    createdAt,
    updatedAt: createdAt,
  });
});

it.each([{ value: null }, { value: [] }, { created_at: "bad" }, { key: 1 }])(
  "fails closed on a malformed SQL catalog row %j",
  async (patch) => {
    const date = new Date();
    const store = await createPostgresConversationStore(new InMemoryStore(), {
      async query(_sql, values) {
        return {
          rows: values
            ? [
                {
                  namespace_path: "namespace",
                  key: "key",
                  value: {},
                  created_at: date,
                  updated_at: date,
                  ...patch,
                },
              ]
            : [],
        };
      },
    });
    await expect(store.searchThreads!(["namespace"], 1, 0)).rejects.toThrow(
      "catalog row is invalid",
    );
  },
);
