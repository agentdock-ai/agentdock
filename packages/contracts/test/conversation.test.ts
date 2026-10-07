import { describe, expect, it } from "vitest";
import {
  assertConversationApprovalRequest,
  assertConversationContinueRequest,
  assertConversationMessage,
  assertConversationStartRequest,
  assertConversationStopRequest,
  assertConversationThread,
  cloneConversationAttachment,
  cloneConversationEventEnvelope,
  cloneConversationHistory,
  cloneConversationThreadPage,
} from "../src/conversation.js";

const timestamp = "2026-01-01T00:00:00.000Z";
const thread = {
  id: "thread-1",
  title: "Thread",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const message = {
  id: "message-1",
  turnId: "turn-1",
  operationId: "operation-1",
  position: 0,
  role: "user",
  content: [{ type: "text", text: "Hi" }],
  outcome: "complete",
  createdAt: timestamp,
};
const history = {
  protocolVersion: 1,
  thread,
  messages: [message],
  nextCursor: null,
  snapshotId: "snapshot-1",
  execution: null,
  nativeControls: { pendingNodes: [], interrupts: [] },
  interrupts: [],
  actions: {
    canStart: true,
    canStop: false,
    canContinue: false,
    canRespondToInterrupt: false,
  },
};
const complete = {
  protocolVersion: 3,
  eventId: "event-1",
  runId: "run-1",
  phaseId: "phase-1",
  sequence: 1,
  logicalSequence: 1,
  timestamp,
  type: "run.started",
};
const attachment = {
  id: "file-1",
  threadId: "thread-1",
  name: "image.png",
  mimeType: "image/png",
  size: 1,
  url: "/conversations/thread-1/attachments/file-1",
  createdAt: timestamp,
};
const interrupt = {
  kind: "custom",
  interruptId: "interrupt-1",
  prompt: "Continue?",
  actions: [],
};

describe("conversation contracts", () => {
  it("validates action requests and bounds IDs, attachments, decisions, and prompt text", () => {
    expect(() =>
      assertConversationStartRequest({
        operationId: "op",
        threadId: "t",
        prompt: "",
        attachments: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertConversationStartRequest({
        operationId: "op",
        threadId: "t",
        prompt: "x".repeat(100_001),
        attachments: [],
      }),
    ).toThrow();
    expect(() =>
      assertConversationStartRequest({
        operationId: "op",
        threadId: "t",
        prompt: "x",
        attachments: Array(17).fill("file"),
      }),
    ).toThrow();
    expect(() =>
      assertConversationStartRequest({
        operationId: "op",
        threadId: "t",
        prompt: "x",
        attachments: [""],
      }),
    ).toThrow();
    expect(() =>
      assertConversationStartRequest({
        operationId: "",
        threadId: "t",
        prompt: "x",
        attachments: [],
      }),
    ).toThrow();
    expect(() =>
      assertConversationContinueRequest({
        operationId: "op",
        threadId: "t",
        pendingOperationId: "pending",
      }),
    ).not.toThrow();
    expect(() =>
      assertConversationContinueRequest({
        operationId: "op",
        threadId: "t",
        pendingOperationId: "",
      }),
    ).toThrow();
    expect(() =>
      assertConversationApprovalRequest({
        operationId: "op",
        threadId: "t",
        interruptId: "i",
        decisions: [true, { answer: 1 }],
      }),
    ).not.toThrow();
    expect(() =>
      assertConversationApprovalRequest({
        operationId: "op",
        threadId: "t",
        interruptId: "i",
        decisions: Array(65).fill(null),
      }),
    ).toThrow();
    expect(() =>
      assertConversationApprovalRequest({
        operationId: "op",
        threadId: "t",
        interruptId: "i",
        decisions: [undefined],
      }),
    ).toThrow();
    expect(() =>
      assertConversationStopRequest({
        operationId: "op",
        threadId: "t",
        targetOperationId: "target",
      }),
    ).not.toThrow();
    expect(() =>
      assertConversationStopRequest({
        operationId: "op",
        threadId: "t",
        targetOperationId: "",
      }),
    ).toThrow();
    expect(() => assertConversationStopRequest([])).toThrow();
    expect(() => assertConversationContinueRequest(null)).toThrow();
  });

  it("validates and clones thread pages and attachments", () => {
    expect(
      cloneConversationThreadPage({
        protocolVersion: 1,
        threads: [thread],
        nextCursor: "next",
      }).threads[0],
    ).toEqual(thread);
    expect(
      cloneConversationThreadPage({
        protocolVersion: 1,
        threads: [],
        nextCursor: null,
      }).nextCursor,
    ).toBeNull();
    expect(() =>
      cloneConversationThreadPage({
        protocolVersion: 2,
        threads: [],
        nextCursor: null,
      }),
    ).toThrow();
    expect(() =>
      cloneConversationThreadPage({
        protocolVersion: 1,
        threads: {},
        nextCursor: null,
      }),
    ).toThrow();
    expect(() =>
      cloneConversationThreadPage({
        protocolVersion: 1,
        threads: [],
        nextCursor: 2,
      }),
    ).toThrow();
    expect(() =>
      assertConversationThread({ ...thread, title: "x".repeat(201) }),
    ).toThrow();
    expect(() =>
      assertConversationThread({ ...thread, createdAt: "bad" }),
    ).toThrow();
    expect(() =>
      assertConversationThread({ ...thread, updatedAt: "bad" }),
    ).toThrow();
    expect(() => assertConversationThread({ ...thread, id: "" })).toThrow();
    expect(() => assertConversationThread("thread")).toThrow();

    expect(cloneConversationAttachment(attachment)).toEqual(attachment);
    for (const invalid of [
      { ...attachment, id: "" },
      { ...attachment, threadId: "" },
      { ...attachment, name: "x".repeat(241) },
      { ...attachment, mimeType: "text/plain" },
      { ...attachment, size: 0 },
      { ...attachment, size: 1.5 },
      { ...attachment, url: "//elsewhere.test/file" },
      { ...attachment, url: "https://elsewhere.test/file" },
      { ...attachment, createdAt: "bad" },
    ])
      expect(() => cloneConversationAttachment(invalid)).toThrow();
  });

  it("validates transcript history, controls, actions, and execution summaries", () => {
    expect(cloneConversationHistory(history)).toEqual(history);
    expect(
      cloneConversationHistory({
        ...history,
        interrupts: [interrupt],
        nativeControls: {
          pendingNodes: ["model_request"],
          interrupts: [interrupt],
        },
      }).interrupts,
    ).toEqual([interrupt]);
    expect(
      cloneConversationHistory({
        ...history,
        nextCursor: "older",
        execution: {
          operationId: "op",
          runId: null,
          status: "paused",
          action: "continue",
        },
      }).execution?.status,
    ).toBe("paused");
    expect(
      cloneConversationHistory({
        ...history,
        execution: {
          operationId: "op",
          runId: "run",
          status: "running",
          action: "approval",
        },
      }).execution?.runId,
    ).toBe("run");
    for (const invalid of [
      { ...history, protocolVersion: 2 },
      { ...history, messages: {} },
      { ...history, snapshotId: 1 },
      { ...history, nextCursor: 4 },
      { ...history, interrupts: {} },
      { ...history, thread: { ...thread, title: "x".repeat(201) } },
      { ...history, actions: null },
      { ...history, actions: { ...history.actions, canStart: 1 } },
      { ...history, nativeControls: null },
      { ...history, nativeControls: { pendingNodes: "bad", interrupts: [] } },
      { ...history, nativeControls: { pendingNodes: [1], interrupts: [] } },
      { ...history, nativeControls: { pendingNodes: [], interrupts: {} } },
      {
        ...history,
        execution: {
          operationId: "op",
          runId: 1,
          status: "paused",
          action: "start",
        },
      },
      {
        ...history,
        execution: {
          operationId: "op",
          runId: null,
          status: "unknown",
          action: "start",
        },
      },
      {
        ...history,
        execution: {
          operationId: "op",
          runId: null,
          status: "paused",
          action: "unknown",
        },
      },
    ])
      expect(() => cloneConversationHistory(invalid)).toThrow();
    expect(() => cloneConversationHistory([])).toThrow();
  });

  it("validates event envelopes and ordered messages", () => {
    expect(
      cloneConversationEventEnvelope({
        protocolVersion: 1,
        operationId: "op",
        threadId: "t",
        event: complete,
      }).event.type,
    ).toBe("run.started");
    expect(() =>
      cloneConversationEventEnvelope({
        protocolVersion: 2,
        operationId: "op",
        threadId: "t",
        event: complete,
      }),
    ).toThrow();
    expect(() =>
      cloneConversationEventEnvelope({
        protocolVersion: 1,
        operationId: "",
        threadId: "t",
        event: complete,
      }),
    ).toThrow();
    expect(() =>
      cloneConversationEventEnvelope({
        protocolVersion: 1,
        operationId: "op",
        threadId: "t",
        event: {},
      }),
    ).toThrow();
    expect(() => cloneConversationEventEnvelope(undefined)).toThrow();

    expect(() => assertConversationMessage(message)).not.toThrow();
    for (const invalid of [
      { ...message, id: "" },
      { ...message, turnId: "" },
      { ...message, operationId: "" },
      { ...message, createdAt: "bad" },
      { ...message, position: -1 },
      { ...message, position: 0.5 },
      { ...message, role: "system" },
      { ...message, outcome: "pending" },
      { ...message, content: [{ type: "unknown" }] },
    ])
      expect(() => assertConversationMessage(invalid)).toThrow();
    expect(() => assertConversationMessage(null)).toThrow();
  });
});
