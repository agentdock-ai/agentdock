import { randomUUID } from "node:crypto";
import type { ConversationAttachment } from "@agentdock-ai/contracts";
import {
  ConversationRecords,
  type ConversationStore,
  type AttachmentRecord,
} from "./store.js";
import type {
  ConversationFileStorage,
  ConversationInputAttachment,
  ConversationUpload,
} from "./attachment-storage.js";
import { conversationError, requireThread } from "./service-utils.js";

export class ConversationAttachments {
  constructor(
    private readonly store: ConversationStore,
    private readonly storage: ConversationFileStorage | undefined,
    private readonly maxBytes: number,
  ) {}
  async upload(
    actorId: string,
    threadId: string,
    upload: ConversationUpload,
  ): Promise<ConversationAttachment> {
    if (!this.storage)
      throw conversationError(503, "Attachment storage is not configured.");
    const records = this.records(actorId);
    await requireThread(records, threadId);
    const name = validateAttachmentName(upload.name);
    const mimeType = sniffImage(upload.bytes);
    if (!mimeType || mimeType !== upload.mimeType)
      throw conversationError(
        415,
        "Upload a valid PNG, JPEG, GIF, or WebP image.",
      );
    if (upload.bytes.byteLength < 1 || upload.bytes.byteLength > this.maxBytes)
      throw conversationError(
        413,
        "Image is empty or exceeds the configured size limit.",
      );
    const id = randomUUID();
    const storageRef = await this.storage.put({
      id,
      mimeType,
      bytes: upload.bytes,
    });
    const record: AttachmentRecord = {
      id,
      threadId,
      ownerHash: records.ownerHash,
      name,
      mimeType,
      size: upload.bytes.byteLength,
      storageRef,
      createdAt: new Date().toISOString(),
    };
    try {
      await records.putAttachment(threadId, record);
    } catch (error) {
      try {
        await this.storage.delete(storageRef);
      } catch {
        throw conversationError(
          503,
          "Attachment reference persistence failed and orphan cleanup also failed.",
        );
      }
      throw conversationError(503, "Attachment reference persistence failed.");
    }
    return publicAttachment(record);
  }

  async read(
    actorId: string,
    threadId: string,
    attachmentId: string,
  ): Promise<{ attachment: ConversationAttachment; bytes: Uint8Array }> {
    if (!this.storage)
      throw conversationError(503, "Attachment storage is not configured.");
    const records = this.records(actorId);
    await requireThread(records, threadId);
    const record = await records.getAttachment(threadId, attachmentId);
    if (!record) throw conversationError(404, "Attachment was not found.");
    const bytes = await this.storage.get(record.storageRef);
    if (!bytes)
      throw conversationError(404, "Attachment bytes are unavailable.");
    if (bytes.byteLength !== record.size)
      throw conversationError(
        503,
        "Stored attachment failed its integrity check.",
      );
    return { attachment: publicAttachment(record), bytes };
  }

  async delete(
    actorId: string,
    threadId: string,
    attachmentId: string,
  ): Promise<void> {
    if (!this.storage)
      throw conversationError(503, "Attachment storage is not configured.");
    const records = this.records(actorId);
    await requireThread(records, threadId);
    const record = await records.getAttachment(threadId, attachmentId);
    if (!record) return;
    try {
      await this.storage.delete(record.storageRef);
    } catch {
      throw conversationError(
        503,
        "Attachment byte cleanup failed; retry deletion.",
      );
    }
    await records.deleteAttachment(threadId, attachmentId);
  }

  async load(
    actorId: string,
    threadId: string,
    ids: readonly string[],
  ): Promise<ConversationInputAttachment[]> {
    if (ids.length === 0) return [];
    if (!this.storage)
      throw conversationError(503, "Attachment storage is not configured.");
    const records = this.records(actorId);
    await requireThread(records, threadId);
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length)
      throw conversationError(
        400,
        "An attachment was selected more than once.",
      );
    const loaded: ConversationInputAttachment[] = [];
    for (const id of unique) {
      const record = await records.getAttachment(threadId, id);
      if (!record)
        throw conversationError(
          400,
          "An attachment is missing or belongs to another thread.",
        );
      const bytes = await this.storage.get(record.storageRef);
      if (!bytes || bytes.byteLength !== record.size)
        throw conversationError(
          503,
          "An attachment is unavailable or failed its integrity check.",
        );
      loaded.push({ ...publicAttachment(record), bytes });
    }
    return loaded;
  }

  private records(actorId: string) {
    return new ConversationRecords(this.store, actorId);
  }
}

function publicAttachment(record: AttachmentRecord): ConversationAttachment {
  return {
    id: record.id,
    threadId: record.threadId,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    url: `/conversations/${encodeURIComponent(record.threadId)}/attachments/${encodeURIComponent(record.id)}`,
    createdAt: record.createdAt,
  };
}

function sniffImage(bytes: Uint8Array): AttachmentRecord["mimeType"] | null {
  const data = Buffer.from(bytes);
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6)))
    return "image/gif";
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

function validateAttachmentName(name: string): string {
  if (typeof name !== "string" || name.trim().length === 0)
    throw conversationError(400, "Attachment name is required.");
  return name.trim().slice(0, 240);
}
