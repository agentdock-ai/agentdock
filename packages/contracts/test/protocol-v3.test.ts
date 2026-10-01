import { expect, it } from "vitest";
import {
  AgentEventType,
  AGENT_EVENT_PROTOCOL_VERSION,
  cloneAgentEvent,
  createAgentReducerState,
  reduceAgentEvent,
  type AgentEvent,
  type AgentEventInput,
} from "../src/index.js";
function event(
  input: AgentEventInput,
  sequence: number,
  runId = "run",
): AgentEvent {
  return {
    ...input,
    protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
    runId,
    eventId: `${runId}:${sequence}`,
    sequence,
    logicalSequence: sequence,
    phaseId: runId,
    timestamp: new Date(0).toISOString(),
  };
}
const started = event({ type: AgentEventType.RunStarted }, 1);
const interruption = (id: string): AgentEventInput => ({
  type: AgentEventType.InterruptRequired,
  interrupt: {
    kind: "custom",
    interruptId: id,
    prompt: id,
    actions: [],
    payload: { unknown: [true, "x"] },
  },
});

it("rejects old wire versions and accepts namespaces", () => {
  expect(() => cloneAgentEvent({ ...started, protocolVersion: 2 })).toThrow(
    /protocol version/,
  );
  expect(
    cloneAgentEvent({ ...started, namespace: ["child:task"] }).namespace,
  ).toEqual(["child:task"]);
  expect(() => cloneAgentEvent({ ...started, namespace: [1] })).toThrow(
    /namespace/,
  );
});

it("reduces simultaneous interrupts and targeted resolutions", () => {
  const pending = [
    started,
    event(interruption("a"), 2),
    event(interruption("b"), 3),
  ].reduce(reduceAgentEvent, createAgentReducerState());
  expect(pending.interrupts.map((item) => item.interruptId)).toEqual([
    "a",
    "b",
  ]);
  expect(() => reduceAgentEvent(pending, event(interruption("a"), 4))).toThrow(
    /already pending/,
  );
  expect(() =>
    reduceAgentEvent(
      pending,
      event(
        {
          type: AgentEventType.RunCompleted,
          finishReason: "stop",
          content: [],
        },
        4,
      ),
    ),
  ).toThrow(/pending/);
  const partial = reduceAgentEvent(
    pending,
    event(
      {
        type: AgentEventType.InterruptResolved,
        interruptId: "a",
        decisions: [true],
      },
      4,
    ),
  );
  expect(partial.status).toBe("waiting");
  expect(partial.interrupt?.interruptId).toBe("b");
  expect(() =>
    reduceAgentEvent(
      partial,
      event(
        {
          type: AgentEventType.InterruptResolved,
          interruptId: "a",
          decisions: [true],
        },
        5,
      ),
    ),
  ).toThrow(/does not match/);
});

it("continues across invocation IDs while rejecting unannounced run changes", () => {
  const waiting = reduceAgentEvent(
    reduceAgentEvent(createAgentReducerState(), started),
    event(interruption("a"), 2),
  );
  const resumed = reduceAgentEvent(
    waiting,
    event({ type: AgentEventType.RunStarted }, 1, "resume"),
  );
  expect(resumed.lastLogicalSequence).toBe(1);
  expect(resumed.interrupts).toEqual(waiting.interrupts);
  expect(() =>
    reduceAgentEvent(
      resumed,
      event({ type: AgentEventType.RunStarted }, 1, "overlap"),
    ),
  ).toThrow(/start/);
  expect(() =>
    reduceAgentEvent(
      resumed,
      event({ type: AgentEventType.UsageUpdated, usage: {} }, 2, "wrong"),
    ),
  ).toThrow(/run ID/);
});

it.each(["run.failed", "run.cancelled"] as const)(
  "recoverable %s retains waiting control state",
  (type) => {
    const waiting = reduceAgentEvent(
      reduceAgentEvent(createAgentReducerState(), started),
      event(interruption("a"), 2),
    );
    const input: AgentEventInput =
      type === "run.failed"
        ? { type, code: "graph_error", message: "safe", recoverable: true }
        : { type, recoverable: true };
    const failed = reduceAgentEvent(waiting, event(input, 3));
    expect(failed.status).toBe("waiting");
    expect(failed.interrupts).toEqual(waiting.interrupts);
    expect(() =>
      cloneAgentEvent({ ...event(input, 3), recoverable: "yes" }),
    ).toThrow(/recoverable/);
  },
);

