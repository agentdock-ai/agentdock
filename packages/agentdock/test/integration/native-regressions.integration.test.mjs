import assert from "node:assert/strict";
import { test } from "vitest";
import { AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import {
  Command,
  StateGraph,
  StateSchema,
  START,
  END,
  MemorySaver,
  interrupt,
} from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import { z } from "zod";
import { Agentdock, validateToolApprovalResume } from "../../src/index.js";
import {
  createAgentReducerState,
  reduceAgentEvent,
} from "@agentdock-ai/contracts";
import {
  createScriptedChatModel,
  createScriptedMessageChunks,
  createToolCallArgumentChunks,
} from "../helpers/stream-fixtures.mjs";

const config = (threadId) => ({ configurable: { thread_id: threadId } });
const input = { messages: [{ role: "user", content: "hello" }] };
async function collect(source) {
  const result = [];
  for await (const event of source) result.push(event);
  return result;
}
const reduce = (events, seed = createAgentReducerState()) =>
  events.reduce(reduceAgentEvent, seed);
const terminal = (events) =>
  events.filter((event) =>
    ["run.completed", "run.failed", "run.cancelled"].includes(event.type),
  );
function approvalGraph({ chunks, middleware, result, stateSchema } = {}) {
  const effects = [];
  const lookup = tool(
    async ({ q }) => {
      effects.push(q);
      return result ? result() : "tool result";
    },
    {
      name: "lookup",
      description: "Lookup",
      schema: z.object({ q: z.string() }),
    },
  );
  const graph = createAgent({
    model: createScriptedChatModel({
      streamSequences: [
        chunks ??
          createToolCallArgumentChunks({
            name: "lookup",
            toolCallId: "call",
            input: { q: "hello" },
            messageId: "call-message",
          }),
        createScriptedMessageChunks(["done"], { id: "answer" }),
      ],
    }),
    tools: [lookup],
    checkpointer: new MemorySaver(),
    stateSchema,
    middleware: middleware ?? [
      humanInTheLoopMiddleware({ interruptOn: { lookup: true } }),
    ],
  }).graph;
  return { graph, effects };
}

for (const durability of ["sync", "async", "exit"]) {
  test(`native interrupt identity and task scheduling survive ID resume (${durability})`, async () => {
    const effects = [];
    const graph = new StateGraph(
      new StateSchema({ approved: z.boolean().default(false) }),
    )
      .addNode("ask", () => {
        const approved = interrupt("Approve this operation?");
        effects.push(approved);
        return { approved };
      })
      .addEdge(START, "ask")
      .addEdge("ask", END)
      .compile({ checkpointer: new MemorySaver() });
    graph.updateState = () => {
      throw new Error("Serving must never write graph state");
    };
    const runtime = new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    });
    const events = await collect(
      runtime.stream({
        threadId: durability,
        input: {},
        config: { durability },
      }),
    );
    const pending = events.at(-1).interrupt;
    assert.equal(pending.prompt, "Approve this operation?");
    assert.equal(pending.payload, "Approve this operation?");
    const snapshot = await graph.getState(config(durability));
    assert.equal(snapshot.tasks[0].interrupts[0].id, pending.interruptId);
    assert.deepEqual(snapshot.next, ["ask"]);
    assert.equal("agentEventState" in snapshot.values, false);
    const seed = await new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    }).getResumeState(durability);
    assert.equal(seed.runId, null);
    assert.equal(seed.interrupt.interruptId, pending.interruptId);
    const resumed = await collect(
      new Agentdock(graph, {
        interruptFormat: "langchain-hitl",
        validateResume: validateToolApprovalResume,
      }).stream({
        threadId: durability,
        resume: { [pending.interruptId]: true },
        config: { durability },
      }),
    );
    assert.notEqual(events[0].runId, resumed[0].runId);
    assert.deepEqual(effects, [true]);
    assert.equal(resumed.at(-1).type, "run.completed");
    assert.equal(reduce([...events, ...resumed]).status, "completed");
    assert.equal(reduce(resumed, seed).status, "completed");
    assert.equal(
      (await graph.getState(config(durability))).values.approved,
      true,
    );
    assert.equal(await runtime.getResumeState(durability), null);
  });
}

