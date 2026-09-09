import { describe, expect, it } from "vitest";
import {
  AgentEventType,
  type AgentResumeRequest,
  type AgentRunRequest,
  type AgentEvent,
  type AgentSessionRecord,
  type ToolApprovalRequest,
  type ToolApprovalResponse,
  createAgentReducerState,
  reduceAgentEvent,
  cloneJsonValue,
} from "../src/index.js";

describe("AgentDock contracts", () => {
  it("defines a JSON-serializable event contract", () => {
    const event: AgentEvent = {
      eventId: "event-1",
      runId: "run-1",
      sessionId: "session-1",
      phaseId: "phase-1",
      logicalSequence: 1,
      sequence: 1,
      timestamp: new Date(0).toISOString(),
      type: AgentEventType.RunStarted,
    };

    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it("keeps approval and session data independent of runtime classes", () => {
    const approval: ToolApprovalRequest = {
      approvalId: "approval-1",
      toolCall: {
        toolCallId: "call-1",
        name: "send_message",
        input: { message: "hello" },
      },
    };
    const session: AgentSessionRecord = {
      sessionId: "session-1",
      messages: [
        {
          role: "user",
          content: "hello",
        },
      ],
    };

    expect(JSON.stringify({ approval, session })).toBeTruthy();
  });

  it("describes frontend run and approval requests", () => {
    const run: AgentRunRequest = {
      sessionId: "session-1",
      prompt: "Send the report.",
      context: { userId: "user-1" },
      maxSteps: 4,
    };
    const approval: ToolApprovalResponse = {
      approvalId: "approval-1",
      approved: true,
      toolCall: {
        toolCallId: "call-1",
        name: "send_report",
        input: { reportId: "report-1" },
      },
    };
    const resume: AgentResumeRequest = {
      sessionId: "session-1",
      runId: "run-1",
      context: { userId: "user-1" },
      approvals: [approval],
    };

    expect(JSON.parse(JSON.stringify({ run, resume }))).toEqual({
      run,
      resume,
    });
  });

  it("rebuilds a structured event stream and suppresses reconnect duplicates", () => {
    const base = {
      runId: "run-2",
      sessionId: "session-2",
      phaseId: "phase-1",
      timestamp: new Date(0).toISOString(),
    };
    const events: AgentEvent[] = [
      {
        ...base,
        eventId: "event-1",
        sequence: 1,
        logicalSequence: 1,
        type: AgentEventType.RunStarted,
      },
      {
        ...base,
        eventId: "event-2",
        sequence: 2,
        logicalSequence: 2,
        type: AgentEventType.MessageStarted,
        messageId: "message-1",
        role: "assistant",
      },
      {
        ...base,
        eventId: "event-3",
        sequence: 3,
        logicalSequence: 3,
        type: AgentEventType.MessagePartDelta,
        messageId: "message-1",
        part: { type: "text", text: "Hello" },
      },
      {
        ...base,
        eventId: "event-4",
        sequence: 4,
        logicalSequence: 4,
        type: AgentEventType.RunCompleted,
        finishReason: "stop",
        content: [{ type: "text", text: "Hello" }],
      },
    ];

    const state = events.reduce(reduceAgentEvent, createAgentReducerState());
    const duplicate = reduceAgentEvent(state, events[3]);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(duplicate).toEqual(state);
    expect(state.status).toBe("completed");
    expect(state.messages[0]?.content).toEqual([
      { type: "text", text: "Hello" },
    ]);
  });

  it("rejects out-of-order events while accepting multiple message IDs", () => {
    const base = {
      runId: "run-order",
      sessionId: "session-order",
      phaseId: "phase-1",
      timestamp: new Date(0).toISOString(),
    };
    const first: AgentEvent = {
      ...base,
      eventId: "order-1",
      sequence: 1,
      logicalSequence: 1,
      type: AgentEventType.RunStarted,
    };
    const state = reduceAgentEvent(createAgentReducerState(), first);
    expect(() =>
      reduceAgentEvent(state, { ...first, eventId: "order-2" }),
    ).toThrow(/sequence must increase/);
  });

  it("rejects non-JSON contract values and preserves nested JSON values", () => {
    expect(cloneJsonValue({ nested: [true, null, 3] })).toEqual({
      nested: [true, null, 3],
    });
    expect(() => cloneJsonValue(1n)).toThrow(/JSON-serializable/);
    expect(() => cloneJsonValue({ callback: () => undefined })).toThrow(
      /JSON-serializable/,
    );
    expect(() => cloneJsonValue({ value: Symbol("x") })).toThrow(
      /JSON-serializable/,
    );
    expect(() => cloneJsonValue({ value: undefined })).toThrow(
      /JSON-serializable/,
    );
    expect(() => cloneJsonValue(new Date())).toThrow(/JSON objects and arrays/);
    expect(() => cloneJsonValue(new Map())).toThrow(/JSON objects and arrays/);
    expect(() => cloneJsonValue(new Set())).toThrow(/JSON objects and arrays/);
  });
});
