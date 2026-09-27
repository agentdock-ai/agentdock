import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AgentEventType,
  createAgentReducerState,
  reduceAgentEvent,
  serveAgent,
} from "../../src/index.js";
import { EventContext } from "../../src/serving/event-context.js";
import { WireEventMapper } from "../../src/serving/to-wire-event.js";

test("supported message and tool chunks reduce as canonical AgentEvents", async () => {
  const chunks = [
    [
      "messages",
      [
        {
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
            reasoning_tokens: 1,
          },
        },
        { langgraph_node: "agent" },
      ],
    ],
    ["messages", [{ id: "empty-message", content: "" }, {}]],
    ["tools", { event: "on_tool_start", name: "read", input: '{"path":"a"}' }],
    ["tools", { event: "on_tool_event", name: "read", data: "reading" }],
    [
      "tools",
      {
        event: "on_tool_end",
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
  const context = new EventContext("wire-run", "wire-compatibility", 0);
  const mapper = new WireEventMapper(context);
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

test("custom interrupts map to the event contract and unsupported chunks fail", async () => {
  const events = await collect(
    serveAgent(
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
    serveAgent(createGraph([["values", {}]])).stream({
      threadId: "unknown-mode",
      input: { messages: [] },
    }),
  );
  assert.equal(failed.at(-1).type, AgentEventType.RunFailed);
  assert.equal(failed.at(-1).code, "graph_error");
});

test("LangGraph update chunks advance the event phase", async () => {
  const events = await collect(
    serveAgent(
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
