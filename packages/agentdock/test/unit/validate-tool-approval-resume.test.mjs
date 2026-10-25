import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createToolApprovalResumeValidator,
  validateToolApprovalResume,
} from "../../src/index.js";

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
const edit = (name, args = { q: "edited" }) => ({
  type: "edit",
  editedAction: { name, args },
});

test("rejects decisions outside the native allowed set", () => {
  const pending = approval("i");
  pending.actions[0].allowedDecisions = ["approve", "reject"];
  validateToolApprovalResume(response, [pending]);
  assert.throws(
    () =>
      validateToolApprovalResume({ decisions: [edit("lookup")] }, [pending]),
    /not allowed/,
  );
  pending.actions[0].allowedDecisions = [];
  assert.throws(
    () => validateToolApprovalResume(response, [pending]),
    /not allowed/,
  );
});

test("edits may change arguments but cannot change the pending tool name", () => {
  for (const validate of [
    validateToolApprovalResume,
    createToolApprovalResumeValidator(),
    createToolApprovalResumeValidator({ allowToolRename: false }),
  ]) {
    validate({ decisions: [edit("lookup")] }, [approval("i")]);
    assert.throws(
      () => validate({ decisions: [edit("run_command")] }, [approval("i")]),
      { message: "An edit decision cannot change the tool name." },
    );
  }
});

test("edit names are checked against the action at the same index", () => {
  const pending = approval("i");
  pending.actions.push({
    id: "second",
    name: "send",
    input: {},
    toolCallId: "second",
  });
  validateToolApprovalResume({ decisions: [edit("lookup"), edit("send")] }, [
    pending,
  ]);
  assert.throws(
    () =>
      validateToolApprovalResume(
        { decisions: [{ type: "approve" }, edit("lookup")] },
        [pending],
      ),
    /cannot change the tool name/,
  );
  assert.throws(
    () =>
      validateToolApprovalResume({ decisions: [edit("run_command")] }, [
        pending,
      ]),
    /one decision for each/,
  );
});

test("targeted parallel approvals cannot rename a tool", () => {
  const pending = [approval("a"), approval("b")];
  validateToolApprovalResume({ b: { decisions: [edit("lookup")] } }, pending);
  for (const value of [
    { b: { decisions: [edit("run_command")] } },
    { a: response, b: { decisions: [edit("run_command")] } },
  ]) {
    assert.throws(
      () => validateToolApprovalResume(value, pending),
      /cannot change the tool name/,
    );
  }
});

test("hosts may explicitly allow tool renaming while retaining envelope validation", () => {
  const validate = createToolApprovalResumeValidator({ allowToolRename: true });
  validate({ decisions: [edit("run_command")] }, [approval("i")]);
  assert.throws(
    () => validate({ decisions: [edit("run_command", [])] }, [approval("i")]),
    /editedAction.args/,
  );
});

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
  assert.throws(() => validateToolApprovalResume(value, [approval("i")]));
});

test("validates shape while leaving decision permissions to native middleware", () => {
  validateToolApprovalResume(response, [approval("i", ["approve"])]);
  validateToolApprovalResume({ i: response }, [approval("i", ["approve"])]);
  validateToolApprovalResume({ decisions: [{ type: "reject" }] }, [
    approval("i", ["approve"]),
  ]);
});

test("validates only addressed parallel approvals, requiring at least one native ID", () => {
  const pending = [approval("a"), approval("b")];
  validateToolApprovalResume({ a: response }, pending);
  validateToolApprovalResume({ a: response, b: response }, pending);
  assert.throws(() => validateToolApprovalResume(response, pending), /target/);
  assert.throws(() => validateToolApprovalResume(null, pending), /target/);
  assert.throws(
    () => validateToolApprovalResume({ other: response }, pending),
    /target/,
  );
  assert.throws(
    () =>
      validateToolApprovalResume(
        { a: response, b: { decisions: [] } },
        pending,
      ),
    /each pending/,
  );
});

test("custom interrupt resume values remain opaque", () => {
  for (const value of [null, false, [1, 2], { answer: "yes" }])
    validateToolApprovalResume(value, [
      { interruptId: "c", kind: "custom", prompt: "Choose", actions: [] },
    ]);
});