test.each([true, false, "edited", [1, 2], { approved: true }, null])(
  "passes native opaque resume value unchanged: %j",
  async (answer) => {
    const graph = new StateGraph(new StateSchema({ answer: z.unknown() }))
      .addNode("ask", () => ({
        answer: interrupt({ question: "Choose", extra: [1, 2] }),
      }))
      .addEdge(START, "ask")
      .addEdge("ask", END)
      .compile({ checkpointer: new MemorySaver() });
    const events = await collect(
      new Agentdock(graph, {
        interruptFormat: "langchain-hitl",
        validateResume: validateToolApprovalResume,
      }).stream({ threadId: "opaque", input: {} }),
    );
    assert.deepEqual(events.at(-1).interrupt.payload, {
      question: "Choose",
      extra: [1, 2],
    });
    const resume =
      answer === false || answer === null
        ? { [events.at(-1).interrupt.interruptId]: answer }
        : answer;
    const resumed = await collect(
      new Agentdock(graph, {
        interruptFormat: "langchain-hitl",
        validateResume: validateToolApprovalResume,
      }).stream({ threadId: "opaque", resume }),
    );
    assert.equal(resumed.at(-1).type, "run.completed");
    assert.deepEqual(
      (await graph.getState(config("opaque"))).values.answer,
      answer,
    );
  },
);

test("parallel interrupts hydrate, partially resolve, and preserve native IDs", async () => {
  const graph = new StateGraph(
    new StateSchema({ a: z.string().default(""), b: z.string().default("") }),
  )
    .addNode("askA", () => ({ a: interrupt({ prompt: "A" }) }))
    .addNode("askB", () => ({ b: interrupt({ prompt: "B" }) }))
    .addEdge(START, "askA")
    .addEdge(START, "askB")
    .addEdge("askA", END)
    .addEdge("askB", END)
    .compile({ checkpointer: new MemorySaver() });
  const runtime = new Agentdock(graph, {
    interruptFormat: "langchain-hitl",
    validateResume: validateToolApprovalResume,
  });
  const start = await collect(
    runtime.stream({ threadId: "parallel", input: {} }),
  );
  let state = reduce(start);
  assert.equal(state.interrupts.length, 2);
  const nativeIds = (await graph.getState(config("parallel"))).tasks.flatMap(
    (task) => task.interrupts.map((item) => item.id),
  );
  assert.deepEqual(
    new Set(nativeIds),
    new Set(state.interrupts.map((item) => item.interruptId)),
  );
  const seed = await runtime.getResumeState("parallel");
  assert.equal(seed.interrupts.length, 2);
  const first = state.interrupts[0];
  const partial = await collect(
    runtime.stream({
      threadId: "parallel",
      resume: { [first.interruptId]: "first answer" },
    }),
  );
  state = reduce(partial, state);
  assert.equal(state.status, "waiting");
  assert.equal(state.interrupts.length, 1);
  assert.equal(terminal(partial).length, 0);
  const remaining = state.interrupts[0];
  const end = await collect(
    new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    }).stream({
      threadId: "parallel",
      resume: { [remaining.interruptId]: "second answer" },
    }),
  );
  assert.equal(reduce(end, state).status, "completed");
  assert.equal((await graph.getState(config("parallel"))).next.length, 0);
});

test.each([
  [[]],
  [[{ type: "invalid" }]],
  [[{ type: "approve" }, { type: "approve" }]],
])(
  "invalid human decisions preserve retry and hydration: %j",
  async (decisions) => {
    const { graph, effects } = approvalGraph();
    const runtime = new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    });
    const start = await collect(runtime.stream({ threadId: "retry", input }));
    const before = await graph.getState(config("retry"));
    await assert.rejects(
      () =>
        collect(runtime.stream({ threadId: "retry", resume: { decisions } })),
      /Resume/,
    );
    assert.deepEqual(effects, []);
    const after = await graph.getState(config("retry"));
    assert.deepEqual(after.next, before.next);
    assert.equal(after.tasks[0].id, before.tasks[0].id);
    const seed = await new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    }).getResumeState("retry");
    assert.equal(
      seed.interrupt.interruptId,
      start.at(-1).interrupt.interruptId,
    );
    const state = reduce(start);
    assert.equal(state.status, "waiting");
    const good = await collect(
      new Agentdock(graph, {
        interruptFormat: "langchain-hitl",
        validateResume: validateToolApprovalResume,
      }).stream({
        threadId: "retry",
        resume: { decisions: [{ type: "approve" }] },
      }),
    );
    assert.equal(good.at(-1).type, "run.completed");
    assert.deepEqual(effects, ["hello"]);
    assert.equal(reduce(good, state).status, "completed");
    assert.equal(reduce(good, seed).status, "completed");
  },
);

