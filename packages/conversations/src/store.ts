import { createHash } from "node:crypto";
import type {
  BaseStore,
  Item,
  SearchItem,
} from "@langchain/langgraph-checkpoint";
import {
  assertConversationMessage,
  type ConversationMessage,
  type ConversationThread,
} from "@agentdock-ai/contracts";

export type ConversationStore = Pick<
  BaseStore,
  "get" | "search" | "delete" | "batch"
> & {
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
    const record = parseThread(item, this.ownerHash);
    if (record.id !== id) throw new Error("Conversation thread ID is corrupt.");
    return record;
  }

  async putThread(thread: ThreadRecord): Promise<void> {
    thread.revision += 1;
    await this.store.put(
      this.threadCatalog(),
      key(thread.id),
      thread as unknown as Record<string, unknown>,
    );
  }

  async listThreads(limit: number, offset: number): Promise<ThreadRecord[]> {
    const items = await this.store.search(this.threadCatalog(), {
      limit: limit + 1,
      offset,
    });
    return items.map((item) => parseThread(item, this.ownerHash));
  }

  async putMessage(
    threadId: string,
    message: ConversationMessage,
  ): Promise<void> {
    await this.store.put(
      [...this.threadData(threadId), "messages"],
      positionKey(message.position),
      message as unknown as Record<string, unknown>,
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
    const page = items.flatMap((item) => (item ? [parseMessage(item)] : []));
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
    return item ? parseOperation(item) : null;
  }

  async putOperation(
    threadId: string,
    operation: OperationRecord,
  ): Promise<void> {
    await this.store.put(
      [...this.threadData(threadId), "operations"],
      key(operation.id),
      operation as unknown as Record<string, unknown>,
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
      attachment as unknown as Record<string, unknown>,
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
    const value = item.value;
    if (
      !isRecord(value) ||
      value.id !== id ||
      value.threadId !== threadId ||
      value.ownerHash !== this.ownerHash ||
      typeof value.name !== "string" ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        String(value.mimeType),
      ) ||
      !Number.isSafeInteger(value.size) ||
      typeof value.storageRef !== "string" ||
      typeof value.createdAt !== "string"
    )
      throw new Error("Stored conversation attachment is invalid.");
    return structuredClone(value) as unknown as AttachmentRecord;
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

function parseThread(item: Item | SearchItem, ownerHash: string): ThreadRecord {
  const value = item.value;
  if (
    !isRecord(value) ||
    value.ownerHash !== ownerHash ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Number.isSafeInteger(value.nextPosition) ||
    !Number.isSafeInteger(value.revision) ||
    !Number.isSafeInteger(value.nextTurn) ||
    (value.nextPosition as number) < 0 ||
    (value.nextTurn as number) < 0
  )
    throw new Error("Stored conversation thread is invalid.");
  if (value.lastOperation !== null)
    parseOperation({
      ...item,
      value: value.lastOperation as Record<string, unknown>,
    });
  return structuredClone(value) as unknown as ThreadRecord;
}

function parseMessage(item: Item | SearchItem): ConversationMessage {
  assertConversationMessage(item.value);
  return structuredClone(item.value) as unknown as ConversationMessage;
}

function parseOperation(item: Item | SearchItem): OperationRecord {
  const value = item.value;
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !["start", "continue", "approval"].includes(String(value.action)) ||
    typeof value.requestHash !== "string" ||
    typeof value.turnId !== "string" ||
    !["accepted", "running", "paused", "settled", "uncertain"].includes(
      String(value.status),
    ) ||
    (value.runId !== null && typeof value.runId !== "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Number.isSafeInteger(value.publishedPosition)
  )
    throw new Error("Stored conversation operation is invalid.");
  return structuredClone(value) as unknown as OperationRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
