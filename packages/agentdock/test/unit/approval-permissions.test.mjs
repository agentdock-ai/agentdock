import assert from "node:assert/strict";
import { test } from "vitest";
import { Agentdock, validateToolApprovalResume } from "../../src/index.js";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import { z } from "zod";
import { EventContext } from "../../src/events/event-context.js";
import { WireEventMapper } from "../../src/events/from-langgraph.js";
import {
  createScriptedChatModel,
  createToolCallArgumentChunks,
} from "../helpers/stream-fixtures.mjs";

test("native permissions and descriptions survive projection and reload and reject edits before execution", async () => {
  let executed = false;
  const graph = createAgent({
    model: createScriptedChatModel({
      streamSequences: [
        createToolCallArgumentChunks({
          name: "lookup",
          input: {},
          toolCallId: "call",
          messageId: "assistant",
        }),
      ],
      responses: [""],
    }),
    tools: [
      tool(
        async () => {
          executed = true;
          return "done";
        },
        { name: "lookup", description: "lookup", schema: z.object({}) },
      ),
    ],
    checkpointer: new MemorySaver(),
    middleware: [
      humanInTheLoopMiddleware({
        interruptOn: {
          lookup: {
            allowedDecisions: ["approve", "reject"],
            description: "Review lookup",
          },
        },
      }),
    ],
  }).graph;
  const runtime = new Agentdock(graph, {
    interruptFormat: Agentdock.HITL,
    validateResume: validateToolApprovalResume,
  });
  const events = [];
  for await (const event of runtime.stream({
    threadId: "permissions",
    input: { messages: [{ role: "user", content: "lookup" }] },
  }))
    events.push(event);
  const action = events.at(-1).interrupt.actions[0];
  assert.deepEqual(action.allowedDecisions, ["approve", "reject"]);
  assert.equal(action.description, "Review lookup");
  assert.deepEqual(
    (await runtime.getResumeState("permissions")).interrupt.actions[0],
    action,
  );
  await assert.rejects(
    runtime.toResponse({
      threadId: "permissions",
      resume: {
        decisions: [
          { type: "edit", editedAction: { name: "lookup", args: {} } },
        ],
      },
    }),
    /not allowed/,
  );
  assert.equal(executed, false);
});

test("parallel actions match review configs by name rather than config order", () => {
  const mapper = new WireEventMapper(
    new EventContext("permissions", 0),
    [],
    Agentdock.HITL,
  );
  mapper.seedMessages({
    messages: [
      {
        tool_calls: [
          { id: "a", name: "first", args: {} },
          { id: "b", name: "second", args: {} },
        ],
      },
    ],
  });
  const result = mapper.projectInterrupt({
    id: "i",
    value: {
      actionRequests: [
        { name: "first", args: {} },
        { name: "second", args: {} },
      ],
      reviewConfigs: [
        { actionName: "second", allowedDecisions: ["reject"] },
        { actionName: "first", allowedDecisions: ["approve"] },
      ],
    },
  });
  assert.deepEqual(
    result.actions.map((action) => action.allowedDecisions),
    [["approve"], ["reject"]],
  );
});

test.each([
  { allowedDecisions: false },
  { allowedDecisions: ["unknown"] },
  { description: 42 },
])("invalid native approval metadata fails closed: %j", (invalid) => {
  const mapper = new WireEventMapper(
    new EventContext("permissions", 0),
    [],
    Agentdock.HITL,
  );
  mapper.seedMessages({
    messages: [{ tool_calls: [{ id: "call", name: "lookup", args: {} }] }],
  });
  assert.throws(() =>
    mapper.projectInterrupt({
      id: "i",
      value: {
        actionRequests: [
          {
            name: "lookup",
            args: {},
            ...(invalid.description === undefined ? {} : invalid),
          },
        ],
        reviewConfigs: [{ actionName: "lookup", ...invalid }],
      },
    }),
  );
});
