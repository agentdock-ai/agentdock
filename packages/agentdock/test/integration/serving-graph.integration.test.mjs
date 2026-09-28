import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AgentEventType,
  createAgentReducerState,
  reduceAgentEvent,
} from "@agentdock-ai/contracts";
import { agentEventStateSchema, serveAgent } from "../../src/index.js";
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
    ...agentEventStateSchema.shape,
  });
  const graph = new StateGraph(combined)
    .addNode("step", () => ({ value: "done" }))
    .addEdge(START, "step")
    .addEdge("step", END)
    .compile({ checkpointer: new MemorySaver() });
  assert.equal(typeof graph.stream, "function");
});

test("event identity and sequence survive interrupt/resume with a fresh runtime", async () => {
  const { sent, contexts, graph, threadId } = await createApprovalAgent();
  const startRuntime = serveAgent(graph);
  const startEvents = await collect(
    startRuntime.stream({
      input: { messages: [{ role: "user", content: "send hello" }] },
      threadId,
      context: { userId: "user-42" },
    }),
  );
  assert.equal(sent.length, 0);
  assert.equal(startEvents[0].type, AgentEventType.RunStarted);
  assert.equal(startEvents.at(-1).type, AgentEventType.InterruptRequired);
  assert.equal(startEvents.at(-1).interrupt.kind, "tool-approval");
  assert.equal(startEvents.at(-1).interrupt.actions[0].toolCallId, "call-send");
  const paused = await graph.getState({
    configurable: { thread_id: threadId },
  });
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
      context: { userId: "user-42" },
    }),
  );
  assert.deepEqual(sent, ["hello"]);
  assert.deepEqual(contexts, ["user-42"]);
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

test("checkpoint event state is durable before the interrupt event is yielded", async () => {
  const { sent, graph, threadId } = await createApprovalAgent();
  const iterator = serveAgent(graph)
    .stream({
      input: { messages: [{ role: "user", content: "send hello" }] },
      threadId,
      context: { userId: "user-42" },
    })
    [Symbol.asyncIterator]();

  let interrupt;
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    if (next.value.type === AgentEventType.InterruptRequired) {
      interrupt = next.value;
      break;
    }
  }
  assert.ok(interrupt);

  const checkpoint = await graph.getState({
    configurable: { thread_id: threadId },
  });
  assert.deepEqual(checkpoint.values.agentdockEventState, {
    runId: interrupt.runId,
    logicalSequence: interrupt.logicalSequence,
    pendingInterruptId: interrupt.interrupt.interruptId,
  });
  assert.equal(sent.length, 0);
  await iterator.return();
});

test("independent starts on one thread receive new event run identities", async () => {
  const graph = createAgent({
    model: createScriptedChatModel({
      streamSequences: [
        createScriptedMessageChunks(["ok"], { id: "assistant-first" }),
        createScriptedMessageChunks(["ok"], { id: "assistant-second" }),
      ],
    }),
    tools: [],
    checkpointer: new MemorySaver(),
    stateSchema: agentEventStateSchema,
  }).graph;
  const runtime = serveAgent(graph);
  const input = { messages: [{ role: "user", content: "hello" }] };
  const first = await collect(
    runtime.stream({ threadId: "same-thread", input }),
  );
  const second = await collect(
    runtime.stream({ threadId: "same-thread", input }),
  );

  assert.notEqual(first[0].runId, second[0].runId);
  assert.equal(first[0].logicalSequence, 1);
  assert.equal(second[0].logicalSequence, 1);
  assert.equal(first.at(-1).type, AgentEventType.RunCompleted);
  assert.equal(second.at(-1).type, AgentEventType.RunCompleted);
});

test("one runtime keeps concurrent run state isolated", async () => {
  const graph = createAgent({
    model: createScriptedChatModel({
      streamSequences: [
        createScriptedMessageChunks(["first"], {
          id: "assistant-concurrent-1",
        }),
        createScriptedMessageChunks(["second"], {
          id: "assistant-concurrent-2",
        }),
      ],
    }),
    tools: [],
    checkpointer: new MemorySaver(),
    stateSchema: agentEventStateSchema,
  }).graph;
  const runtime = serveAgent(graph);
  const [first, second] = await Promise.all([
    collect(
      runtime.stream({
        threadId: "concurrent-thread-1",
        input: { messages: [{ role: "user", content: "first" }] },
      }),
    ),
    collect(
      runtime.stream({
        threadId: "concurrent-thread-2",
        input: { messages: [{ role: "user", content: "second" }] },
      }),
    ),
  ]);

  assert.notEqual(first[0].runId, second[0].runId);
  assert.equal(first.at(-1).type, AgentEventType.RunCompleted);
  assert.equal(second.at(-1).type, AgentEventType.RunCompleted);
  assert.equal(first[0].logicalSequence, 1);
  assert.equal(second[0].logicalSequence, 1);
});

test("resume requires checkpointed event state and a pending interrupt", async () => {
  const graph = new StateGraph(
    new StateSchema({
      value: z.string().default(""),
      ...agentEventStateSchema.shape,
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
  const contexts = [];
  const send = tool(
    async ({ body }, runtime) => {
      sent.push(body);
      contexts.push(runtime.context.userId);
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
    contextSchema: z.object({ userId: z.string() }),
    checkpointer: createMemoryCheckpoint(),
    stateSchema: agentEventStateSchema,
    middleware: [humanInTheLoopMiddleware({ interruptOn: { send: true } })],
  });
  return { sent, contexts, graph, threadId: "serving-approval-thread" };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}
