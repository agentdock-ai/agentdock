import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  AgentEventType,
  createAgentReducerState,
  reduceAgentEvent,
} from "@agentdock-ai/contracts";
import {
  Agentdock,
  createToolApprovalResumeValidator,
  validateToolApprovalResume,
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

test("ordinary state schemas work with createAgent and a general StateGraph", async () => {
  const agent = createAgent({
    model: createScriptedChatModel({ response: "ok" }),
    tools: [],
    checkpointer: createMemoryCheckpoint(),
  });
  assert.equal(typeof agent.stream, "function");

  const combined = new StateSchema({ value: z.string().default("") });
  const graph = new StateGraph(combined)
    .addNode("step", () => ({ value: "done" }))
    .addEdge(START, "step")
    .addEdge("step", END)
    .compile({ checkpointer: new MemorySaver() });
  assert.equal(typeof graph.stream, "function");
});

test("the raw opaque format keeps LangChain HITL payloads generic", async () => {
  const { graph, threadId } = await createApprovalAgent();
  const events = await collect(
    new Agentdock(graph, { interruptFormat: "opaque" }).stream({
      input: { messages: [{ role: "user", content: "send hello" }] },
      threadId,
      context: { userId: "user-42" },
    }),
  );
  const required = events.find(
    (event) => event.type === AgentEventType.InterruptRequired,
  );

  assert.equal(required.interrupt.kind, "custom");
  assert.equal("reviewConfigs" in required.interrupt.payload, true);
});

test("invocation identity and native interrupt survive resume with a fresh runtime", async () => {
  const { sent, contexts, graph, threadId } = await createApprovalAgent();
  const startRuntime = new Agentdock(graph, {
    interruptFormat: Agentdock.HITL,
    validateResume: validateToolApprovalResume,
  });
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
  assert.equal(Object.hasOwn(paused.values, "agentEventState"), false);
  assert.equal(
    paused.tasks[0].interrupts[0].id,
    startEvents.at(-1).interrupt.interruptId,
  );

  const resumeRuntime = new Agentdock(graph, {
    interruptFormat: "langchain-hitl",
    validateResume: validateToolApprovalResume,
  });
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
  assert.notEqual(resumeEvents[0].runId, startEvents[0].runId);
  assert.ok(
    resumeEvents.some(
      (event) => event.type === AgentEventType.InterruptResolved,
    ),
  );
  assert.equal(resumeEvents[0].logicalSequence, 1);
  assert.equal(
    resumeEvents.at(-1).type,
    AgentEventType.RunCompleted,
    JSON.stringify(resumeEvents),
  );
  const completedCheckpoint = await graph.getState({
    configurable: { thread_id: threadId },
  });
  assert.equal(
    Object.hasOwn(completedCheckpoint.values, "agentEventState"),
    false,
  );
  assert.deepEqual(completedCheckpoint.next, []);

  const finalState = [...startEvents, ...resumeEvents].reduce(
    reduceAgentEvent,
    createAgentReducerState(),
  );
  assert.equal(finalState.status, "completed");
  assert.equal(finalState.interrupt, null);
});

test("native interrupt checkpoint is durable before the interrupt event is yielded", async () => {
  const { sent, graph, threadId } = await createApprovalAgent();
  const iterator = new Agentdock(graph, {
    interruptFormat: "langchain-hitl",
    validateResume: validateToolApprovalResume,
  })
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
  assert.equal(Object.hasOwn(checkpoint.values, "agentEventState"), false);
  assert.equal(
    checkpoint.tasks[0].interrupts[0].id,
    interrupt.interrupt.interruptId,
  );
  assert.equal(sent.length, 0);
  await iterator.return();
});

test("cold client hydrates from checkpoint and reduces resume events", async () => {
  const { graph, threadId } = await createApprovalAgent();
  const startEvents = await collect(
    new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    }).stream({
      input: { messages: [{ role: "user", content: "send hello" }] },
      threadId,
      context: { userId: "user-42" },
    }),
  );
  const seed = await new Agentdock(graph, {
    interruptFormat: "langchain-hitl",
    validateResume: validateToolApprovalResume,
  }).getResumeState(threadId);
  assert.ok(seed);
  assert.equal(seed.status, "waiting");
  assert.deepEqual(seed.interrupt, startEvents.at(-1).interrupt);

  const resumeEvents = await collect(
    new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    }).stream({
      threadId,
      resume: { decisions: [{ type: "approve" }] },
      context: { userId: "user-42" },
    }),
  );
  const finalState = resumeEvents.reduce(reduceAgentEvent, seed);
  assert.equal(finalState.status, "completed");
  assert.equal(finalState.interrupt, null);
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
  }).graph;
  const runtime = new Agentdock(graph, {
    interruptFormat: "langchain-hitl",
    validateResume: validateToolApprovalResume,
  });
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
  }).graph;
  const runtime = new Agentdock(graph, {
    interruptFormat: "langchain-hitl",
    validateResume: validateToolApprovalResume,
  });
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

