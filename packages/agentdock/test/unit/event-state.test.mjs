import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AgentEventType,
  agentEventStateSchema,
  createAgentReducerState,
  reduceAgentEvent,
  serveAgent,
} from "../../src/index.js";
import {
  Command,
  END,
  MemorySaver,
  START,
  StateSchema,
  StateGraph,
} from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import { z } from "zod";
import {
  createMemoryCheckpoint,
  createScriptedChatModel,
  createScriptedMessageChunks,
  createToolCallArgumentChunks,
} from "../helpers/stream-fixtures.mjs";

test("event state schema composes with createAgent and a general StateGraph", async () => {
  const agent = createAgent({
    model: createScriptedChatModel({ response: "ok" }),
    tools: [],
    checkpointer: createMemoryCheckpoint(),
    stateSchema: agentEventStateSchema,
  });
  assert.equal(typeof agent.stream, "function");

  const base = new StateSchema({ value: z.string().default("") });
  const combined = new StateSchema({
    ...base.fields,
    ...agentEventStateSchema.fields,
  });
  const graph = new StateGraph(combined)
    .addNode("step", () => ({ value: "done" }))
    .addEdge(START, "step")
    .addEdge("step", END)
    .compile({ checkpointer: new MemorySaver() });
  assert.equal(typeof graph.stream, "function");
});

test("event identity and sequence survive interrupt/resume with a fresh runtime", async () => {
  const { sent, graph, threadId } = await createApprovalAgent();
  const startRuntime = serveAgent(graph);
  const startEvents = await collect(
    startRuntime.stream({
      input: { messages: [{ role: "user", content: "send hello" }] },
      threadId,
    }),
  );
  assert.equal(sent.length, 0);
  assert.equal(startEvents[0].type, AgentEventType.RunStarted);
  assert.equal(startEvents.at(-1).type, AgentEventType.InterruptRequired);
  const paused = await graph.getState({ configurable: { thread_id: threadId } });
  assert.deepEqual(paused.values.agentdockEventState, {
    runId: startEvents[0].runId,
    logicalSequence: startEvents.at(-1).logicalSequence,
    pendingInterruptId: startEvents.at(-1).interrupt.interruptId,
  });

  const resumeRuntime = serveAgent(graph);
  const resumeEvents = await collect(
    resumeRuntime.stream({
      threadId,
      resume: { decisions: [{ type: "approve" }] },
    }),
  );
  assert.deepEqual(sent, ["hello"]);
  assert.equal(resumeEvents[0].type, AgentEventType.RunStarted);
  assert.equal(resumeEvents[0].runId, startEvents[0].runId);
  assert.equal(resumeEvents[1].type, AgentEventType.InterruptResolved);
  assert.ok(
    resumeEvents[0].logicalSequence > startEvents.at(-1).logicalSequence,
  );
  assert.equal(
    resumeEvents.at(-1).type,
    AgentEventType.RunCompleted,
    JSON.stringify(resumeEvents),
  );

  const finalState = [...startEvents, ...resumeEvents].reduce(
    reduceAgentEvent,
    createAgentReducerState(),
  );
  assert.equal(finalState.status, "completed");
  assert.equal(finalState.interrupt, null);
});

test("resume requires checkpointed event state and a pending interrupt", async () => {
  const graph = new StateGraph(
    new StateSchema({
      value: z.string().default(""),
      ...agentEventStateSchema.fields,
    }),
  )
    .addNode("step", () => ({ value: "done" }))
    .addEdge(START, "step")
    .addEdge("step", END)
    .compile({ checkpointer: new MemorySaver() });
  const runtime = serveAgent(graph);

  await assert.rejects(
    async () =>
      collect(
        runtime.stream({ threadId: "missing-interrupt", resume: { ok: true } }),
      ),
    /must include agentEventStateSchema and have a pending interrupt/,
  );
});

async function createApprovalAgent() {
  const sent = [];
  const send = tool(
    async ({ body }) => {
      sent.push(body);
      return "sent";
    },
    {
      name: "send",
      description: "send",
      schema: z.object({ body: z.string() }),
    },
  );
  const chunks = createToolCallArgumentChunks({
    name: "send",
    toolCallId: "call-send",
    input: { body: "hello" },
    messageId: "assistant-call",
    chunkCount: 2,
  });
  const graph = createAgent({
    model: createScriptedChatModel({
      streamSequences: [
        [...chunks],
        createScriptedMessageChunks(["done"], { id: "assistant-done" }),
      ],
      responses: ["", "done"],
    }),
    tools: [send],
    checkpointer: createMemoryCheckpoint(),
    stateSchema: agentEventStateSchema,
    middleware: [humanInTheLoopMiddleware({ interruptOn: { send: true } })],
  });
  return { sent, graph, threadId: "serving-approval-thread" };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}
