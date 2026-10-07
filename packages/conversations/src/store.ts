import { createHash } from "node:crypto";
import type { BaseStore, Item } from "@langchain/langgraph-checkpoint";
import {
  assertConversationMessage,
  assertConversationThread,
  type ConversationMessage,
  type ConversationThread,
} from "@agentdock-ai/contracts";

export type ConversationStore = Pick<BaseStore, "get" | "delete" | "batch"> & {
  searchThreads?(
    namespace: string[],
    limit: number,
    offset: number,
  ): Promise<Item[]>;
  put(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    index?: false | string[],
    options?: { ttl?: number },
  ): Promise<void>;
};

export interface ThreadRecord extends ConversationThread {
  ownerHash: string;
  nextPosition: number;
  nextTurn: number;
  lastOperation: OperationRecord | null;
  revision: number;
}

export interface OperationRecord {
  id: string;
  action: "start" | "continue" | "approval";
  requestHash: string;
  turnId: string;
  status: "accepted" | "running" | "paused" | "settled" | "uncertain";
  runId: string | null;
  createdAt: string;
  updatedAt: string;
  outcome?: "complete" | "stopped" | "error";
  publishedPosition: number;
}

export interface AttachmentRecord {
  id: string;
  threadId: string;
  ownerHash: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  size: number;
  storageRef: string;
  createdAt: string;
}

export class ConversationRecords {
  private readonly root: string[];
  readonly ownerHash: string;

  constructor(
    private readonly store: ConversationStore,
    actorId: string,
  ) {
    if (typeof actorId !== "string" || actorId.trim().length === 0)
      throw new Error("Trusted actor ID must be a non-empty string.");
    this.ownerHash = createHash("sha256").update(actorId).digest("hex");
    this.root = ["agentdock-conversations", "v1", this.ownerHash];
  }

  async getThread(id: string): Promise<ThreadRecord | null> {
    const item = await this.store.get(this.threadCatalog(), key(id));
    if (!item) return null;
    const record = parseThread(item.value, this.ownerHash);
    if (record.id !== id) throw new Error("Conversation thread ID is corrupt.");
    return record;
  }

  async putThread(thread: ThreadRecord): Promise<void> {
    const revision = thread.revision + 1;
    await this.store.put(
      this.threadCatalog(),
      key(thread.id),
      { ...parseThread({ ...thread, revision }, this.ownerHash) },
      false,
    );
    thread.revision = revision;
  }

  async listThreads(limit: number, offset: number): Promise<ThreadRecord[]> {
    if (!this.store.searchThreads)
      throw new Error(
        "Thread listing requires an ordered conversation Store adapter.",
      );
    const items = await this.store.searchThreads(
      this.threadCatalog(),
      limit + 1,
      offset,
    );
    return items.map((item) => parseThread(item.value, this.ownerHash));
  }

  async putMessage(
    threadId: string,
    message: ConversationMessage,
  ): Promise<void> {
    assertConversationMessage(message);
    await this.store.put(
      [...this.threadData(threadId), "messages"],
      positionKey(message.position),
      structuredClone({ ...message }),
      false,
    );
  }

  async listMessages(
    threadId: string,
    limit: number,
    beforePosition: number,
  ): Promise<ConversationMessage[]> {
    const firstPosition = Math.max(0, beforePosition - limit);
    const namespace = [...this.threadData(threadId), "messages"];
    const positions = Array.from(
      { length: beforePosition - firstPosition },
      (_, index) => firstPosition + index,
    );
    const items = await this.store.batch(
      positions.map((position) => ({
        namespace,
        key: positionKey(position),
      })),
    );
    if (items.some((item) => item === null))
      throw new Error("Durable transcript positions are missing.");
    const page = items.flatMap((item) =>
      item ? [parseMessage(item.value)] : [],
    );
    return page.sort((left, right) => left.position - right.position);
  }

  async getOperation(
    threadId: string,
    id: string,
  ): Promise<OperationRecord | null> {
    const item = await this.store.get(
      [...this.threadData(threadId), "operations"],
      key(id),
    );
    return item ? parseOperation(item.value) : null;
  }