it("static pause survives a fresh invocation and clears on completion", () => {
  let state = [
    started,
    event({ type: AgentEventType.RunPaused, next: ["work"] }, 2),
  ].reduce(reduceAgentEvent, createAgentReducerState());
  expect(state.status).toBe("waiting");
  state = reduceAgentEvent(
    state,
    event({ type: AgentEventType.RunStarted }, 1, "continue"),
  );
  state = reduceAgentEvent(
    state,
    event(
      { type: AgentEventType.RunCompleted, finishReason: "stop", content: [] },
      2,
      "continue",
    ),
  );
  expect(state.pausedNodes).toEqual([]);
});

it("usage snapshots replace per-message totals and sum across model invocations", () => {
  const events = [
    started,
    event(
      {
        type: AgentEventType.UsageUpdated,
        messageId: "a",
        usage: { inputTokens: 3, outputTokens: 1 },
      },
      2,
    ),
    event(
      {
        type: AgentEventType.UsageUpdated,
        messageId: "a",
        usage: { inputTokens: 3, outputTokens: 4 },
      },
      3,
    ),
    event(
      {
        type: AgentEventType.UsageUpdated,
        messageId: "b",
        usage: { inputTokens: 5, outputTokens: 2, reasoningTokens: 1 },
      },
      4,
    ),
  ];
  expect(
    events.reduce(reduceAgentEvent, createAgentReducerState()).usage,
  ).toEqual({ inputTokens: 8, outputTokens: 6, reasoningTokens: 1 });
});

it("deduplication memory is bounded and rejects old or conflicting events", () => {
  let state = reduceAgentEvent(createAgentReducerState(), started);
  for (let sequence = 2; sequence <= 500; sequence++)
    state = reduceAgentEvent(
      state,
      event(
        {
          type: AgentEventType.UsageUpdated,
          usage: { outputTokens: sequence },
        },
        sequence,
      ),
    );
  expect(state.eventIds).toHaveLength(128);
  expect(Object.keys(state.eventFingerprints)).toHaveLength(128);
  const latest = event(
    { type: AgentEventType.UsageUpdated, usage: { outputTokens: 500 } },
    500,
  );
  expect(reduceAgentEvent(state, latest)).toBe(state);
  expect(() =>
    reduceAgentEvent(state, { ...latest, usage: { outputTokens: 501 } }),
  ).toThrow(/reused/);
  expect(() => reduceAgentEvent(state, started)).toThrow(/monotonically/);
});

it("fingerprint IDs with reserved object keys remain safe", () => {
  for (const eventId of ["__proto__", "constructor", "toString"]) {
    const custom = { ...started, eventId };
    const state = reduceAgentEvent(createAgentReducerState(), custom);
    expect(reduceAgentEvent(state, custom)).toBe(state);
    expect(Object.getPrototypeOf(state.eventFingerprints)).toBe(
      Object.prototype,
    );
    expect(
      Object.prototype.hasOwnProperty.call(state.eventFingerprints, eventId),
    ).toBe(true);
  }
});

it("many message deltas coalesce into stable content parts", () => {
  let state = [
    started,
    event(
      {
        type: AgentEventType.MessageStarted,
        messageId: "m",
        role: "assistant",
      },
      2,
    ),
  ].reduce(reduceAgentEvent, createAgentReducerState());
  for (let sequence = 3; sequence < 100; sequence++)
    state = reduceAgentEvent(
      state,
      event(
        {
          type: AgentEventType.MessagePartDelta,
          messageId: "m",
          part: { type: "text", text: "x" },
        },
        sequence,
      ),
    );
  expect(state.messages[0].content).toEqual([
    { type: "text", text: "x".repeat(97) },
  ]);
});
