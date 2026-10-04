import { expect, test } from "vitest";
import {
  AGENT_EVENT_PROTOCOL_VERSION,
  assertAgentEventInput,
  assertAgentInterrupt,
  cloneAgentEvent,
  cloneContentParts,
  cloneJsonObject,
  cloneJsonValue,
  type AgentEventInput,
  type AgentEventType,
} from "../src/index.js";

const call = { toolCallId: "call", name: "lookup", input: { query: "hello" } };
const samples: Record<AgentEventType, AgentEventInput> = {
  "run.started": { type: "run.started" },
  "message.started": {
    type: "message.started",
    messageId: "m",
    role: "assistant",
  },
  "message.part.delta": {
    type: "message.part.delta",
    messageId: "m",
    part: { type: "text", text: "hello" },
  },
  "message.completed": {
    type: "message.completed",
    messageId: "m",
    role: "tool",
    content: [],
  },
  "tool.called": { type: "tool.called", toolCall: call },
  "tool.progress": { type: "tool.progress", toolCallId: "call", content: [] },
  "tool.completed": {
    type: "tool.completed",
    result: { ...call, output: [false, null], isError: false },
  },
  "tool.failed": {
    type: "tool.failed",
    error: { ...call, error: "Failed", code: "failure" },
  },
  "interrupt.required": {
    type: "interrupt.required",
    interrupt: {
      kind: "custom",
      interruptId: "i",
      prompt: "Continue?",
      actions: [],
    },
  },
  "interrupt.resolved": {
    type: "interrupt.resolved",
    interruptId: "i",
    decisions: [false],
  },
  "usage.updated": {
    type: "usage.updated",
    messageId: "m",
    usage: {
      inputTokens: 2,
      cachedInputTokens: 1,
      outputTokens: 3,
      reasoningTokens: 1,
      totalTokens: 5,
      costUsd: 0.01,
      model: "model",
      provider: "provider",
    },
  },
  "run.paused": { type: "run.paused", next: ["node"] },
  "run.completed": {
    type: "run.completed",
    finishReason: "stop",
    content: [],
    usage: {},
    limit: { kind: "tokens", limit: 10, used: 5 },
  },
  "run.failed": {
    type: "run.failed",
    code: "failure",
    message: "Failed",
    recoverable: false,
    limit: { kind: "steps" },
  },
  "run.cancelled": {
    type: "run.cancelled",
    reason: "Closed",
    recoverable: true,
    limit: { kind: "steps", used: 2 },
  },
};

const envelope = {
  protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
  eventId: "event",
  runId: "run",
  logicalSequence: 1,
  sequence: 1,
  phaseId: "phase",
  timestamp: new Date(0).toISOString(),
};

test.each(Object.values(samples))(
  "validates and clones the $type wire contract",
  (input) => {
    expect(() => assertAgentEventInput(input)).not.toThrow();
    const raw = { ...envelope, ...input };
    const cloned = cloneAgentEvent(raw);
    expect(cloned).toEqual(raw);
    expect(cloned).not.toBe(raw);
    expect(() =>
      assertAgentEventInput({ ...input, unsupported: true }),
    ).toThrow(/unsupported fields/);
  },
);

test.each(
  Object.values(samples).flatMap((input) =>
    Object.keys(input)
      .filter(
        (key) =>
          !["usage", "limit", "recoverable", "reason", "messageId"].includes(
            key,
          ) ||
          (key === "messageId" && input.type.startsWith("message.")),
      )
      .map((key) => ({ input, key })),
  ),
)("rejects missing $key in $input.type", ({ input, key }) => {
  const invalid: Record<string, unknown> = { ...input };
  delete invalid[key];
  expect(() => assertAgentEventInput(invalid)).toThrow();
});

