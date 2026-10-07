import assert from "node:assert/strict";
import type {
  ConversationRecords,
  ThreadRecord,
  OperationRecord,
  AttachmentRecord,
} from "../src/store.js";
import type { ConversationMessage } from "@agentdock-ai/contracts";

/** Shared behavioral contract: used against Memory and real Postgres adapters. */
export async function verifyConversationRecords(records: ConversationRecords) {
  const thread: ThreadRecord = {
    id: "contract-2",
    title: "Saved",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ownerHash: records.ownerHash,
    nextPosition: 0,
    nextTurn: 0,
    lastOperation: null,
    revision: 0,
  };
  await records.putThread(thread);
  const savedRevision = thread.revision;
  thread.title = "Unsaved title";
  thread.nextPosition = 99;
  const saved = await records.getThread(thread.id);
  assert.ok(saved);
  assert.equal(saved.title, "Saved");
  assert.equal(saved.nextPosition, 0);
  assert.equal(saved.revision, savedRevision);

  const operation: OperationRecord = {
    id: "receipt",
    action: "start",
    requestHash: "hash",
    turnId: "turn",
    status: "accepted",
    runId: null,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
    publishedPosition: 0,
  };
  await records.putOperation(thread.id, operation);
  operation.status = "running";
  assert.equal(
    (await records.getOperation(thread.id, operation.id))?.status,
    "accepted",
  );
  const message: ConversationMessage = {
    id: "message",
    turnId: "turn",
    operationId: "receipt",
    position: 0,
    role: "user",
    content: [{ type: "text", text: "Saved content" }],
    outcome: "complete",
    createdAt: saved.createdAt,
  };
  await records.putMessage(thread.id, message);
  if (message.content[0].type !== "text") throw new Error("Expected text");
  message.content[0].text = "Unsaved content";
  const content = (await records.listMessages(thread.id, 1, 1))[0].content[0];
  assert.ok(content.type === "text");
  assert.equal(content.text, "Saved content");
  const attachment: AttachmentRecord = {
    id: "image",
    threadId: thread.id,
    ownerHash: records.ownerHash,
    name: "Saved name",
    mimeType: "image/png",
    size: 8,
    storageRef: "reference",
    createdAt: saved.createdAt,
  };
  await records.putAttachment(thread.id, attachment);
  attachment.name = "Unsaved name";
  assert.equal(
    (await records.getAttachment(thread.id, attachment.id))?.name,
    "Saved name",
  );

  for (const [id, date] of [
    ["contract-1", "01"],
    ["contract-4", "03"],
    ["contract-3", "03"],
  ]) {
    await records.putThread({
      ...saved,
      id,
      updatedAt: `2026-01-${date}T00:00:00.000Z`,
      revision: 0,
    });
  }
  assert.deepEqual(
    (await records.listThreads(2, 0)).map((t) => t.id),
    ["contract-3", "contract-4", "contract-2"],
  );
  assert.deepEqual(
    (await records.listThreads(2, 2)).map((t) => t.id),
    ["contract-2", "contract-1"],
  );
  const older = await records.getThread("contract-1");
  assert.ok(older);
  older.updatedAt = "2026-01-04T00:00:00.000Z";
  await records.putThread(older);
  assert.equal((await records.listThreads(2, 0))[0].id, "contract-1");
}