test("resume requires native pending execution", async () => {
  const graph = new StateGraph(
    new StateSchema({
      value: z.string().default(""),
    }),
  )
    .addNode("step", () => ({ value: "done" }))
    .addEdge(START, "step")
    .addEdge("step", END)
    .compile({ checkpointer: new MemorySaver() });
  const runtime = new Agentdock(graph, {
    interruptFormat: "langchain-hitl",
    validateResume: validateToolApprovalResume,
  });

  await assert.rejects(
    async () =>
      collect(
        runtime.stream({ threadId: "missing-interrupt", resume: { ok: true } }),
      ),
    /native pending interrupt/,
  );
});

test.each([false, true])(
  "native HITL tool renaming requires explicit opt-in (allowToolRename: %s)",
  async (allowToolRename) => {
    const executions = [];
    const tools = ["list_files", "run_command"].map((name) =>
      tool(
        async ({ value }) => {
          executions.push({ name, value });
          return "done";
        },
        { name, description: name, schema: z.object({ value: z.string() }) },
      ),
    );
    const graph = createAgent({
      model: createScriptedChatModel({
        streamSequences: [
          createToolCallArgumentChunks({
            name: "list_files",
            toolCallId: "call-list",
            input: { value: "original" },
            messageId: "assistant-list",
          }),
          createScriptedMessageChunks(["done"], { id: "assistant-done" }),
        ],
        responses: ["", "done"],
      }),
      tools,
      checkpointer: new MemorySaver(),
      middleware: [
        humanInTheLoopMiddleware({
          interruptOn: { list_files: true, run_command: true },
        }),
      ],
    }).graph;
    const runtime = new Agentdock(graph, {
      interruptFormat: Agentdock.HITL,
      validateResume: allowToolRename
        ? createToolApprovalResumeValidator({ allowToolRename: true })
        : validateToolApprovalResume,
    });
    const threadId = "rename-approval";
    const start = await collect(
      runtime.stream({
        threadId,
        input: { messages: [{ role: "user", content: "list files" }] },
      }),
    );
    const pending = start.at(-1).interrupt;
    assert.equal(pending.actions[0].name, "list_files");
    assert.deepEqual(executions, []);
    const resume = {
      [pending.interruptId]: {
        decisions: [
          {
            type: "edit",
            editedAction: { name: "run_command", args: { value: "edited" } },
          },
        ],
      },
    };
    if (!allowToolRename) {
      await assert.rejects(
        () => collect(runtime.stream({ threadId, resume })),
        /cannot change the tool name/,
      );
      assert.deepEqual(executions, []);
      const state = await runtime.getResumeState(threadId);
      assert.deepEqual(state.interrupt, pending);
      resume[pending.interruptId].decisions[0].editedAction.name = "list_files";
    }
    const end = await collect(runtime.stream({ threadId, resume }));
    assert.equal(end.at(-1).type, AgentEventType.RunCompleted);
    assert.deepEqual(executions, [
      { name: allowToolRename ? "run_command" : "list_files", value: "edited" },
    ]);
  },
);

test("concurrent native resumes across runtimes execute the approved tool once", async () => {
  const { graph, sent, threadId } = await createApprovalAgent();
  const runtime = new Agentdock(graph, { interruptFormat: Agentdock.HITL });
  await collect(
    runtime.stream({
      threadId,
      input: { messages: [{ role: "user", content: "send" }] },
      context: { userId: "trusted" },
    }),
  );
  const run = {
    threadId,
    resume: { decisions: [{ type: "approve" }] },
    context: { userId: "trusted" },
  };
  const results = await Promise.allSettled([
    collect(runtime.stream(run)),
    collect(
      new Agentdock(graph, { interruptFormat: Agentdock.HITL }).stream(run),
    ),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failure = results.find((result) => result.status === "rejected");
  assert.equal(failure.reason.code, "thread_busy");
  assert.deepEqual(sent, ["hello"]);
});

test("native checkpoint approvals expire across fresh runtimes while rejection remains valid", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
    const { graph, sent, threadId } = await createApprovalAgent();
    const options = { interruptFormat: Agentdock.HITL, approvalTtlMs: 60000 };
    const first = new Agentdock(graph, options);
    await collect(
      first.stream({
        threadId,
        context: { userId: "trusted" },
        input: { messages: [{ role: "user", content: "send" }] },
      }),
    );
    vi.setSystemTime(new Date("2026-10-22T10:01:00Z"));
    const runtime = new Agentdock(graph, options);
    await assert.rejects(
      runtime.toResponse({
        threadId,
        context: { userId: "trusted" },
        resume: { decisions: [{ type: "approve" }] },
      }),
      { code: "approval_expired" },
    );
    assert.deepEqual(sent, []);
    const end = await collect(
      runtime.stream({
        threadId,
        context: { userId: "trusted" },
        resume: { decisions: [{ type: "reject" }] },
      }),
    );
    assert.equal(end.at(-1).type, "run.completed");
    assert.deepEqual(sent, []);
  } finally {
    vi.useRealTimers();
  }
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
    middleware: [humanInTheLoopMiddleware({ interruptOn: { send: true } })],
  });
  return { sent, contexts, graph, threadId: "serving-approval-thread" };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}
