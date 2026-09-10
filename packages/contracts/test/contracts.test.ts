import { describe, expect, it } from "vitest";
import {
  AGENT_EVENT_PROTOCOL_VERSION,
  AgentEventType,
  type AgentResumeRequest,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentEvent,
  type AgentSessionRecord,
  type ToolApprovalRequest,
  type ToolApprovalResponse,
  createAgentReducerState,
  reduceAgentEvent,
  cloneJsonValue,
  cloneJsonSchema,
  cloneAgentEvent,
  cloneContentParts,
} from "../src/index.js";

describe("AgentDock contracts", () => {
  it("defines a JSON-serializable event contract", () => {
    const event: AgentEvent = {
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
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
          content: [{ type: "text", text: "hello" }],
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
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
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
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
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

  it("accepts a new phase only when the logical sequence advances", () => {
    const base = {
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      runId: "run-phases",
      sessionId: "session-phases",
      timestamp: new Date(0).toISOString(),
    };
    const first: AgentEvent = {
      ...base,
      eventId: "phase-1",
      phaseId: "phase-a",
      sequence: 1,
      logicalSequence: 1,
      type: AgentEventType.RunStarted,
    };
    const second: AgentEvent = {
      ...base,
      eventId: "phase-2",
      phaseId: "phase-b",
      sequence: 1,
      logicalSequence: 2,
      type: AgentEventType.RunCompleted,
      finishReason: "stop",
      content: [],
    };

    const state = reduceAgentEvent(
      reduceAgentEvent(createAgentReducerState(), first),
      second,
    );
    expect(state.lastSequence).toBe(1);
    expect(state.lastLogicalSequence).toBe(2);
    expect(state.lastPhaseId).toBe("phase-b");
    expect(() =>
      reduceAgentEvent(state, {
        ...second,
        eventId: "phase-3",
        logicalSequence: 3,
      }),
    ).toThrow(/terminal/);
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

  it("rejects symbol keys, sparse arrays, and invalid schema roots with paths", () => {
    const symbol = Symbol("secret");
    const symbolKeyed = { nested: { [symbol]: "hidden" } };
    expect(() => cloneJsonValue(symbolKeyed, "context")).toThrow(
      /context\.nested\[Symbol\(secret\)\]/,
    );

    const sparse = [] as unknown[];
    sparse.length = 2;
    expect(() => cloneJsonValue({ items: sparse }, "context")).toThrow(
      /context\.items\[0\] is a sparse array entry/,
    );
    expect(() => cloneJsonSchema("string", "tool schema")).toThrow(
      /tool schema must be a JSON Schema object or boolean/,
    );
  });

  it("clones reserved JSON object keys without changing object prototypes", () => {
    const source = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"preserved"}',
    ) as Record<string, unknown>;
    const cloned = cloneJsonValue(source) as Record<string, unknown>;

    expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype);
    expect(Object.hasOwn(cloned, "__proto__")).toBe(true);
    expect(cloned.__proto__).toEqual({ polluted: true });
    expect(cloned.constructor).toBe("preserved");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.parse(JSON.stringify(cloned))).toEqual(source);
  });

  it("round-trips every structured content part and terminal metadata", () => {
    const event: AgentEvent = {
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      eventId: "parts-1",
      runId: "run-parts",
      sessionId: "session-parts",
      phaseId: "phase-parts",
      logicalSequence: 1,
      sequence: 1,
      timestamp: new Date(0).toISOString(),
      type: AgentEventType.MessageCompleted,
      messageId: "message-1",
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "reasoning", text: "because" },
        {
          type: "image",
          url: "https://example.test/image.png",
          mimeType: "image/png",
        },
        {
          type: "audio",
          fileId: "audio-1",
          mimeType: "audio/mpeg",
        },
        {
          type: "video",
          data: "YmFzZTY0",
          mimeType: "video/mp4",
        },
        {
          type: "file",
          url: "https://example.test/report.pdf",
          name: "report.pdf",
        },
        {
          type: "citation",
          url: "https://example.test/source",
          title: "Source",
        },
        {
          type: "tool-call",
          toolCall: {
            toolCallId: "call-1",
            name: "weather",
            input: { city: "Lahore" },
          },
        },
        {
          type: "tool-result",
          result: {
            toolCallId: "call-1",
            name: "weather",
            input: { city: "Lahore" },
            output: { forecast: "sunny" },
          },
        },
        { type: "custom", name: "badge", data: { level: 2, tags: ["safe"] } },
      ],
    };

    expect(JSON.parse(JSON.stringify(cloneAgentEvent(event)))).toEqual(event);
  });

  it("round-trips a complete public run result", () => {
    const result: AgentRunResult = {
      runId: "run-result",
      sessionId: "session-result",
      status: "completed",
      content: [{ type: "text", text: "Done." }],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "Checked." },
            { type: "text", text: "Done." },
          ],
        },
      ],
      toolCalls: [],
      toolResults: [],
      toolErrors: [],
      approvalRequests: [],
      stepsCompleted: 1,
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 3,
        reasoningTokens: 1,
        totalTokens: 13,
        costUsd: 0.002,
        model: "model-1",
        provider: "provider-1",
      },
    };

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("validates media sources and protocol versions", () => {
    expect(() =>
      cloneContentParts([{ type: "image", mimeType: "image/png" }]),
    ).toThrow(/exactly one media source/);
    expect(() =>
      cloneContentParts([
        {
          type: "file",
          url: "https://example.test/file",
          fileId: "file-1",
        },
      ]),
    ).toThrow(/exactly one media source/);
    expect(() =>
      cloneAgentEvent({
        eventId: "missing-version",
        runId: "run",
        sessionId: "session",
        phaseId: "phase",
        logicalSequence: 1,
        sequence: 1,
        timestamp: new Date(0).toISOString(),
        type: AgentEventType.RunStarted,
      }),
    ).toThrow(/Unsupported Agent event protocol version/);
    expect(() =>
      cloneAgentEvent({
        protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
        eventId: "negative-usage",
        runId: "run",
        sessionId: "session",
        phaseId: "phase",
        logicalSequence: 1,
        sequence: 1,
        timestamp: new Date(0).toISOString(),
        type: AgentEventType.UsageUpdated,
        usage: { inputTokens: -1 },
      }),
    ).toThrow(/usage\.inputTokens must be non-negative/);
  });

  it("reduces tool progress, interrupt lifecycle, and terminal metadata", () => {
    const base = {
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      runId: "run-state",
      sessionId: "session-state",
      phaseId: "phase-1",
      timestamp: new Date(0).toISOString(),
    };
    const events: AgentEvent[] = [
      {
        ...base,
        eventId: "state-1",
        sequence: 1,
        logicalSequence: 1,
        type: AgentEventType.RunStarted,
      },
      {
        ...base,
        eventId: "state-2",
        sequence: 2,
        logicalSequence: 2,
        type: AgentEventType.ToolCalled,
        toolCall: {
          toolCallId: "call-1",
          name: "send",
          input: { text: "hello" },
        },
      },
      {
        ...base,
        eventId: "state-3",
        sequence: 3,
        logicalSequence: 3,
        type: AgentEventType.ToolProgress,
        toolCallId: "call-1",
        content: [{ type: "text", text: "sending" }],
      },
      {
        ...base,
        eventId: "state-4",
        sequence: 4,
        logicalSequence: 4,
        type: AgentEventType.InterruptRequired,
        interrupt: {
          kind: "tool-approval",
          interruptId: "interrupt-1",
          prompt: "Approve?",
          actions: [{ id: "call-1", name: "send", input: { text: "hello" } }],
        },
      },
      {
        ...base,
        eventId: "state-5",
        sequence: 5,
        logicalSequence: 5,
        type: AgentEventType.InterruptResolved,
        interruptId: "interrupt-1",
        decisions: [{ approved: true }],
      },
      {
        ...base,
        eventId: "state-6",
        sequence: 6,
        logicalSequence: 6,
        type: AgentEventType.ToolCompleted,
        result: {
          toolCallId: "call-1",
          name: "send",
          input: { text: "hello" },
          output: "sent",
        },
      },
      {
        ...base,
        eventId: "state-7",
        sequence: 7,
        logicalSequence: 7,
        type: AgentEventType.RunCompleted,
        finishReason: "stop",
        content: [{ type: "text", text: "done" }],
        limit: { kind: "steps", limit: 5, used: 2 },
      },
    ];

    const state = events.reduce(reduceAgentEvent, createAgentReducerState());
    expect(state.status).toBe("completed");
    expect(state.toolProgress[0]?.content[0]).toEqual({
      type: "text",
      text: "sending",
    });
    expect(state.interrupt).toBeNull();
    expect(state.interruptResolution?.interruptId).toBe("interrupt-1");
    expect(state.limit).toEqual({ kind: "steps", limit: 5, used: 2 });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("replaces message deltas and reduces multiple messages, failures, and cancellation", () => {
    const base = {
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      runId: "run-terminal-cases",
      sessionId: "session-terminal-cases",
      phaseId: "phase-terminal-cases",
      timestamp: new Date(0).toISOString(),
    } as const;
    const events: AgentEvent[] = [
      {
        ...base,
        eventId: "terminal-1",
        logicalSequence: 1,
        sequence: 1,
        type: AgentEventType.RunStarted,
      },
      {
        ...base,
        eventId: "terminal-2",
        logicalSequence: 2,
        sequence: 2,
        type: AgentEventType.MessageStarted,
        messageId: "message-one",
        role: "assistant",
      },
      {
        ...base,
        eventId: "terminal-3",
        logicalSequence: 3,
        sequence: 3,
        type: AgentEventType.MessagePartDelta,
        messageId: "message-one",
        part: { type: "text", text: "partial text" },
      },
      {
        ...base,
        eventId: "terminal-4",
        logicalSequence: 4,
        sequence: 4,
        type: AgentEventType.MessageCompleted,
        messageId: "message-one",
        role: "assistant",
        content: [{ type: "text", text: "replacement snapshot" }],
      },
      {
        ...base,
        eventId: "terminal-5",
        logicalSequence: 5,
        sequence: 5,
        type: AgentEventType.MessageStarted,
        messageId: "message-two",
        role: "assistant",
      },
      {
        ...base,
        eventId: "terminal-6",
        logicalSequence: 6,
        sequence: 6,
        type: AgentEventType.MessagePartDelta,
        messageId: "message-two",
        part: { type: "reasoning", text: "second message" },
      },
      {
        ...base,
        eventId: "terminal-7",
        logicalSequence: 7,
        sequence: 7,
        type: AgentEventType.ToolCalled,
        toolCall: { toolCallId: "call-failed", name: "fail", input: {} },
      },
      {
        ...base,
        eventId: "terminal-8",
        logicalSequence: 8,
        sequence: 8,
        type: AgentEventType.ToolFailed,
        error: {
          toolCallId: "call-failed",
          name: "fail",
          input: {},
          error: "failed",
          code: "tool_failed",
        },
      },
      {
        ...base,
        eventId: "terminal-9",
        logicalSequence: 9,
        sequence: 9,
        type: AgentEventType.RunFailed,
        code: "run_failed",
        message: "run failed",
      },
    ];
    const failed = events.reduce(reduceAgentEvent, createAgentReducerState());

    expect(failed.messages).toHaveLength(2);
    expect(failed.messages[0]?.content).toEqual([
      { type: "text", text: "replacement snapshot" },
    ]);
    expect(failed.toolErrors[0]?.code).toBe("tool_failed");
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("run_failed");
    const cancelled = reduceAgentEvent(
      reduceAgentEvent(createAgentReducerState(), events[0]),
      {
        ...events[0],
        eventId: "terminal-cancelled",
        logicalSequence: 2,
        sequence: 2,
        type: AgentEventType.RunCancelled,
        reason: "cancelled by host",
      },
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancellationReason).toBe("cancelled by host");
    expect(() =>
      reduceAgentEvent(reduceAgentEvent(createAgentReducerState(), events[0]), {
        ...events[0],
        timestamp: new Date(1).toISOString(),
        type: AgentEventType.RunStarted,
      }),
    ).toThrow(/event ID was reused/);
  });

  it("rejects invalid reducer transitions and allows only a valid phase reset", () => {
    const base = {
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      runId: "run-rules",
      sessionId: "session-rules",
      timestamp: new Date(0).toISOString(),
    };
    const started: AgentEvent = {
      ...base,
      eventId: "rules-1",
      phaseId: "phase-a",
      sequence: 1,
      logicalSequence: 1,
      type: AgentEventType.RunStarted,
    };
    const state = reduceAgentEvent(createAgentReducerState(), started);

    expect(() =>
      reduceAgentEvent(createAgentReducerState(), {
        ...started,
        type: AgentEventType.MessageStarted,
        messageId: "too-early",
        role: "assistant",
      }),
    ).toThrow(/must begin with run\.started/);
    expect(() =>
      reduceAgentEvent(state, { ...started, eventId: "rules-2" }),
    ).toThrow(/logical sequence/);
    expect(() =>
      reduceAgentEvent(state, {
        ...base,
        eventId: "rules-3",
        phaseId: "phase-a",
        sequence: 2,
        logicalSequence: 2,
        type: AgentEventType.ToolCompleted,
        result: {
          toolCallId: "missing",
          name: "tool",
          input: {},
          output: null,
        },
      }),
    ).toThrow(/no known tool call/);
    expect(() =>
      reduceAgentEvent(state, {
        ...base,
        eventId: "rules-4",
        phaseId: "phase-a",
        sequence: 2,
        logicalSequence: 2,
        type: AgentEventType.MessagePartDelta,
        messageId: "missing",
        part: { type: "text", text: "x" },
      }),
    ).toThrow(/no started message/);

    const phaseTwo: AgentEvent = {
      ...base,
      eventId: "rules-5",
      phaseId: "phase-b",
      sequence: 1,
      logicalSequence: 2,
      type: AgentEventType.MessageStarted,
      messageId: "message-2",
      role: "assistant",
    };
    const phaseState = reduceAgentEvent(state, phaseTwo);
    expect(phaseState.lastSequence).toBe(1);
    expect(() =>
      reduceAgentEvent(phaseState, {
        ...phaseTwo,
        eventId: "rules-6",
        logicalSequence: 3,
      }),
    ).toThrow(/sequence must increase within a phase/);

    const completed = reduceAgentEvent(phaseState, {
      ...base,
      eventId: "rules-7",
      phaseId: "phase-b",
      sequence: 2,
      logicalSequence: 3,
      type: AgentEventType.RunCompleted,
      finishReason: "stop",
      content: [],
    });
    expect(() =>
      reduceAgentEvent(completed, {
        ...base,
        eventId: "rules-8",
        phaseId: "phase-c",
        sequence: 1,
        logicalSequence: 4,
        type: AgentEventType.RunFailed,
        code: "late",
        message: "late",
      }),
    ).toThrow(/terminal/);
  });
});
