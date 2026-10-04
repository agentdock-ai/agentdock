import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AgentEventType,
  createAgentReducerState,
  reduceAgentEvent,
} from "@agentdock-ai/contracts";
import { Agentdock } from "../../src/index.js";
import { EventContext } from "../../src/events/event-context.js";
import { WireEventMapper } from "../../src/events/from-langgraph.js";

test("supported message and tool chunks reduce as canonical AgentEvents", async () => {
  const chunks = [
    [
      "messages",
      [
        {
          id: "answer-message",
          content: [
            { type: "text", text: "answer" },
            { type: "reasoning", text: "because" },
            { type: "image", url: "https://example.test/image.png" },
            { type: "custom-data", value: 1 },
            7,
          ],
          usage_metadata: {
            input_tokens: 3,
            output_tokens: 2,
            total_tokens: 5,
            output_token_details: { reasoning: 1 },
          },
        },
        { langgraph_node: "agent" },
      ],
    ],
    ["messages", [{ id: "empty-message", content: "" }, {}]],
    [
      "tools",
      {
        event: "on_tool_start",
        toolCallId: "read-call",
        name: "read",
        input: '{"path":"a"}',
      },
    ],
    [
      "tools",
      {
        event: "on_tool_event",
        toolCallId: "read-call",
        name: "read",
        data: "reading",
      },
    ],
    [
      "tools",
      {
        event: "on_tool_end",
        toolCallId: "read-call",
        name: "read",
        output: { content: [{ type: "text", text: "file" }] },
      },
    ],
    [
      "tools",
      {
        event: "on_tool_start",
        toolCallId: "call-failed",
        name: "write",
        input: { path: "b" },
      },
    ],
    [
      "tools",
      {
        event: "on_tool_error",
        toolCallId: "call-failed",
        name: "write",
        error: "private details are not exposed",
      },
    ],
    ["messages", [{ id: "final-message", content: "done" }, {}]],
  ];
  const context = new EventContext("wire-run", 0);
  const mapper = new WireEventMapper(context, [], "langchain-hitl");
  const events = [
    context.emit({ type: AgentEventType.RunStarted }),
    ...chunks.flatMap(([mode, value]) => mapper.map(mode, value)),
    ...mapper.completeMessages(),
    context.emit({
      type: AgentEventType.RunCompleted,
      finishReason: "stop",
      content: [],
    }),
  ];
  const types = events.reduce(
    (state, event) => reduceAgentEvent(state, event),
    createAgentReducerState(),
  );

  assert.equal(types.status, "completed", JSON.stringify(events));
  assert.deepEqual(
    new Set(events.map((event) => event.type)),
    new Set([
      AgentEventType.RunStarted,
      AgentEventType.MessageStarted,
      AgentEventType.MessagePartDelta,
      AgentEventType.MessageCompleted,
      AgentEventType.UsageUpdated,
      AgentEventType.ToolCalled,
      AgentEventType.ToolProgress,
      AgentEventType.ToolCompleted,
      AgentEventType.ToolFailed,
      AgentEventType.RunCompleted,
    ]),
  );
  assert.equal(JSON.stringify(events).includes("private details"), false);
});

test("tool calls keep correlation IDs across concurrent progress and completion", () => {
  const context = new EventContext("parallel-tools", 0);
  const mapper = new WireEventMapper(context, [], "langchain-hitl");
  const events = [
    context.emit({ type: AgentEventType.RunStarted }),
    ...mapper.map("tools", {
      event: "on_tool_start",
      toolCallId: "call-a",
      name: "read",
      input: { path: "a" },
    }),
    ...mapper.map("tools", {
      event: "on_tool_start",
      toolCallId: "call-b",
      name: "read",
      input: { path: "b" },
    }),
    ...mapper.map("tools", {
      event: "on_tool_event",
      toolCallId: "call-b",
      name: "read",
      data: { percent: 50 },
    }),
    ...mapper.map("tools", {
      event: "on_tool_end",
      toolCallId: "call-b",
      name: "read",
      output: "result-b",
    }),
    ...mapper.map("tools", {
      event: "on_tool_end",
      toolCallId: "call-a",
      name: "read",
      output: "result-a",
    }),
    context.emit({
      type: AgentEventType.RunCompleted,
      finishReason: "stop",
      content: [],
    }),
  ];

  const state = events.reduce(reduceAgentEvent, createAgentReducerState());
  assert.equal(state.status, "completed");
  assert.equal(state.toolCalls[0].toolCallId, "call-a");
  assert.equal(state.toolCalls[1].toolCallId, "call-b");
  assert.equal(state.toolProgress[0].toolCallId, "call-b");
});

