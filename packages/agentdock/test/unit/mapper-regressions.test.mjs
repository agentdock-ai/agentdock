import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AIMessageChunk,
  AIMessage,
  ToolMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { EventContext } from "../../src/events/event-context.js";
import { WireEventMapper } from "../../src/events/from-langgraph.js";

const mapper = (namespace = []) =>
  new WireEventMapper(new EventContext("run", 0), namespace, "langchain-hitl");
const message = (current, value, metadata = {}) =>
  current.map("messages", [value, metadata]);
const approval = (
  id = "approval",
  actions = [{ name: "lookup", args: { q: "hello" } }],
) => ({
  __interrupt__: [
    {
      id,
      value: {
        actionRequests: actions,
        reviewConfigs: [
          { actionName: "lookup", allowedDecisions: ["approve"] },
        ],
      },
    },
  ],
});

test("interleaved message IDs retain content without mutating emitted deltas", () => {
  const current = mapper();
  const first = message(current, { id: "a", content: "A1" });
  message(current, { id: "b", content: "B1" });
  message(current, { id: "a", content: "A2" });
  message(current, { id: "b", content: "B2" });
  assert.equal(
    first.find((event) => event.type === "message.part.delta").part.text,
    "A1",
  );
  assert.deepEqual(
    current.completeMessages().map((event) => event.content),
    [[{ type: "text", text: "A1A2" }], [{ type: "text", text: "B1B2" }]],
  );
  assert.deepEqual(current.completeMessages(), []);
});

test("message completion retains its native task namespace while identities use graph scope", () => {
  const scope = ["child:graph"];
  const current = mapper(scope);
  const a = [...scope, "model:a"];
  const b = [...scope, "model:b"];
  const startedA = current.map(
    "messages",
    [new AIMessageChunk({ id: "a", content: "A" }), {}],
    a,
  )[0];
  current.map(
    "tools",
    { event: "on_tool_start", toolCallId: "call", name: "lookup", input: {} },
    [...scope, "tools:task"],
  );
  const startedB = current.map(
    "messages",
    [new AIMessageChunk({ id: "b", content: "B" }), {}],
    b,
  )[0];
  current.map("updates", { done: {} }, scope);
  const completed = current.completeMessages();
  assert.deepEqual(
    completed.map((e) => e.namespace),
    [a, b],
  );
  assert.deepEqual(
    completed.map((e) => e.messageId),
    [startedA.messageId, startedB.messageId],
  );
  assert.equal(startedA.messageId, `${JSON.stringify(scope)}:a`);
});

test("fallback IDs stay stable within a stream and distinct across node metadata", () => {
  const current = mapper();
  const start = message(current, { content: "A" }, { langgraph_node: "a" });
  const delta = message(current, { content: "B" }, { langgraph_node: "a" });
  const other = message(current, { content: "C" }, { langgraph_node: "b" });
  assert.equal(start[0].messageId, delta[0].messageId);
  assert.notEqual(start[0].messageId, other[0].messageId);
  assert.equal(current.completeMessages()[0].content[0].text, "AB");
});

test.each([
  [new HumanMessage({ id: "m", content: "user" }), "user"],
  [new ToolMessage({ id: "m", content: "tool", tool_call_id: "c" }), "tool"],
  [new AIMessage({ id: "m", content: "assistant" }), "assistant"],
  [{ id: "m", content: "user", role: "user" }, "user"],
])("preserves native and plain message roles: %j", (value, role) => {
  const current = mapper();
  assert.equal(message(current, value)[0].role, role);
  assert.equal(current.completeMessages()[0].role, role);
});

test("system messages never become assistant output", () => {
  const current = mapper();
  assert.deepEqual(
    message(current, new SystemMessage("private system message")),
    [],
  );
  assert.deepEqual(current.completeMessages(), []);
});

test("raw tool fragments take precedence over eagerly parsed partial tool_calls", () => {
  const current = mapper();
  message(
    current,
    new AIMessageChunk({
      id: "m",
      content: "",
      tool_call_chunks: [
        { name: "lookup", id: "c", args: '{"q":"he', index: 0 },
      ],
    }),
  );
  message(
    current,
    new AIMessageChunk({
      id: "m",
      content: "",
      tool_call_chunks: [{ args: 'llo"}', index: 0 }],
    }),
  );
  const [event] = current.map("updates", approval());
  assert.equal(event.interrupt.actions[0].toolCallId, "c");
});

test("authoritative updates replace partial tool arguments and match each equal call once", () => {
  const current = mapper();
  message(current, {
    id: "m",
    content: "",
    tool_call_chunks: [{ name: "lookup", id: "old", args: "{", index: 0 }],
  });
  current.map("updates", {
    model: {
      messages: [
        {
          id: "m",
          tool_calls: ["c1", "c2"].map((id) => ({
            id,
            name: "lookup",
            args: { q: "hello" },
          })),
        },
      ],
    },
  });
  const actions = [
    { name: "lookup", args: { q: "hello" } },
    { name: "lookup", args: { q: "hello" } },
  ];
  const [event] = current.map("updates", approval("two", actions));
  assert.deepEqual(
    event.interrupt.actions.map((action) => action.toolCallId),
    ["c1", "c2"],
  );
  assert.throws(
    () => current.map("updates", approval()),
    /could not be matched/,
  );
});

