import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { Agentdock, ApprovalExpiredError } from "../../src/index.js";
const raw = {
  id: "i",
  value: {
    actionRequests: [{ name: "lookup", args: {} }],
    reviewConfigs: [{ actionName: "lookup" }],
  },
};
const snapshot = (createdAt) => ({
  createdAt,
  values: {
    messages: [{ tool_calls: [{ id: "call", name: "lookup", args: {} }] }],
  },
  next: ["review"],
  tasks: [{ name: "review", interrupts: [raw] }],
});
afterEach(() => vi.useRealTimers());
function graph(state) {
  return {
    calls: 0,
    async getState() {
      return state;
    },
    async *stream() {
      this.calls++;
    },
  };
}
const run = (type) => ({
  threadId: "expiry",
  resume: {
    decisions: [
      type === "edit"
        ? { type, editedAction: { name: "lookup", args: {} } }
        : { type },
    ],
  },
});

test.each(["approve", "edit"])(
  "expired %s is rejected before a Web response, audit or execution",
  async (type) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
    const current = graph(snapshot("2026-10-22T09:59:00Z"));
    let audit = 0;
    const runtime = new Agentdock(current, {
      interruptFormat: Agentdock.HITL,
      approvalTtlMs: 60000,
      onDecision() {
        audit++;
      },
    });
    await assert.rejects(runtime.toResponse(run(type)), ApprovalExpiredError);
    assert.equal(current.calls, 0);
    assert.equal(audit, 0);
  },
);
test("fresh approvals execute, and expired approvals can still be rejected", async () => {
  const current = graph(snapshot(new Date().toISOString()));
  const runtime = new Agentdock(current, {
    interruptFormat: Agentdock.HITL,
    approvalTtlMs: 60000,
  });
  for await (const _ of runtime.stream(run("approve"))) {
  }
  current.getState = async () => snapshot("2000-01-01T00:00:00Z");
  for await (const _ of runtime.stream(run("reject"))) {
  }
  assert.equal(current.calls, 2);
});
test("unavailable native timestamps fail closed but permit rejection", async () => {
  const current = graph(snapshot(undefined));
  const runtime = new Agentdock(current, {
    interruptFormat: Agentdock.HITL,
    approvalTtlMs: 1000,
  });
  await assert.rejects(runtime.toResponse(run("approve")), /creation time/);
  for await (const _ of runtime.stream(run("reject"))) {
  }
  assert.equal(current.calls, 1);
  assert.throws(
    () => new Agentdock(current, { approvalTtlMs: 0 }),
    /approvalTtlMs/,
  );
});
test("an advancing checkpoint does not renew an older pending interrupt", async () => {
  const current = graph(snapshot(new Date().toISOString()));
  current.getStateHistory = async function* () {
    yield snapshot(new Date().toISOString());
    yield snapshot("2000-01-01T00:00:00Z");
    yield { values: {}, tasks: [] };
    throw new Error("History after the interrupt should not be read");
  };
  await assert.rejects(
    new Agentdock(current, {
      interruptFormat: Agentdock.HITL,
      approvalTtlMs: 60000,
    }).toResponse(run("approve")),
    ApprovalExpiredError,
  );
});
test("nested native checkpoints supply the approval timestamp", async () => {
  const nested = snapshot("2000-01-01T00:00:00Z");
  const current = graph({ values: {}, tasks: [{ state: nested }] });
  await assert.rejects(
    new Agentdock(current, {
      interruptFormat: Agentdock.HITL,
      approvalTtlMs: 1000,
    }).toResponse(run("approve")),
    ApprovalExpiredError,
  );
});
test("invalid historical timestamps fail before execution", async () => {
  const current = graph(snapshot(new Date().toISOString()));
  current.getStateHistory = async function* () {
    yield snapshot("invalid");
  };
  await assert.rejects(
    new Agentdock(current, {
      interruptFormat: Agentdock.HITL,
      approvalTtlMs: 1000,
    }).toResponse(run("approve")),
    /timestamp is invalid/,
  );
});

test("expiry handles unrelated nested tasks and resumed occurrences without borrowing their timestamps", async () => {
  const state = snapshot(new Date().toISOString());
  state.tasks.unshift({
    state: { values: {} },
    interrupts: [{ id: "unrelated", value: "choose" }],
  });
  const current = graph(state);
  const runtime = new Agentdock(current, {
    interruptFormat: Agentdock.HITL,
    approvalTtlMs: 60000,
  });
  for await (const _ of runtime.stream({
    threadId: "expiry",
    resume: { i: run("approve").resume },
  })) {
  }
  const pending = (await runtime.getResumeState("expiry")).interrupts.find(
    (item) => item.kind === "tool-approval",
  );
  const { toolApprovalDecisions } =
    await import("../../src/langgraph/tool-approval-decisions.js");
  const { assertApprovalsFresh } =
    await import("../../src/langgraph/approval-expiry.js");
  const decisions = toolApprovalDecisions(run("approve").resume, [pending]);
  await assert.rejects(
    assertApprovalsFresh(decisions, undefined, current, {}, 1000),
    /creation time/,
  );
  const wrongOccurrence = snapshot(new Date().toISOString());
  wrongOccurrence.tasks[0].resumeCount = 2;
  await assert.rejects(
    assertApprovalsFresh(decisions, wrongOccurrence, current, {}, 1000),
    /creation time/,
  );
});
