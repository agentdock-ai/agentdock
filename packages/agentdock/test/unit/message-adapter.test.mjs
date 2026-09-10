import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  collectToolRecordsFromMessages,
  findFinalContent,
  isStreamChunk,
  normalizeMessages,
  readStateMessages,
  readStateRunId,
  readStepNumber,
  stateHasInterrupt,
  toToolCallRecord,
} from "../../src/agent/workflows/tool-calling/message-adapter.js";

function toolResults(message) {
  return message.content.flatMap((part) =>
    part.type === "tool-result" ? [part.result] : [],
  );
}

test("normalizes LangChain messages into public AgentDock messages", () => {
  const toolCall = {
    toolCallId: "call-weather",
    name: "get_weather",
    input: { city: "Lahore" },
  };
  const messages = normalizeMessages(
    [
      new SystemMessage({ content: "Be helpful.", id: "system-1" }),
      new HumanMessage({ content: "Weather?", id: "user-1" }),
      new AIMessage({
        content: "",
        id: "assistant-1",
        tool_calls: [
          { id: "call-weather", name: "get_weather", args: { city: "Lahore" } },
        ],
      }),
      new ToolMessage({
        content: "sunny",
        tool_call_id: "call-weather",
        id: "tool-1",
      }),
    ],
    new Map([[toolCall.toolCallId, toolCall]]),
  );

  assert.deepEqual(messages, [
    {
      role: "system",
      content: [{ type: "text", text: "Be helpful." }],
      id: "system-1",
    },
    {
      role: "user",
      content: [{ type: "text", text: "Weather?" }],
      id: "user-1",
    },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCall }],
      id: "assistant-1",
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          result: { ...toolCall, output: "sunny" },
        },
      ],
      id: "tool-1",
    },
  ]);
});

test("reads checkpoint state safely and finds final assistant content", () => {
  const assistant = new AIMessage({ content: "Final answer." });
  const state = {
    values: {
      messages: [assistant],
      agentdockRunId: "run-state",
    },
    tasks: [],
  };

  assert.deepEqual(readStateMessages(state), [assistant]);
  assert.equal(readStateRunId(state), "run-state");
  assert.equal(stateHasInterrupt(state), false);
  assert.deepEqual(
    findFinalContent(normalizeMessages([assistant], new Map())),
    [{ type: "text", text: "Final answer." }],
  );
  assert.deepEqual(readStateMessages({}), []);
  assert.equal(readStateRunId({}), null);
});

test("detects interrupted state", () => {
  assert.equal(
    stateHasInterrupt({ tasks: [{ interrupts: [{ value: "approval" }] }] }),
    true,
  );
});

test("validates model tool calls and stream metadata", () => {
  assert.deepEqual(
    toToolCallRecord({ id: "call-1", name: "lookup", args: { id: "1" } }),
    { toolCallId: "call-1", name: "lookup", input: { id: "1" } },
  );
  assert.throws(
    () => toToolCallRecord({ name: "lookup", args: {} }),
    /without an ID/,
  );
  assert.throws(
    () => toToolCallRecord({ id: "call-1", name: "", args: {} }),
    /unnamed tool call/,
  );
  assert.throws(
    () => toToolCallRecord({ id: "call-1", name: "lookup", args: [] }),
    (error) =>
      error.code === "tool_input_invalid" &&
      /invalid tool input/.test(error.message),
  );
  assert.equal(isStreamChunk(["messages", []]), true);
  assert.equal(isStreamChunk(["messages"]), false);
  assert.equal(readStepNumber({ langgraph_step: 3 }), 3);
  assert.equal(readStepNumber({ langgraph_step: "3" }), null);
});

