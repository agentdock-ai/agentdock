import { expect, it } from "vitest";
import { cloneToolApprovalDecisionRecord } from "../src/index.js";
const record = {
  id: "decision",
  threadId: "thread",
  interruptId: "interrupt",
  toolCallId: "call",
  tool: "lookup",
  decision: "approve",
  originalArgs: {},
  at: "2026-10-22T00:00:00.000Z",
};
it("clones durable approval decisions and optional edit/reject details", () => {
  expect(cloneToolApprovalDecisionRecord(record)).toEqual(record);
  const edited = {
    ...record,
    decision: "edit",
    editedArgs: { q: "edited" },
    message: "reason",
  };
  expect(cloneToolApprovalDecisionRecord(edited)).toEqual(edited);
  expect(
    cloneToolApprovalDecisionRecord({
      ...record,
      decision: "reject",
      message: "reason",
    }).decision,
  ).toBe("reject");
});
it.each([
  null,
  true,
  [],
  { ...record, id: "" },
  { ...record, tool: 42 },
  { ...record, decision: "invalid" },
  { ...record, at: "invalid" },
  { ...record, message: 42 },
  { ...record, originalArgs: undefined },
  { ...record, decision: "edit" },
])("rejects corrupt decision receipts %j", (value) => {
  expect(() => cloneToolApprovalDecisionRecord(value)).toThrow();
});

it("requires original arguments even when the field is absent", () => {
  const missing = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "originalArgs"),
  );
  expect(() => cloneToolApprovalDecisionRecord(missing)).toThrow(
    /originalArgs/,
  );
});