test.each([
  null,
  [],
  { type: 1 },
  { type: "unknown" },
  { type: "__proto__" },
  { ...samples["tool.called"], toolCall: null },
  { ...samples["tool.completed"], result: null },
  {
    ...samples["tool.completed"],
    result: { ...call, output: null, isError: "true" },
  },
  { ...samples["tool.failed"], error: null },
  { ...samples["tool.failed"], error: { ...call, error: "error", code: 1 } },
  { ...samples["interrupt.resolved"], decisions: {} },
  { ...samples["run.paused"], next: [1] },
  { ...samples["run.paused"], next: false },
  { ...samples["message.started"], role: "system" },
  { ...samples["usage.updated"], usage: null },
  { ...samples["usage.updated"], usage: { costUsd: -1 } },
  { ...samples["usage.updated"], usage: { totalTokens: Infinity } },
  { ...samples["usage.updated"], usage: { model: 1 } },
  { ...samples["usage.updated"], usage: { provider: false } },
  { ...samples["run.completed"], limit: false },
  { ...samples["run.completed"], limit: { kind: "tokens", limit: -1 } },
  { ...samples["run.completed"], limit: { kind: "tokens", used: "1" } },
  { ...samples["run.cancelled"], reason: 1 },
  { ...samples["run.failed"], recoverable: 1 },
])("rejects malformed event input: %j", (input) => {
  expect(() => assertAgentEventInput(input)).toThrow();
});

test.each([
  "eventId",
  "runId",
  "phaseId",
  "timestamp",
  "logicalSequence",
  "sequence",
])("rejects invalid envelope %s", (field) => {
  for (const value of [null, -1, 0.5, "invalid", Number.MAX_SAFE_INTEGER + 1]) {
    if (
      ["eventId", "runId", "phaseId", "timestamp"].includes(field) &&
      value === "invalid"
    )
      continue;
    expect(() =>
      cloneAgentEvent({ ...envelope, type: "run.started", [field]: value }),
    ).toThrow();
  }
});

test.each([
  { type: "image", url: "url", mimeType: "image/png" },
  { type: "audio", data: "base64" },
  { type: "video", fileId: "file" },
  { type: "file", url: "url", name: "notes.txt" },
  { type: "citation", url: "url" },
  { type: "citation", url: "url", title: "Source" },
  { type: "tool-call", toolCall: call },
  { type: "tool-result", result: { ...call, output: { nested: [1] } } },
  { type: "custom", name: "data", data: null },
])("clones supported structured content: %j", (part) => {
  const copy = cloneContentParts([part]);
  expect(copy).toEqual([part]);
  expect(copy[0]).not.toBe(part);
});

test.each([
  null,
  { type: "text", text: "not an array" },
  [null],
  [{ type: 1 }],
  [{ type: "unknown" }],
  [{ type: "reasoning", text: false }],
  [{ type: "image" }],
  [{ type: "image", url: 1 }],
  [{ type: "image", url: "url", data: "data" }],
  [{ type: "audio", data: false }],
  [{ type: "video", fileId: 1 }],
  [{ type: "file", url: "url", name: false }],
  [{ type: "image", url: "url", mimeType: 1 }],
  [{ type: "citation", url: "url", title: false }],
])("rejects invalid content: %j", (parts) => {
  expect(() => cloneContentParts(parts)).toThrow();
});

const custom = {
  kind: "custom",
  interruptId: "i",
  prompt: "Choose",
  actions: [{ id: "a", name: "choose", input: null }],
};
test.each([
  null,
  { ...custom, kind: "invalid" },
  { ...custom, interruptId: "" },
  { ...custom, actions: null },
  { ...custom, actions: [null] },
  {
    ...custom,
    actions: [{ id: "a", name: "choose", input: null, toolCallId: 1 }],
  },
  { ...custom, kind: "tool-approval" },
  ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"].map((occurrence) => ({
    ...custom,
    occurrence,
  })),
])("rejects invalid interrupt metadata: %j", (value) => {
  expect(() => assertAgentInterrupt(value)).toThrow();
});

test("validates response schemas, occurrences, and optional custom action identities", () => {
  expect(() =>
    assertAgentInterrupt({
      ...custom,
      responseSchema: { type: "boolean" },
      occurrence: 0,
      actions: [{ ...custom.actions[0], toolCallId: "c" }],
    }),
  ).not.toThrow();
});

test("rejects non-JSON objects, cyclic arrays, sparse arrays, and array decorations", () => {
  const circular: unknown[] = [];
  circular.push(circular);
  const symbolArray = [1];
  Object.defineProperty(symbolArray, Symbol("secret"), { value: 1 });
  const decorated = Object.assign([1], { "01": 2 });
  for (const value of [
    circular,
    new Array(2),
    symbolArray,
    decorated,
    new Date(),
    Object.create(null),
  ])
    expect(() => cloneJsonValue(value)).toThrow();
  for (const value of [null, [], new Date()])
    expect(() => cloneJsonObject(value)).toThrow();
  const shared = { value: [1] };
  const copy = cloneJsonValue({ a: shared, b: shared });
  expect(copy).toEqual({ a: shared, b: shared });
});
