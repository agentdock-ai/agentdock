import { createHash } from "node:crypto";
import type {
  AgentInterrupt,
  ConversationApprovalRequest,
} from "@agentdock-ai/contracts";
import type { ConversationRecords, ThreadRecord } from "./store.js";

export function validateDecisions(
  interrupt: AgentInterrupt,
  decisions: ConversationApprovalRequest["decisions"],
): void {
  if (decisions.length !== interrupt.actions.length)
    throw conversationError(
      400,
      "Supply one native decision for each pending action.",
    );
  for (const decision of decisions) {
    if (
      typeof decision !== "object" ||
      decision === null ||
      Array.isArray(decision)
    )
      throw conversationError(
        400,
        "Each approval decision must be a native decision object.",
      );
    const type = (decision as Record<string, unknown>).type;
    if (
      !(["approve", "reject", "edit"] as const).includes(
        type as "approve" | "reject" | "edit",
      )
    )
      throw conversationError(
        400,
        "Decision type must be approve, reject, or edit.",
      );
  }
}

export function validateTitle(title: string): string {
  if (typeof title !== "string")
    throw conversationError(400, "title must be a string.");
  const normalized = title.trim();
  if (!normalized || normalized.length > 200)
    throw conversationError(400, "title must contain 1 to 200 characters.");
  return normalized;
}

export function positiveInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  return value;
}

export function decodeCursor(cursor?: string | null): number {
  if (!cursor) return 0;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw conversationError(400, "Pagination cursor is invalid.");
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw conversationError(400, "Pagination cursor is invalid.");
  return value as number;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify(offset)).toString("base64url");
}

export function conversationError(
  status: number,
  message: string,
): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export async function requireThread(
  records: ConversationRecords,
  id: string,
): Promise<ThreadRecord> {
  if (typeof id !== "string" || !id.trim())
    throw conversationError(400, "threadId is required.");
  const thread = await records.getThread(id);
  if (!thread) throw conversationError(404, "Conversation was not found.");
  return thread;
}

export function hashRequest(request: unknown): string {
  const json = JSON.stringify(request, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
      );
    return value;
  });
  return createHash("sha256").update(json).digest("hex");
}