test("fragmented JSON tool arguments use raw chunks and preserve approval metadata", async () => {
  const chunks = [
    new AIMessageChunk({
      id: "call-message",
      content: "",
      tool_call_chunks: [
        { name: "lookup", id: "call", args: '{"q":"he', index: 0 },
      ],
    }),
    new AIMessageChunk({
      id: "call-message",
      content: "",
      tool_call_chunks: [{ args: 'llo"}', index: 0 }],
    }),
  ];
  assert.deepEqual(chunks[0].tool_calls[0].args, { q: "he" });
  const { graph } = approvalGraph({ chunks });
  const events = await collect(
    new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    }).stream({ threadId: "fragments", input }),
  );
  assert.equal(events.at(-1).type, "interrupt.required");
  assert.equal(events.at(-1).interrupt.actions[0].toolCallId, "call");
  assert.deepEqual(events.at(-1).interrupt.actions[0].input, { q: "hello" });
  assert.deepEqual(
    events.at(-1).interrupt.payload.reviewConfigs[0].allowedDecisions,
    ["approve", "edit", "reject"],
  );
  assert.match(
    events.at(-1).interrupt.payload.actionRequests[0].description,
    /lookup/,
  );
});

test("approval matching works when token output is hidden", async () => {
  const { graph } = approvalGraph();
  const events = await collect(
    new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    }).stream({
      threadId: "hidden",
      input,
      config: { tags: ["nostream"] },
    }),
  );
  assert.equal(events.at(-1).type, "interrupt.required");
  assert.equal(events.at(-1).interrupt.actions[0].toolCallId, "call");
});

test("parallel token streams retain every fragment and complete each message once", async () => {
  const a = createScriptedChatModel({
    chunks: createScriptedMessageChunks(["A1", "A2", "A3"], { id: "A" }),
  });
  const b = createScriptedChatModel({
    chunks: createScriptedMessageChunks(["B1", "B2", "B3"], { id: "B" }),
  });
  const graph = new StateGraph(
    new StateSchema({ a: z.string(), b: z.string() }),
  )
    .addNode("nodeA", async () => ({ a: (await a.invoke("a")).content }))
    .addNode("nodeB", async () => ({ b: (await b.invoke("b")).content }))
    .addEdge(START, "nodeA")
    .addEdge(START, "nodeB")
    .addEdge("nodeA", END)
    .addEdge("nodeB", END)
    .compile();
  const events = await collect(
    new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    }).stream({ threadId: "tokens", input: {} }),
  );
  const state = reduce(events);
  assert.deepEqual(
    state.messages.map((message) => message.content[0].text).sort(),
    ["A1A2A3", "B1B2B3"],
  );
  assert.equal(
    events.filter((event) => event.type === "message.part.delta").length,
    6,
  );
  assert.equal(
    events.filter((event) => event.type === "message.started").length,
    2,
  );
  assert.equal(
    events.filter((event) => event.type === "message.completed").length,
    2,
  );
});

test.each(["interruptBefore", "interruptAfter"])(
  "static %s breakpoints pause and continue natively",
  async (kind) => {
    const effects = [];
    const graph = new StateGraph(
      new StateSchema({ value: z.string().default("") }),
    )
      .addNode("work", () => {
        effects.push("work");
        return { value: "done" };
      })
      .addNode("finish", () => {
        effects.push("finish");
        return {};
      })
      .addEdge(START, "work")
      .addEdge("work", "finish")
      .addEdge("finish", END)
      .compile({ checkpointer: new MemorySaver() });
    const runtime = new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    });
    const start = await collect(
      runtime.stream({
        threadId: kind,
        input: {},
        config: { [kind]: ["work"] },
      }),
    );
    assert.equal(start.at(-1).type, "run.paused");
    assert.equal(terminal(start).length, 0);
    assert.equal(reduce(start).status, "waiting");
    const seed = await runtime.getResumeState(kind);
    assert.ok(seed.pausedNodes.length);
    const end = await collect(
      runtime.stream({ threadId: kind, continue: true }),
    );
    assert.equal(end.at(-1).type, "run.completed");
    assert.deepEqual(effects, ["work", "finish"]);
    assert.equal(reduce(end, seed).status, "completed");
  },
);

