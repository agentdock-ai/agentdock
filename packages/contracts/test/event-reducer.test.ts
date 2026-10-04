import { expect, test } from "vitest";
import {
  AGENT_EVENT_PROTOCOL_VERSION,
  createAgentReducerState,
  reduceAgentEvent,
  reduceAgentEvents,
  type AgentEvent,
  type AgentEventInput,
} from "../src/index.js";

function event(input: AgentEventInput, sequence: number): AgentEvent {
  return {
    ...input,
    protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
    runId: "run",
    eventId: `event:${sequence}`,
    logicalSequence: sequence,
    sequence,
    phaseId: "phase",
    timestamp: new Date(0).toISOString(),
  };
}
const call = { toolCallId: "call", name: "lookup", input: {} };

test("replaces message snapshots and tool progress, results, and errors without mutating prior state", () => {
  const inputs: AgentEventInput[] = [
    { type: "run.started" },
    { type: "message.started", messageId: "m", role: "assistant" },
    {
      type: "message.part.delta",
      messageId: "m",
      part: { type: "reasoning", text: "why" },
    },
    {
      type: "message.part.delta",
      messageId: "m",
      part: { type: "reasoning", text: "?" },
    },
    {
      type: "message.completed",
      messageId: "m",
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
    },
    { type: "tool.called", toolCall: call },
    { type: "tool.called", toolCall: call },
    {
      type: "tool.progress",
      toolCallId: "call",
      content: [{ type: "text", text: "first" }],
    },
    {
      type: "tool.progress",
      toolCallId: "call",
      content: [{ type: "text", text: "second" }],
    },
    { type: "tool.completed", result: { ...call, output: "first" } },
    { type: "tool.completed", result: { ...call, output: "second" } },
    { type: "tool.failed", error: { ...call, error: "first" } },
    { type: "tool.failed", error: { ...call, error: "second" } },
  ];
  const prior = reduceAgentEvents(
    inputs.slice(0, 4).map((input, index) => event(input, index + 1)),
  );
  const saved = structuredClone(prior);
  const state = inputs
    .slice(4)
    .map((input, index) => event(input, index + 5))
    .reduce(reduceAgentEvent, prior);
  expect(prior).toEqual(saved);
  expect(prior.messages[0].content).toEqual([
    { type: "reasoning", text: "why?" },
  ]);
  expect(state.messages[0].content).toEqual([{ type: "text", text: "answer" }]);
  expect(state.toolCalls).toEqual([call]);
  expect(state.toolProgress[0].content).toEqual([
    { type: "text", text: "second" },
  ]);
  expect(state.toolResults[0].output).toBe("second");
  expect(state.toolErrors[0].error).toBe("second");
  expect(() =>
    reduceAgentEvent(
      state,
      event(
        {
          type: "tool.called",
          toolCall: { ...call, input: { different: true } },
        },
        14,
      ),
    ),
  ).toThrow(/reused/);
});

test.each<AgentEventInput>([
  {
    type: "message.part.delta",
    messageId: "unknown",
    part: { type: "text", text: "x" },
  },
  { type: "tool.progress", toolCallId: "unknown", content: [] },
  { type: "tool.completed", result: { ...call, output: "x" } },
  { type: "tool.failed", error: { ...call, error: "x" } },
])("rejects orphan $type events", (input) => {
  const state = reduceAgentEvents([event({ type: "run.started" }, 1)]);
  expect(() => reduceAgentEvent(state, event(input, 2))).toThrow(
    /no (known|started)/,
  );
});

test("rejects idle events, duplicate starts, inconsistent versions, and reused event data", () => {
  const start = event({ type: "run.started" }, 1);
  expect(() =>
    reduceAgentEvent(
      createAgentReducerState(),
      event({ type: "run.paused", next: [] }, 1),
    ),
  ).toThrow(/begin/);
  const state = reduceAgentEvents([start]);
  expect(() =>
    reduceAgentEvent(state, event({ type: "run.started" }, 2)),
  ).toThrow(/only start/);
  expect(() =>
    reduceAgentEvent(
      { ...state, protocolVersion: null },
      { ...start, type: "run.paused", next: [] },
    ),
  ).toThrow(/reused/);
  expect(() =>
    reduceAgentEvent(
      { ...state, protocolVersion: 999 as typeof AGENT_EVENT_PROTOCOL_VERSION },
      event({ type: "run.paused", next: [] }, 2),
    ),
  ).toThrow(/version/);
  expect(() =>
    reduceAgentEvent(state, {
      ...event({ type: "run.paused", next: [] }, 2),
      sequence: 1,
    }),
  ).toThrow(/within a phase/);
});

test("bounded replay rejects evicted events and handles prototype-like event IDs", () => {
  const events = [event({ type: "run.started" }, 1)];
  for (let index = 2; index <= 130; index++)
    events.push(
      event({ type: "usage.updated", usage: { inputTokens: index } }, index),
    );
  const state = reduceAgentEvents(events);
  expect(state.eventIds).toHaveLength(128);
  expect(Object.keys(state.eventFingerprints)).toHaveLength(128);
  expect(reduceAgentEvent(state, events[129])).toBe(state);
  expect(() => reduceAgentEvent(state, events[1])).toThrow(/monotonically/);
  const special = {
    ...event({ type: "usage.updated", usage: {} }, 131),
    eventId: "__proto__",
  };
  const next = reduceAgentEvent(state, special);
  expect(Object.getPrototypeOf(next.eventFingerprints)).toBe(Object.prototype);
  expect(reduceAgentEvent(next, special)).toBe(next);
});

test.each<AgentEventInput>([
  { type: "run.failed", code: "failure", message: "Failed" },
  { type: "run.cancelled" },
  {
    type: "run.completed",
    finishReason: "stop",
    content: [],
    usage: { outputTokens: 2 },
    limit: { kind: "tokens", used: 2 },
  },
])("allows a fresh invocation after terminal $type", (terminal) => {
  const state = reduceAgentEvents([
    event({ type: "run.started" }, 1),
    event(terminal, 2),
  ]);
  expect(() =>
    reduceAgentEvent(state, event({ type: "usage.updated", usage: {} }, 3)),
  ).toThrow(/terminal/);
  const next = reduceAgentEvent(state, {
    ...event({ type: "run.started" }, 1),
    runId: "next",
    eventId: "next:1",
  });
  expect(next.status).toBe("running");
  expect(next.usage).toBeNull();
  expect(next.limit).toBeNull();
});