test("reconstructs persisted structured tool outputs without changing strings", () => {
  const toolCall = {
    toolCallId: "call-structured",
    name: "structured",
    input: {},
  };
  const messages = [
    new AIMessage({
      content: "",
      tool_calls: [{ id: toolCall.toolCallId, name: toolCall.name, args: {} }],
    }),
    new ToolMessage({
      content: "[object Object]",
      tool_call_id: toolCall.toolCallId,
    }),
  ];
  const normalized = normalizeMessages(
    messages,
    new Map([[toolCall.toolCallId, toolCall]]),
    new Map([
      [
        toolCall.toolCallId,
        {
          toolCall,
          result: { ...toolCall, output: { ok: true } },
        },
      ],
    ]),
  );

  assert.deepEqual(toolResults(normalized[1])[0].output, { ok: true });
});

test("preserves every JSON output type from a checkpointed tool message", () => {
  const outputs = [
    "plain text",
    '{"looks":"like JSON"}',
    { city: "Lahore" },
    ["one", 2],
    null,
    42,
    true,
  ];
  for (const [index, output] of outputs.entries()) {
    const toolCall = {
      toolCallId: `call-output-${index}`,
      name: "output_tool",
      input: {},
    };
    const messages = normalizeMessages(
      [
        new AIMessage({
          content: "",
          tool_calls: [
            { id: toolCall.toolCallId, name: toolCall.name, args: {} },
          ],
        }),
        new ToolMessage({
          content: typeof output === "string" ? output : JSON.stringify(output),
          artifact: output,
          tool_call_id: toolCall.toolCallId,
        }),
      ],
      new Map([[toolCall.toolCallId, toolCall]]),
    );

    assert.deepEqual(toolResults(messages[1])[0].output, output);
  }
});

test("preserves text, reasoning, media, citations, and provider content", () => {
  const message = new AIMessage({
    content: [
      { type: "reasoning", reasoning: "Checked the forecast." },
      { type: "text", text: "It is sunny." },
      { type: "image", url: "https://example.test/weather.png" },
      { type: "audio", fileId: "audio-1", mimeType: "audio/mpeg" },
      {
        type: "citation",
        url: "https://example.test/source",
        title: "Weather source",
      },
      { type: "provider-extra", confidence: 0.9 },
    ],
  });

  assert.deepEqual(normalizeMessages([message], new Map())[0].content, [
    { type: "reasoning", text: "Checked the forecast." },
    { type: "text", text: "It is sunny." },
    { type: "image", url: "https://example.test/weather.png" },
    { type: "audio", fileId: "audio-1", mimeType: "audio/mpeg" },
    {
      type: "citation",
      url: "https://example.test/source",
      title: "Weather source",
    },
    {
      type: "custom",
      name: "provider-extra",
      data: { type: "provider-extra", confidence: 0.9 },
    },
  ]);
});

test("reports a malformed tool message instead of silently dropping it", () => {
  assert.throws(
    () =>
      normalizeMessages(
        [
          new ToolMessage({
            content: "orphaned",
            tool_call_id: "missing-call",
          }),
        ],
        new Map(),
      ),
    /Tool message references an unknown tool call: missing-call/,
  );
});

test("reconstructs exact typed tool errors from checkpointed message metadata", () => {
  const message = new ToolMessage({
    content: "authorization expired",
    artifact: "authorization expired",
    status: "error",
    tool_call_id: "call-expired",
    name: "protected_action",
    additional_kwargs: {
      agentdockToolCall: {
        id: "call-expired",
        name: "protected_action",
        args: { reportId: "report-1" },
      },
      agentdockToolError: {
        toolCallId: "call-expired",
        name: "protected_action",
        input: { reportId: "report-1" },
        error: "authorization expired",
        code: "authorization_denied",
      },
    },
  });

  const records = collectToolRecordsFromMessages([message]);
  assert.deepEqual(records[0].error, {
    toolCallId: "call-expired",
    name: "protected_action",
    input: { reportId: "report-1" },
    error: "authorization expired",
    code: "authorization_denied",
  });
  const normalized = normalizeMessages(
    [message],
    new Map([["call-expired", records[0].toolCall]]),
    new Map([["call-expired", records[0]]]),
  );
  assert.deepEqual(Object.keys(toolResults(normalized[0])[0]).sort(), [
    "input",
    "isError",
    "name",
    "output",
    "toolCallId",
  ]);
});