test.each([false, true])(
  "native Command tools serve successful output (subgraphs=%s)",
  async (subgraphs) => {
    const { graph, effects } = approvalGraph({
      middleware: [],
      stateSchema: z.object({ note: z.string().default("") }),
      result: () =>
        new Command({
          update: {
            note: "changed",
            messages: [
              new ToolMessage({ content: "updated", tool_call_id: "call" }),
            ],
          },
        }),
    });
    const events = await collect(
      new Agentdock(graph, {
        interruptFormat: "langchain-hitl",
        validateResume: validateToolApprovalResume,
      }).stream({
        threadId: "command",
        input,
        config: { subgraphs },
      }),
    );
    assert.equal(events.at(-1).type, "run.completed");
    assert.equal(
      events.find((event) => event.type === "tool.completed").result.output,
      "updated",
    );
    assert.equal(
      (await graph.getState(config("command"))).values.note,
      "changed",
    );
    assert.deepEqual(effects, ["hello"]);
  },
);

test("tool roles and returned error status survive serving", async () => {
  const { graph } = approvalGraph({
    middleware: [],
    result: () =>
      new ToolMessage({
        content: "Access denied",
        tool_call_id: "call",
        status: "error",
      }),
  });
  const events = await collect(
    new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    }).stream({ threadId: "roles", input }),
  );
  const state = reduce(events);
  assert.equal(state.toolResults[0].isError, true);
  assert.equal(
    state.messages.find(
      (message) => message.content[0]?.text === "Access denied",
    ).role,
    "tool",
  );
  assert.equal(
    state.messages.find((message) => message.content[0]?.text === "done").role,
    "assistant",
  );
});

test("per-invocation usage aggregates models and nested native token details", async () => {
  const model = createScriptedChatModel({
    chunks: [
      new AIMessageChunk({
        id: "m",
        content: "one",
        usage_metadata: {
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
          input_token_details: { cache_read: 2 },
          output_token_details: { reasoning: 1 },
        },
      }),
    ],
  });
  const graph = new StateGraph(new StateSchema({ answer: z.string() }))
    .addNode("generate", async () => ({
      answer: (await model.invoke("hi")).content,
    }))
    .addEdge(START, "generate")
    .addEdge("generate", END)
    .compile();
  const events = await collect(
    new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    }).stream({ threadId: "usage", input: {} }),
  );
  assert.deepEqual(reduce(events).usage, {
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
    cachedInputTokens: 2,
    reasoningTokens: 1,
  });
  assert.deepEqual(events.at(-1).usage, reduce(events).usage);
});

test.each([false, true])(
  "nested graph messages and interrupts remain resumable (subgraphs=%s)",
  async (subgraphs) => {
    const state = new StateSchema({ text: z.string().default("") });
    const model = createScriptedChatModel({
      chunks: createScriptedMessageChunks(["child", " text"], {
        id: "child-message",
      }),
    });
    const child = new StateGraph(state)
      .addNode("model", async () => ({
        text: (await model.invoke("hi")).content,
      }))
      .addNode("approval", () => ({
        text: interrupt("Review the child answer"),
      }))
      .addEdge(START, "model")
      .addEdge("model", "approval")
      .addEdge("approval", END)
      .compile();
    const parent = new StateGraph(state)
      .addNode("child", child)
      .addEdge(START, "child")
      .addEdge("child", END)
      .compile({ checkpointer: new MemorySaver() });
    const runtime = new Agentdock(parent, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    });
    const start = await collect(
      runtime.stream({ threadId: "nested", input: {}, config: { subgraphs } }),
    );
    assert.equal(start.at(-1).type, "interrupt.required");
    const seed = await runtime.getResumeState("nested");
    assert.equal(
      seed.interrupt.interruptId,
      start.at(-1).interrupt.interruptId,
    );
    const resumed = await collect(
      new Agentdock(parent, {
        interruptFormat: "langchain-hitl",
        validateResume: validateToolApprovalResume,
      }).stream({
        threadId: "nested",
        resume: { [seed.interrupt.interruptId]: "approved child" },
        config: { subgraphs },
      }),
    );
    assert.equal(resumed.at(-1).type, "run.completed");
    assert.equal(reduce(resumed, seed).status, "completed");
    assert.equal(
      (await parent.getState(config("nested"))).values.text,
      "approved child",
    );
    if (subgraphs) {
      const deltas = start.filter(
        (event) => event.type === "message.part.delta",
      );
      assert.equal(deltas.length, 2);
      assert.ok(deltas.every((event) => event.namespace.length > 0));
    }
  },
);