test.each([undefined, "", 1])(
  "rejects messages without native identity: %j",
  (id) => {
    const mapper = new WireEventMapper(new EventContext("run", 0));
    assert.throws(
      () => mapper.map("messages", [{ id, content: "answer" }, {}]),
      /native message ID/,
    );
  },
);

test("LangGraph-provided message and tool-call IDs remain unchanged", () => {
  const mapper = new WireEventMapper(new EventContext("provided-ids", 0));
  const messageEvents = mapper.map("messages", [
    { id: "langgraph-message-1", content: "answer" },
    {},
  ]);
  const toolEvents = mapper.map("tools", {
    event: "on_tool_start",
    toolCallId: "langgraph-tool-1",
    name: "read",
    input: {},
  });

  assert.equal(
    messageEvents.find((event) => event.type === AgentEventType.MessageStarted)
      .messageId,
    "langgraph-message-1",
  );
  assert.equal(toolEvents[0].toolCall.toolCallId, "langgraph-tool-1");
});

test("approval interrupts match a streamed partial tool call when IDs are omitted", () => {
  const context = new EventContext("partial-approval", 0);
  const mapper = new WireEventMapper(context, [], "langchain-hitl");
  const start = context.emit({ type: AgentEventType.RunStarted });
  mapper.map("messages", [
    {
      id: "assistant-call",
      content: "",
      tool_call_chunks: [
        {
          id: "call-review",
          name: "send_email",
          args: '{"to":"a@example.test",',
          index: 0,
        },
        { args: '"subject":"Hello"}', index: 0 },
      ],
    },
    { langgraph_node: "agent" },
  ]);

  const [event] = mapper.map("updates", {
    __interrupt__: [
      {
        id: "interrupt-review",
        value: {
          actionRequests: [
            {
              name: "send_email",
              args: { to: "a@example.test", subject: "Hello" },
            },
          ],
          reviewConfigs: [],
        },
      },
    ],
  });

  const state = [start, event].reduce(
    reduceAgentEvent,
    createAgentReducerState(),
  );
  assert.equal(event.type, AgentEventType.InterruptRequired);
  assert.equal(event.interrupt.kind, "tool-approval");
  assert.equal(event.interrupt.actions[0].toolCallId, "call-review");
  assert.equal(state.status, "waiting");
});

test("unmatched tool lifecycle events fail instead of inventing a call", () => {
  const mapper = new WireEventMapper(new EventContext("unmatched-tool", 0));
  assert.throws(
    () =>
      mapper.map("tools", {
        event: "on_tool_end",
        toolCallId: "unknown-call",
        name: "read",
        output: "result",
      }),
    /unknown call/,
  );
});

test("custom interrupts map to the event contract and unsupported chunks fail", async () => {
  const events = await collect(
    new Agentdock(
      createGraph([
        [
          "updates",
          {
            __interrupt__: [
              {
                id: "custom-interrupt",
                value: {
                  prompt: "Choose",
                  payload: { choices: ["yes", "no"] },
                  actionRequests: [{ name: "choose", input: { value: "yes" } }],
                },
              },
            ],
          },
        ],
      ]),
    ).stream({ threadId: "custom-interrupt", input: { messages: [] } }),
  );

  const state = events.reduce(reduceAgentEvent, createAgentReducerState());
  assert.equal(events.at(-1).type, AgentEventType.InterruptRequired);
  assert.equal(events.at(-1).interrupt.kind, "custom");
  assert.equal(state.status, "waiting");

  const failed = await collect(
    new Agentdock(createGraph([["values", {}]])).stream({
      threadId: "unknown-mode",
      input: { messages: [] },
    }),
  );
  assert.equal(failed.at(-1).type, AgentEventType.RunFailed);
  assert.equal(failed.at(-1).code, "mapper_error");
});

test("LangGraph update chunks advance the event phase", async () => {
  const events = await collect(
    new Agentdock(
      createGraph([
        ["updates", { agent: { step: "model-started" } }],
        ["messages", [{ id: "phase-message", content: "answer" }, {}]],
      ]),
    ).stream({ threadId: "phase-boundary", input: { messages: [] } }),
  );

  const started = events.find(
    (event) => event.type === AgentEventType.RunStarted,
  );
  const messageStarted = events.find(
    (event) => event.type === AgentEventType.MessageStarted,
  );
  assert.ok(started);
  assert.ok(messageStarted);
  assert.notEqual(messageStarted.phaseId, started.phaseId);
  assert.equal(messageStarted.sequence, 1);
  assert.equal(messageStarted.logicalSequence, started.logicalSequence + 1);
});

function createGraph(chunks) {
  let state = {};
  return {
    async stream() {
      return {
        async *[Symbol.asyncIterator]() {
          yield* chunks;
        },
      };
    },
    async getState() {
      return { values: state };
    },
    async updateState(_config, update) {
      state = { ...state, ...update };
      return { values: state };
    },
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}
