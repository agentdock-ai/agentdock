import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  AgentInterrupt,
  ConversationApprovalRequest,
} from "@agentdock-ai/contracts";
import type { ConversationRecords, ThreadRecord } from "../src/store.js";
import {
  decodeCursor,
  encodeCursor,
  hashRequest,
  positiveInteger,
  requireThread,
  validateDecisions,
  validateTitle,
} from "../src/service-utils.js";

const interrupt: AgentInterrupt = {
  kind: "custom",
  interruptId: "interrupt-1",
  prompt: "Review this action",
  actions: [{ id: "action-1", name: "review", input: null }],
};

describe("conversation service utilities", () => {
  it("rejects malformed native approval decisions", () => {
    expect(() =>
      validateDecisions(interrupt, [
        null,
      ] as ConversationApprovalRequest["decisions"]),
    ).toThrow("Each approval decision must be a native decision object.");
    expect(() =>
      validateDecisions(interrupt, [
        {},
      ] as ConversationApprovalRequest["decisions"]),
    ).toThrow("Decision type must be approve, reject, or edit.");
  });

  it("normalizes titles and rejects invalid title values", () => {
    expect(validateTitle("  Support thread  ")).toBe("Support thread");
    expect(() => validateTitle("  ")).toThrow(
      "title must contain 1 to 200 characters.",
    );
    expect(() => validateTitle("x".repeat(201))).toThrow(
      "title must contain 1 to 200 characters.",
    );
    expect(() => validateTitle(42 as unknown as string)).toThrow(
      "title must be a string.",
    );
  });

  it("validates bounded positive integers and round-trips cursors", () => {
    expect(positiveInteger(3, "limit", 10)).toBe(3);
    expect(() => positiveInteger(0, "limit", 10)).toThrow(
      "limit must be an integer",
    );
    expect(() => positiveInteger(11, "limit", 10)).toThrow(
      "limit must be an integer",
    );
    expect(decodeCursor(encodeCursor(12))).toBe(12);
    expect(decodeCursor(null)).toBe(0);
    expect(() => decodeCursor("not-base64-json")).toThrow(
      "Pagination cursor is invalid.",
    );
    expect(() => decodeCursor(encodeCursor(-1))).toThrow(
      "Pagination cursor is invalid.",
    );
  });

  it("requires an existing thread and hashes JSON objects independent of key order", async () => {
    const thread = { id: "thread-1" } as ThreadRecord;
    const records = {
      getThread: async () => thread,
    } as unknown as ConversationRecords;

    await expect(requireThread(records, "thread-1")).resolves.toBe(thread);
    await expect(requireThread(records, " ")).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      requireThread(
        { getThread: async () => null } as unknown as ConversationRecords,
        "missing",
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(hashRequest({ first: 1, second: { a: 2, b: 3 } })).toBe(
      hashRequest({ second: { b: 3, a: 2 }, first: 1 }),
    );
  });

  it("orders keys by code point so hashes don't depend on the server locale", () => {
    // localeCompare would place "a" before "B"; code-point order places "B" first.
    expect(hashRequest({ a: 1, B: 2, ch: 3, h: 4 })).toBe(
      createHash("sha256").update('{"B":2,"a":1,"ch":3,"h":4}').digest("hex"),
    );
  });
});