  async putOperation(
    threadId: string,
    operation: OperationRecord,
  ): Promise<void> {
    await this.store.put(
      [...this.threadData(threadId), "operations"],
      key(operation.id),
      { ...parseOperation(operation) },
      false,
      operation.status === "settled" ? { ttl: 10_080 } : undefined,
    );
  }

  async putAttachment(
    threadId: string,
    attachment: AttachmentRecord,
  ): Promise<void> {
    await this.store.put(
      [...this.threadData(threadId), "attachments"],
      key(attachment.id),
      { ...parseAttachment(attachment) },
      false,
    );
  }

  async getAttachment(
    threadId: string,
    id: string,
  ): Promise<AttachmentRecord | null> {
    const item = await this.store.get(
      [...this.threadData(threadId), "attachments"],
      key(id),
    );
    if (!item) return null;
    const record = parseAttachment(item.value);
    if (
      record.id !== id ||
      record.threadId !== threadId ||
      record.ownerHash !== this.ownerHash
    )
      throw new Error("Stored conversation attachment ownership is invalid.");
    return record;
  }

  async deleteAttachment(threadId: string, id: string): Promise<void> {
    await this.store.delete(
      [...this.threadData(threadId), "attachments"],
      key(id),
    );
  }

  private threadCatalog(): string[] {
    return [...this.root, "threads"];
  }

  private threadData(threadId: string): string[] {
    return [...this.root, "thread-data", key(threadId)];
  }
}

function key(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function positionKey(position: number): string {
  return String(position).padStart(16, "0");
}

function parseThread(value: unknown, ownerHash: string): ThreadRecord {
  assertConversationThread(value);
  if (
    !isRecord(value) ||
    value.ownerHash !== ownerHash ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isCounter(value.nextPosition) ||
    !isCounter(value.nextTurn) ||
    !isCounter(value.revision)
  )
    throw new Error("Stored conversation thread is invalid.");
  return {
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ownerHash,
    nextPosition: value.nextPosition,
    nextTurn: value.nextTurn,
    revision: value.revision,
    lastOperation:
      value.lastOperation === null ? null : parseOperation(value.lastOperation),
  };
}

function parseMessage(value: unknown): ConversationMessage {
  assertConversationMessage(value);
  return structuredClone(value);
}

function parseOperation(value: unknown): OperationRecord {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    (value.action !== "start" &&
      value.action !== "continue" &&
      value.action !== "approval") ||
    !isId(value.requestHash) ||
    !isId(value.turnId) ||
    (value.status !== "accepted" &&
      value.status !== "running" &&
      value.status !== "paused" &&
      value.status !== "settled" &&
      value.status !== "uncertain") ||
    (value.runId !== null && !isId(value.runId)) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isCounter(value.publishedPosition) ||
    (value.outcome !== undefined &&
      value.outcome !== "complete" &&
      value.outcome !== "stopped" &&
      value.outcome !== "error")
  )
    throw new Error("Stored conversation operation is invalid.");
  return {
    id: value.id,
    action: value.action,
    requestHash: value.requestHash,
    turnId: value.turnId,
    status: value.status,
    runId: value.runId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    publishedPosition: value.publishedPosition,
    ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
  };
}

function parseAttachment(value: unknown): AttachmentRecord {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.threadId) ||
    !isId(value.ownerHash) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    (value.mimeType !== "image/png" &&
      value.mimeType !== "image/jpeg" &&
      value.mimeType !== "image/gif" &&
      value.mimeType !== "image/webp") ||
    !isCounter(value.size) ||
    value.size === 0 ||
    typeof value.storageRef !== "string" ||
    value.storageRef.length === 0 ||
    !isTimestamp(value.createdAt)
  )
    throw new Error("Stored conversation attachment is invalid.");
  return {
    id: value.id,
    threadId: value.threadId,
    ownerHash: value.ownerHash,
    name: value.name,
    mimeType: value.mimeType,
    size: value.size,
    storageRef: value.storageRef,
    createdAt: value.createdAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Canonical UTC timestamps keep catalog ordering identical in Memory and SQL.
function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
