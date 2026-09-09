import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  findFinalContent,
  findLastAssistantWithToolCalls,
  isStreamChunk,
  normalizeMessages,
  readStateMessages,
  readStateRunId,
  readStepNumber,
  stateHasInterrupt,
  toToolCallRecord,
} from "../../src/agent/workflows/tool-calling/message-adapter.js";

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
    { role: "system", content: "Be helpful.", id: "system-1" },
    { role: "user", content: "Weather?", id: "user-1" },
    {
      role: "assistant",
      content: "",
      toolCalls: [toolCall],
      id: "assistant-1",
    },
    {
      role: "tool",
      content: "sunny",
      toolResults: [{ ...toolCall, output: "sunny" }],
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
  assert.equal(
    findFinalContent(normalizeMessages([assistant], new Map())),
    "Final answer.",
  );
  assert.equal(findLastAssistantWithToolCalls([assistant]), null);
  assert.deepEqual(readStateMessages({}), []);
  assert.equal(readStateRunId({}), null);
});

test("detects interrupted state and assistant tool calls", () => {
  const assistant = new AIMessage({
    content: "",
    tool_calls: [{ id: "call-1", name: "publish", args: {} }],
  });

  assert.equal(
    findLastAssistantWithToolCalls([new HumanMessage("hello"), assistant]),
    assistant,
  );
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
    /invalid tool input/,
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

  assert.deepEqual(normalized[1].toolResults[0].output, { ok: true });
});
