import assert from "node:assert/strict";
import { test } from "vitest";
import { validateResume } from "../../src/langgraph/validate-resume.js";

const approval = (id, allowed = ["approve", "edit", "reject"]) => ({
  interruptId: id,
  kind: "tool-approval",
  prompt: "Review",
  actions: [{ id: "call", name: "lookup", input: {}, toolCallId: "call" }],
  payload: {
    reviewConfigs: [{ actionName: "lookup", allowedDecisions: allowed }],
  },
});
const response = { decisions: [{ type: "approve" }] };

test.each([
  null,
  true,
  {},
  { decisions: [] },
  { decisions: [null] },
  { decisions: [{ type: "unknown" }] },
  { decisions: [{ type: "approve", message: 42 }] },
  { decisions: [{ type: "edit" }] },
  {
    decisions: [
      { type: "edit", editedAction: { name: "lookup", args: "wrong" } },
    ],
  },
])("rejects malformed decisions before graph invocation: %j", (value) => {
  assert.throws(() => validateResume(value, [approval("i")]));
});

test("validates shape while leaving decision permissions to native middleware", () => {
  validateResume(response, [approval("i", ["approve"])]);
  validateResume({ i: response }, [approval("i", ["approve"])]);
  validateResume({ decisions: [{ type: "reject" }] }, [
    approval("i", ["approve"]),
  ]);
});

test("validates only addressed parallel approvals, requiring at least one native ID", () => {
  const pending = [approval("a"), approval("b")];
  validateResume({ a: response }, pending);
  validateResume({ a: response, b: response }, pending);
  assert.throws(() => validateResume(response, pending), /target/);
  assert.throws(() => validateResume(null, pending), /target/);
  assert.throws(() => validateResume({ other: response }, pending), /target/);
  assert.throws(
    () => validateResume({ a: response, b: { decisions: [] } }, pending),
    /each pending/,
  );
});

test("custom interrupt resume values remain opaque", () => {
  for (const value of [null, false, [1, 2], { answer: "yes" }])
    validateResume(value, [
      { interruptId: "c", kind: "custom", prompt: "Choose", actions: [] },
    ]);
});
