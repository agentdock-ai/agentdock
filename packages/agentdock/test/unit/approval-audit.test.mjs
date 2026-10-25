import assert from "node:assert/strict";
import { test } from "vitest";
import { Agentdock } from "../../src/index.js";
const raw = {
  id: "i",
  value: {
    actionRequests: [{ name: "lookup", args: { q: "original" } }],
    reviewConfigs: [
      { actionName: "lookup", allowedDecisions: ["approve", "edit", "reject"] },
    ],
  },
};
function graph() {
  return {
    calls: 0,
    async getState() {
      return {
        values: {
          messages: [
            {
              tool_calls: [
                { id: "call", name: "lookup", args: { q: "original" } },
              ],
            },
          ],
        },
        tasks: [{ name: "review", interrupts: [raw] }],
        next: ["review"],
      };
    },
    async *stream() {
      this.calls++;
    },
  };
}
test.each(["approve", "edit", "reject"])(
  "audit records %s once per invocation before execution",
  async (type) => {
    const current = graph();
    const context = { actorId: "trusted" };
    const observed = [];
    const receipts = [];
    const runtime = new Agentdock(current, {
      interruptFormat: Agentdock.HITL,
      onDecision: async (record) => {
        assert.equal(current.calls, 0);
        observed.push(record);
      },
    });
    const decision =
      type === "edit"
        ? { type, editedAction: { name: "lookup", args: { q: "edited" } } }
        : { type, message: "reason" };
    const run = {
      threadId: "audit",
      resume: { i: { decisions: [decision] } },
      context,
      onDecision: (record) => receipts.push(record),
    };
    for await (const _event of runtime.stream(run)) {
    }
    assert.equal(current.calls, 1);
    assert.equal(observed.length, 1);
    assert.deepEqual(receipts, observed);
    assert.equal(observed[0].context, context);
    assert.deepEqual(observed[0].originalArgs, { q: "original" });
    assert.equal(observed[0].tool, "lookup");
    assert.equal(observed[0].decision, type);
    assert.ok(Number.isFinite(Date.parse(observed[0].at)));
    if (type === "edit")
      assert.deepEqual(observed[0].editedArgs, { q: "edited" });
    else assert.equal(observed[0].message, "reason");
  },
);
test("audit failure prevents execution and a retry retains its idempotency key", async () => {
  const current = graph();
  const ids = [];
  const runtime = new Agentdock(current, {
    interruptFormat: Agentdock.HITL,
    onDecision(record) {
      ids.push(record.id);
      throw new Error("Audit unavailable");
    },
  });
  const run = {
    threadId: "audit",
    resume: { decisions: [{ type: "approve" }] },
  };
  for (let i = 0; i < 2; i++)
    await assert.rejects(runtime.toResponse(run), /Audit unavailable/);
  assert.equal(current.calls, 0);
  assert.equal(ids[0], ids[1]);
});
test("invalid decisions never reach audit hooks", async () => {
  let audited = false;
  const current = graph();
  const runtime = new Agentdock(current, {
    interruptFormat: Agentdock.HITL,
    onDecision() {
      audited = true;
    },
  });
  await assert.rejects(
    runtime.toResponse({
      threadId: "audit",
      resume: {
        decisions: [
          { type: "edit", editedAction: { name: "other", args: {} } },
        ],
      },
    }),
    /cannot change/,
  );
  assert.equal(audited, false);
  assert.equal(current.calls, 0);
});