test("sequential approvals retain independent native IDs across fresh runtimes", async () => {
  const effects = [];
  const graph = createAgent({
    model: createScriptedChatModel({
      streamSequences: [
        ...["one", "two"].map((q, index) =>
          createToolCallArgumentChunks({
            name: "lookup",
            toolCallId: `call-${index}`,
            input: { q },
            messageId: `m-${index}`,
          }),
        ),
        createScriptedMessageChunks(["done"], { id: "final" }),
      ],
    }),
    tools: [
      tool(
        async ({ q }) => {
          effects.push(q);
          return "ok";
        },
        {
          name: "lookup",
          description: "Lookup",
          schema: z.object({ q: z.string() }),
        },
      ),
    ],
    checkpointer: new MemorySaver(),
    middleware: [humanInTheLoopMiddleware({ interruptOn: { lookup: true } })],
  }).graph;
  let state = reduce(
    await collect(
      new Agentdock(graph, {
        interruptFormat: "langchain-hitl",
        validateResume: validateToolApprovalResume,
      }).stream({ threadId: "sequential", input }),
    ),
  );
  const ids = [];
  for (let index = 0; index < 2; index++) {
    ids.push(state.interrupt.interruptId);
    const events = await collect(
      new Agentdock(graph, {
        interruptFormat: "langchain-hitl",
        validateResume: validateToolApprovalResume,
      }).stream({
        threadId: "sequential",
        resume: {
          [state.interrupt.interruptId]: { decisions: [{ type: "approve" }] },
        },
      }),
    );
    state = reduce(events, state);
  }
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(effects, ["one", "two"]);
  assert.equal(state.status, "completed");
});

test.each(["approve", "edit", "reject"])(
  "native HITL decision %s preserves graph authority",
  async (type) => {
    const { graph, effects } = approvalGraph();
    const runtime = new Agentdock(graph, {
      interruptFormat: "langchain-hitl",
      validateResume: validateToolApprovalResume,
    });
    const start = await collect(runtime.stream({ threadId: type, input }));
    const decision =
      type === "edit"
        ? { type, editedAction: { name: "lookup", args: { q: "edited" } } }
        : { type };
    const end = await collect(
      runtime.stream({ threadId: type, resume: { decisions: [decision] } }),
    );
    assert.equal(end.at(-1).type, "run.completed");
    assert.deepEqual(
      effects,
      type === "reject" ? [] : [type === "edit" ? "edited" : "hello"],
    );
    assert.equal(reduce([...start, ...end]).status, "completed");
  },
);

test("pre-aborted resume preserves native task identity and remains retryable", async () => {
  const { graph, effects } = approvalGraph();
  const runtime = new Agentdock(graph, {
    interruptFormat: "langchain-hitl",
    validateResume: validateToolApprovalResume,
  });
  const start = await collect(
    runtime.stream({ threadId: "cancel-resume", input }),
  );
  const cancelled = await collect(
    runtime.stream({
      threadId: "cancel-resume",
      resume: { decisions: [{ type: "approve" }] },
      signal: AbortSignal.abort(),
    }),
  );
  assert.equal(cancelled.at(-1).type, "run.cancelled");
  assert.equal(cancelled.at(-1).recoverable, true);
  assert.deepEqual(effects, []);
  const seed = await runtime.getResumeState("cancel-resume");
  assert.equal(seed.interrupt.interruptId, start.at(-1).interrupt.interruptId);
  const end = await collect(
    runtime.stream({
      threadId: "cancel-resume",
      resume: { decisions: [{ type: "approve" }] },
    }),
  );
  assert.deepEqual(effects, ["hello"]);
  assert.equal(reduce([...start, ...cancelled, ...end]).status, "completed");
});

test("approval shape validation happens before Node and Web commit responses", async () => {
  const { graph } = approvalGraph();
  const runtime = new Agentdock(graph, {
    interruptFormat: "langchain-hitl",
    validateResume: validateToolApprovalResume,
  });
  await collect(runtime.stream({ threadId: "validation", input }));
  const response = {
    destroyed: false,
    writableEnded: false,
    on() {
      return this;
    },
    off() {
      return this;
    },
    writeHead() {
      throw new Error("Headers must not be sent");
    },
    write() {
      throw new Error("Must not write");
    },
    end() {
      throw new Error("Must not end");
    },
  };
  const invalid = { threadId: "validation", resume: { decisions: [] } };
  await assert.rejects(runtime.pipe(response, invalid), /Resume/);
  await assert.rejects(runtime.toResponse(invalid), /Resume/);
  assert.ok(await runtime.getResumeState("validation"));
});
