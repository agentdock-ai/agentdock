import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../../src/index.js";

function timestamps() {
  const now = Date.now();
  return { createdAt: now, updatedAt: now };
}

function createSession() {
  return {
    sessionId: "session-weather",
    messages: [{ role: "user", content: "What is the weather in Lahore?" }],
    ...timestamps(),
  };
}

function createRun(overrides = {}) {
  return {
    runId: "run-weather-1",
    sessionId: "session-weather",
    status: "running",
    messages: [{ role: "user", content: "What is the weather in Lahore?" }],
    pendingApprovals: [],
    stepsCompleted: 0,
    ...timestamps(),
    ...overrides,
  };
}

function createApproval() {
  return {
    approvalId: "approval-write-report",
    toolCall: {
      toolCallId: "call-write-report",
      name: "write_report",
      input: { title: "Weather report" },
    },
  };
}

test("InMemoryAgentStore keeps independent run and session records", () => {
  const store = new InMemoryAgentStore();

  assert.notEqual(store.runs, store.sessions);
  assert.equal(store.runs.get("missing-run"), null);
  assert.equal(store.sessions.get("missing-session"), null);
});

test("InMemoryAgentStore clones records on save and read", () => {
  const store = new InMemoryAgentStore();
  const session = createSession();
  const run = createRun();

  store.sessions.save(session);
  store.runs.save(run);

  const loadedSession = store.sessions.get(session.sessionId);
  const loadedRun = store.runs.get(run.runId);

  loadedSession.messages[0].content = "Changed outside the store";
  loadedRun.messages.push({ role: "assistant", content: "Unexpected mutation" });

  assert.equal(store.sessions.get(session.sessionId).messages.length, 1);
  assert.equal(store.sessions.get(session.sessionId).messages[0].content, session.messages[0].content);
  assert.equal(store.runs.get(run.runId).messages.length, 1);
});

test("run transitions only apply when the current status matches", () => {
  const store = new InMemoryAgentStore();
  const run = createRun();
  store.runs.save(run);

  assert.equal(
    store.runs.transition(run.runId, "running", { status: "completed" }),
    true,
  );
  assert.equal(store.runs.get(run.runId).status, "completed");
  assert.equal(
    store.runs.transition(run.runId, "running", { status: "failed" }),
    false,
  );
  assert.equal(store.runs.get(run.runId).status, "completed");
  assert.equal(store.runs.transition("missing-run", "running", {}), false);
});

test("approval claims atomically move a waiting run to running", () => {
  const store = new InMemoryAgentStore();
  const approval = createApproval();
  const run = createRun({
    status: "waiting_for_approval",
    pendingApprovals: [approval],
  });
  store.runs.save(run);

  const claim = store.runs.claimApprovals(run.runId, [
    { approvalId: approval.approvalId, approved: true },
  ]);

  assert.equal(claim.record.status, "running");
  assert.deepEqual(claim.approvals, [approval]);
  assert.deepEqual(store.runs.get(run.runId).pendingApprovals, []);
  assert.equal(
    store.runs.claimApprovals(run.runId, [
      { approvalId: approval.approvalId, approved: true },
    ]),
    null,
  );
});

test("approval claims require an exact, unique approval set", () => {
  const store = new InMemoryAgentStore();
  const approval = createApproval();
  const run = createRun({
    status: "waiting_for_approval",
    pendingApprovals: [approval],
  });
  store.runs.save(run);

  assert.equal(store.runs.claimApprovals(run.runId, []), null);
  assert.equal(
    store.runs.claimApprovals(run.runId, [{ approvalId: "other", approved: true }]),
    null,
  );
  assert.equal(
    store.runs.claimApprovals(run.runId, [
      { approvalId: approval.approvalId, approved: true },
      { approvalId: approval.approvalId, approved: false },
    ]),
    null,
  );
  assert.equal(store.runs.get(run.runId).status, "waiting_for_approval");
});

test("session updates preserve the record and refresh messages", () => {
  const store = new InMemoryAgentStore();
  const session = createSession();
  store.sessions.save(session);

  store.sessions.update(session.sessionId, {
    latestRunId: "run-weather-2",
    messages: [
      ...session.messages,
      { role: "assistant", content: "It is sunny." },
    ],
  });

  const updated = store.sessions.get(session.sessionId);
  assert.equal(updated.latestRunId, "run-weather-2");
  assert.equal(updated.messages.length, 2);
  assert.equal(updated.createdAt, session.createdAt);
  assert.ok(updated.updatedAt >= session.updatedAt);
  assert.throws(
    () => store.sessions.update("missing-session", {}),
    /Agent session not found: missing-session/,
  );
});