test("checkpoint matching selects the latest tool-calling message", () => {
  const current = mapper();
  current.seedMessages({
    messages: [
      {
        id: "old",
        tool_calls: [{ id: "old-call", name: "lookup", args: { q: "hello" } }],
      },
      {
        id: "latest",
        tool_calls: [{ id: "new-call", name: "lookup", args: { q: "hello" } }],
      },
    ],
  });
  assert.equal(
    current.map("updates", approval())[0].interrupt.actions[0].toolCallId,
    "new-call",
  );
});

test.each([
  null,
  false,
  ["yes", "no"],
  "Choose",
  { prompt: "Choose", nested: { data: [1, 2] } },
])("preserves full opaque interrupt payload: %j", (value) => {
  const current = mapper();
  const [event] = current.map("updates", {
    __interrupt__: [{ id: "i", value }],
  });
  assert.deepEqual(event.interrupt.payload, value);
  assert.equal(event.interrupt.kind, "custom");
});

test("maps every parallel interrupt record", () => {
  const events = mapper().map("updates", {
    __interrupt__: [
      { id: "a", value: "A" },
      { id: "b", value: "B" },
    ],
  });
  assert.deepEqual(
    events.map((event) => event.interrupt.interruptId),
    ["a", "b"],
  );
});

test.each([
  [
    { type: "thinking", thinking: "thought" },
    { type: "reasoning", text: "thought" },
  ],
  [
    { type: "reasoning", reasoning: "reason" },
    { type: "reasoning", text: "reason" },
  ],
  [
    { type: "image", base64: "data", mime_type: "image/png" },
    { type: "image", data: "data", mimeType: "image/png" },
  ],
  [
    { type: "audio", data: "sound" },
    { type: "audio", data: "sound" },
  ],
  [
    { type: "video", file_id: "v" },
    { type: "video", fileId: "v" },
  ],
  [
    { type: "file", fileId: "f", filename: "notes.txt" },
    { type: "file", fileId: "f", name: "notes.txt" },
  ],
  [
    { type: "image", source: { data: "unsupported" } },
    {
      type: "custom",
      name: "model-content",
      data: { type: "image", source: { data: "unsupported" } },
    },
  ],
  [
    { type: "vendor", data: { x: 1 } },
    {
      type: "custom",
      name: "model-content",
      data: { type: "vendor", data: { x: 1 } },
    },
  ],
])("normalizes content without dropping its source: %j", (input, expected) => {
  assert.deepEqual(
    message(mapper(), { id: "m", content: [input] })[1].part,
    expected,
  );
});

test("chunk usage sums increments, full message usage replaces totals, models aggregate", () => {
  const current = mapper();
  for (const value of [
    new AIMessageChunk({
      id: "a",
      content: "",
      usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    }),
    new AIMessageChunk({
      id: "a",
      content: "",
      usage_metadata: { input_tokens: 0, output_tokens: 2, total_tokens: 2 },
    }),
  ])
    message(current, value);
  assert.deepEqual(current.usage, {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
  });
  message(
    current,
    new AIMessage({
      id: "a",
      content: "",
      usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    }),
  );
  message(
    current,
    new AIMessageChunk({
      id: "b",
      content: "",
      usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  );
  assert.deepEqual(current.usage, {
    inputTokens: 3,
    outputTokens: 4,
    totalTokens: 7,
  });
});

test.each([
  [
    new Command({
      update: {
        messages: [
          new ToolMessage({
            content: "failed",
            status: "error",
            tool_call_id: "c",
          }),
        ],
      },
    }),
    "failed",
    true,
  ],
  [
    new Command({
      update: [
        [
          "messages",
          [new ToolMessage({ content: "tuple", tool_call_id: "c" })],
        ],
      ],
    }),
    "tuple",
    undefined,
  ],
  [new Command({ update: { field: "new state" } }), null, undefined],
])(
  "serializes native Command results without serializing control instructions: %j",
  (output, expected, isError) => {
    const current = mapper();
    current.map("tools", {
      event: "on_tool_start",
      toolCallId: "c",
      name: "tool",
      input: {},
    });
    const [event] = current.map("tools", {
      event: "on_tool_end",
      toolCallId: "c",
      name: "tool",
      output,
    });
    assert.deepEqual(event.result.output, expected);
    assert.equal(event.result.isError, isError);
  },
);

test("namespace isolates identical native message and tool IDs", () => {
  const results = ["child-a", "child-b"].map((name) => {
    const current = mapper([name]);
    const events = message(current, { id: "same", content: name });
    const tool = current.map("tools", {
      event: "on_tool_start",
      toolCallId: "same",
      name: "tool",
      input: {},
    })[0];
    const end = current.map("tools", {
      event: "on_tool_end",
      toolCallId: "same",
      name: "tool",
      output: "ok",
    })[0];
    assert.deepEqual(tool.namespace, [name]);
    assert.equal(tool.toolCall.toolCallId, end.result.toolCallId);
    return {
      messageId: events[0].messageId,
      toolCallId: tool.toolCall.toolCallId,
    };
  });
  assert.notEqual(results[0].messageId, results[1].messageId);
  assert.notEqual(results[0].toolCallId, results[1].toolCallId);
});

test.each([
  ["messages", null],
  ["messages", [null, {}]],
  ["tools", null],
  ["tools", { event: "on_tool_end", name: "tool" }],
  ["tools", { event: "on_tool_start", input: "bad JSON" }],
  ["updates", null],
  ["updates", { __interrupt__: [{}] }],
])("rejects malformed %s chunks", (mode, value) => {
  assert.throws(() => mapper().map(mode, value));
});
