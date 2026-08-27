import assert from "node:assert/strict";
import { test } from "vitest";

function timestamps() {
  const now = Date.now();
  return { createdAt: now, updatedAt: now };
}

function createSession() {
  return {
    sessionId: "session-contract",
    messages: [{ role: "user", content: "Find the monthly report." }],
    ...timestamps(),
  };
}

function createRun(overrides = {}) {
  return {
    runId: "run-contract",
    sessionId: "session-contract",
    status: "running",
    messages: [{ role: "user", content: "Find the monthly report." }],
    pendingApprovals: [],
    stepsCompleted: 0,
    ...timestamps(),
    ...overrides,
  };
}

function createApproval() {
  return {
    approvalId: "approval-contract",
    toolCall: {
      toolCallId: "call-contract",
      name: "publish_report",
      input: { reportId: "report-monthly" },
    },
  };
}

export function defineAgentStoreContract(name, createStore) {
  test(`${name} reads and writes run and session records`, async () => {
    const store = await createStore();
    const session = createSession();
    const run = createRun();

    await store.sessions.save(session);
    await store.runs.save(run);

    assert.deepEqual(await store.sessions.get(session.sessionId), session);
    assert.deepEqual(await store.runs.get(run.runId), run);
    assert.equal(await store.sessions.get("missing-session"), null);
    assert.equal(await store.runs.get("missing-run"), null);
  });

  test(`${name} clones records at the persistence boundary`, async () => {
    const store = await createStore();
    const session = createSession();
    const run = createRun();

    await store.sessions.save(session);
    await store.runs.save(run);

    session.messages[0].content = "Mutated after save";
    run.messages[0].content = "Mutated after save";

    const loadedSession = await store.sessions.get(session.sessionId);
    const loadedRun = await store.runs.get(run.runId);
    loadedSession.messages[0].content = "Mutated after read";
    loadedRun.messages[0].content = "Mutated after read";

    assert.equal(
      (await store.sessions.get("session-contract")).messages[0].content,
      "Find the monthly report.",
    );
    assert.equal(
      (await store.runs.get("run-contract")).messages[0].content,
      "Find the monthly report.",
    );
  });

  test(`${name} updates sessions and runs without replacing immutable identity`, async () => {
    const store = await createStore();
    const session = createSession();
    const run = createRun();
    await store.sessions.save(session);
    await store.runs.save(run);

    await store.sessions.update(session.sessionId, {
      latestRunId: run.runId,
      messages: [
        ...session.messages,
        { role: "assistant", content: "The report is ready." },
      ],
    });
    await store.runs.update(run.runId, { stepsCompleted: 1 });

    const updatedSession = await store.sessions.get(session.sessionId);
    const updatedRun = await store.runs.get(run.runId);
    assert.equal(updatedSession.latestRunId, run.runId);
    assert.equal(updatedSession.createdAt, session.createdAt);
    assert.equal(updatedSession.messages.length, 2);
    assert.equal(updatedRun.runId, run.runId);
    assert.equal(updatedRun.sessionId, session.sessionId);
    assert.equal(updatedRun.stepsCompleted, 1);
    await assert.rejects(
      Promise.resolve().then(() => store.sessions.update("missing-session", {})),
      /Agent session not found: missing-session/,
    );
    await assert.rejects(
      Promise.resolve().then(() => store.runs.update("missing-run", {})),
      /Agent run not found: missing-run/,
    );
  });

  test(`${name} applies status transitions only from expected states`, async () => {
    const store = await createStore();
    const run = createRun();
    await store.runs.save(run);

    assert.equal(
      await store.runs.transition(run.runId, "running", { status: "completed" }),
      true,
    );
    assert.equal((await store.runs.get(run.runId)).status, "completed");
    assert.equal(
      await store.runs.transition(run.runId, "running", { status: "failed" }),
      false,
    );
    assert.equal((await store.runs.get(run.runId)).status, "completed");
    assert.equal(
      await store.runs.transition("missing-run", "running", {}),
      false,
    );
  });

  test(`${name} claims the exact pending approval set once`, async () => {
    const store = await createStore();
    const approval = createApproval();
    const run = createRun({
      status: "waiting_for_approval",
      pendingApprovals: [approval],
    });
    await store.runs.save(run);

    const claim = await store.runs.claimApprovals(run.runId, [
      { approvalId: approval.approvalId, approved: true },
    ]);

    assert.equal(claim.record.status, "running");
    assert.deepEqual(claim.approvals, [approval]);
    assert.deepEqual((await store.runs.get(run.runId)).pendingApprovals, []);
    assert.equal(
      await store.runs.claimApprovals(run.runId, [
        { approvalId: approval.approvalId, approved: true },
      ]),
      null,
    );
  });

  test(`${name} rejects incomplete, unknown, and duplicate approval sets`, async () => {
    const store = await createStore();
    const approval = createApproval();
    const run = createRun({
      status: "waiting_for_approval",
      pendingApprovals: [approval],
    });
    await store.runs.save(run);

    assert.equal(await store.runs.claimApprovals(run.runId, []), null);
    assert.equal(
      await store.runs.claimApprovals(run.runId, [{ approvalId: "unknown", approved: true }]),
      null,
    );
    assert.equal(
      await store.runs.claimApprovals(run.runId, [
        { approvalId: approval.approvalId, approved: true },
        { approvalId: approval.approvalId, approved: false },
      ]),
      null,
    );
    assert.equal((await store.runs.get(run.runId)).status, "waiting_for_approval");
  });

  test(`${name} allows only one concurrent approval claimant`, async () => {
    const store = await createStore();
    const approval = createApproval();
    const run = createRun({
      status: "waiting_for_approval",
      pendingApprovals: [approval],
    });
    await store.runs.save(run);

    const claims = await Promise.all(
      Array.from({ length: 8 }, () => store.runs.claimApprovals(run.runId, [
        { approvalId: approval.approvalId, approved: true },
      ])),
    );

    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await store.runs.get(run.runId)).status, "running");
  });

  test(`${name} preserves session and run linkage`, async () => {
    const store = await createStore();
    const session = createSession();
    const run = createRun();
    await store.sessions.save({ ...session, latestRunId: run.runId });
    await store.runs.save(run);

    const storedSession = await store.sessions.get(session.sessionId);
    const storedRun = await store.runs.get(run.runId);
    assert.equal(storedSession.latestRunId, storedRun.runId);
    assert.equal(storedRun.sessionId, storedSession.sessionId);
  });
}
