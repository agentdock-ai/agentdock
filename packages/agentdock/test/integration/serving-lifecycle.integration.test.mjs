import assert from "node:assert/strict";
import { test } from "vitest";
import {
  Annotation,
  Command,
  StateGraph,
  StateSchema,
  START,
  END,
  MemorySaver,
  interrupt,
  Send,
} from "@langchain/langgraph";
import { InMemoryCache } from "@langchain/langgraph-checkpoint";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
} from "@langchain/core/messages";
import { tool, createAgent, humanInTheLoopMiddleware } from "langchain";
import { z } from "zod";
import { Agentdock } from "../../src/index.js";
import {
  createAgentReducerState,
  reduceAgentEvent,
} from "@agentdock-ai/contracts";
import {
  createScriptedChatModel,
  createScriptedMessageChunks,
  createToolCallArgumentChunks,
} from "../helpers/stream-fixtures.mjs";
const config = (thread_id) => ({ configurable: { thread_id } });
const collect = async (source) => {
  const events = [];
  for await (const event of source) events.push(event);
  return events;
};
const reduce = (events, state = createAgentReducerState()) =>
  events.reduce(reduceAgentEvent, state);
const runtime = (graph) =>
  new Agentdock(graph, { interruptFormat: "langchain-hitl" });
function simple(node, fields = { value: z.unknown() }, options = {}) {
  const graph = new StateGraph(new StateSchema(fields))
    .addNode("work", node)
    .addEdge(START, "work")
    .addEdge("work", END)
    .compile({ checkpointer: new MemorySaver(), ...options });
  graph.updateState = () => {
    throw new Error("Serving must never write checkpoint state");
  };
  return graph;
}

for (const durability of ["sync", "async", "exit"]) {
  test.each([false, true])(
    `two interrupt calls in one node preserve unanswered occurrences (${durability}, identical=%s)`,
    async (identical) => {
      const graph = simple(() => {
        const a = interrupt("First?");
        const b = interrupt(identical ? "First?" : "Second?");
        return { value: [a, b] };
      });
      const run = { threadId: "two", config: { durability } };
      const first = await collect(
        new Agentdock(graph).stream({ ...run, input: {} }),
      );
      const seed = await new Agentdock(graph).getResumeState("two");
      const second = await collect(
        new Agentdock(graph).stream({
          ...run,
          resume: { [seed.interrupt.interruptId]: "a" },
        }),
      );
      const warm = reduce(second, reduce(first));
      const cold = await new Agentdock(graph).getResumeState("two");
      assert.equal(
        second.some((e) => e.type === "run.completed"),
        false,
      );
      assert.equal(
        second.filter((e) => e.type === "interrupt.resolved").length,
        1,
      );
      assert.equal(
        second.filter((e) => e.type === "interrupt.required").length,
        1,
      );
      assert.deepEqual(warm.interrupts, cold.interrupts);
      assert.deepEqual(warm.pausedNodes, cold.pausedNodes);
      assert.equal(cold.interrupt.prompt, identical ? "First?" : "Second?");
      const last = await collect(
        new Agentdock(graph).stream({ ...run, resume: "b" }),
      );
      assert.equal(reduce(last, warm).status, "completed");
      assert.deepEqual((await graph.getState(config("two"))).values.value, [
        "a",
        "b",
      ]);
      assert.equal(await new Agentdock(graph).getResumeState("two"), null);
    },
  );
  test.each([false, true])(
    `partial Send resume removes only the answered task (${durability}, subgraphs=%s)`,
    async (subgraphs) => {
      const effects = [];
      const fields = Annotation.Root({
        values: Annotation({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const graph = new StateGraph(fields)
        .addNode("dispatch", () => ({}))
        .addNode("worker", (state) => {
          const value = interrupt({ prompt: state.name });
          effects.push(state.name);
          return { values: [value] };
        })
        .addEdge(START, "dispatch")
        .addConditionalEdges(
          "dispatch",
          () => [
            new Send("worker", { name: "A" }),
            new Send("worker", { name: "B" }),
          ],
          ["worker"],
        )
        .addEdge("worker", END)
        .compile({ checkpointer: new MemorySaver() });
      const run = { threadId: "fan", config: { durability, subgraphs } };
      const first = await collect(
        new Agentdock(graph).stream({ ...run, input: { values: [] } }),
      );
      const state = reduce(first);
      assert.equal(state.interrupts.length, 2);
      const a = state.interrupts.find((i) => i.prompt === "A");
      const b = state.interrupts.find((i) => i.prompt === "B");
      const next = await collect(
        new Agentdock(graph).stream({
          ...run,
          resume: { [a.interruptId]: "a" },
        }),
      );
      const warm = reduce(next, state);
      const cold = await new Agentdock(graph).getResumeState("fan");
      assert.deepEqual(
        warm.interrupts.map((i) => i.interruptId),
        [b.interruptId],
      );
      assert.deepEqual(cold.interrupts, warm.interrupts);
      assert.deepEqual(warm.pausedNodes, cold.pausedNodes);
      assert.deepEqual(cold.pausedNodes, ["worker"]);
      assert.equal(
        next.some(
          (e) =>
            e.type === "interrupt.resolved" && e.interruptId === a.interruptId,
        ),
        true,
      );
      const end = await collect(
        new Agentdock(graph).stream({
          ...run,
          resume: { [b.interruptId]: "b" },
        }),
      );
      assert.equal(reduce(end, warm).status, "completed");
      assert.deepEqual(effects.sort(), ["A", "B"]);
      assert.deepEqual(
        (await graph.getState(config("fan"))).values.values.sort(),
        ["a", "b"],
      );
    },
  );
}

test("resuming an explicit historical checkpoint reconciles its produced checkpoint", async () => {
  const graph = simple(() => ({ value: interrupt("Approve?") }));
  const start = await collect(
    new Agentdock(graph).stream({ threadId: "pin", input: {} }),
  );
  const old = await graph.getState(config("pin"));
  const reads = [];
  const read = graph.getState.bind(graph);
  graph.getState = (cfg, options) => {
    reads.push(cfg);
    return read(cfg, options);
  };
  const end = await collect(
    new Agentdock(graph).stream({
      threadId: "pin",
      resume: true,
      config: old.config,
    }),
  );
  assert.equal(reduce([...start, ...end]).status, "completed");
  assert.equal((await read(config("pin"))).values.value, true);
  assert.equal((await read(old.config)).tasks[0].interrupts.length, 1);
  assert.equal(reads.length, 1);
  assert.equal(
    reads[0].configurable.checkpoint_id,
    old.config.configurable.checkpoint_id,
  );
});

function afterApproval({ cancel } = {}) {
  let attempts = 0;
  return new StateGraph(
    new StateSchema({
      approved: z.boolean().default(false),
      value: z.string().default(""),
    }),
  )
    .addNode("ask", () => ({ approved: interrupt("Approve?") }))
    .addNode("work", () => {
      if (++attempts === 1) {
        if (cancel) cancel.abort();
        throw new Error("transient");
      }
      return { value: "done" };
    })
    .addEdge(START, "ask")
    .addEdge("ask", "work")
    .addEdge("work", END)
    .compile({ checkpointer: new MemorySaver() });
}
test.each([false, true])(
  "failure or cancellation after approval agrees with cold native state (cancel=%s)",
  async (cancelled) => {
    const controller = new AbortController();
    const graph = afterApproval({ cancel: cancelled ? controller : undefined });
    const start = await collect(
      new Agentdock(graph).stream({ threadId: "failure", input: {} }),
    );
    const failed = await collect(
      new Agentdock(graph).stream({
        threadId: "failure",
        resume: true,
        signal: controller.signal,
      }),
    );
    const warm = reduce([...start, ...failed]);
    const cold = await new Agentdock(graph).getResumeState("failure");
    assert.equal(
      failed.at(-1).type,
      cancelled ? "run.cancelled" : "run.failed",
    );
    assert.equal(failed.at(-1).recoverable, true);
    assert.deepEqual(warm.interrupts, []);
    assert.deepEqual(warm.pausedNodes, cold.pausedNodes);
    const end = await collect(
      new Agentdock(graph).stream({ threadId: "failure", input: null }),
    );
    assert.equal(reduce(end, warm).status, "completed");
    assert.equal(
      (await graph.getState(config("failure"))).values.value,
      "done",
    );
  },
);

test.each([false, true])(
  "native Command input preserves resume, update and client control state (ID map=%s)",
  async (idMap) => {
    const graph = simple(() => ({ value: interrupt("Approve?") }), {
      value: z.boolean(),
      note: z.string().default(""),
    });
    const start = await collect(
      new Agentdock(graph).stream({ threadId: "command", input: {} }),
    );
    const resume = idMap
      ? { [start.at(-1).interrupt.interruptId]: true }
      : true;
    const end = await collect(
      new Agentdock(graph).stream({
        threadId: "command",
        input: new Command({ resume, update: { note: "edited" } }),
      }),
    );
    assert.equal(reduce([...start, ...end]).status, "completed");
    assert.deepEqual((await graph.getState(config("command"))).values, {
      value: true,
      note: "edited",
    });
    assert.equal(end.filter((e) => e.type === "interrupt.resolved").length, 1);
  },
);

test.each([
  {
    reviewConfigs: [],
    actionRequests: [{ name: "choose", args: {} }],
    prompt: "Custom",
  },
  {
    reviewConfigs: [{ actionName: "anything", allowedDecisions: ["approve"] }],
    actionRequests: [{ name: "anything", args: {} }],
  },
  ["any", "JSON", 1],
  false,
])("generic interrupts keep arbitrary payloads opaque: %j", async (payload) => {
  const graph = simple(() => ({ value: interrupt(payload) }));
  const start = await collect(
    new Agentdock(graph).stream({ threadId: "opaque", input: {} }),
  );
  assert.equal(start.at(-1).type, "interrupt.required");
  assert.equal(start.at(-1).interrupt.kind, "custom");
  assert.deepEqual(start.at(-1).interrupt.payload, payload);
  assert.deepEqual(start.at(-1).interrupt.actions, []);
  const seed = await new Agentdock(graph).getResumeState("opaque");
  assert.deepEqual(seed.interrupt.payload, payload);
  const end = await collect(
    new Agentdock(graph).stream({
      threadId: "opaque",
      resume: { chosen: true },
    }),
  );
  assert.equal(reduce([...start, ...end]).status, "completed");
  assert.deepEqual((await graph.getState(config("opaque"))).values.value, {
    chosen: true,
  });
});
function agent({
  middleware = [
    humanInTheLoopMiddleware({
      interruptOn: { lookup: { allowedDecisions: ["approve"] } },
    }),
  ],
} = {}) {
  const effects = [];
  const graph = createAgent({
    model: createScriptedChatModel({
      streamSequences: [
        createToolCallArgumentChunks({
          name: "lookup",
          toolCallId: "call",
          input: { q: "original" },
          messageId: "m",
        }),
        createScriptedMessageChunks(["done"], { id: "answer" }),
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
    middleware,
    checkpointer: new MemorySaver(),
  }).graph;
  return { graph, effects };
}
test("current native middleware context owns decision permissions", async () => {
  const { graph, effects } = agent();
  const start = await collect(
    runtime(graph).stream({
      threadId: "policy",
      input: { messages: [new HumanMessage("hi")] },
    }),
  );
  assert.equal(start.at(-1).interrupt.kind, "tool-approval");
  const end = await collect(
    runtime(graph).stream({
      threadId: "policy",
      resume: {
        decisions: [
          {
            type: "edit",
            editedAction: { name: "lookup", args: { q: "edited" } },
          },
        ],
      },
      context: { interruptOn: { lookup: { allowedDecisions: ["edit"] } } },
    }),
  );
  assert.equal(reduce([...start, ...end]).status, "completed");
  assert.deepEqual(effects, ["edited"]);
});

test("parallel unnamed native tools finishing in reverse order retain correct results", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const lookup = tool(
    async ({ q }) => {
      if (q === "A") await gate;
      return `result-${q}`;
    },
    {
      name: "lookup",
      description: "Lookup",
      schema: z.object({ q: z.string() }),
    },
  );
  const graph = simple(async () => ({
    value: await Promise.all([
      lookup.invoke({ q: "A" }),
      lookup.invoke({ q: "B" }),
    ]),
  })).withConfig({
    callbacks: [
      {
        handleToolEnd(output) {
          if (output === "result-B") release();
        },
      },
    ],
  });
  const events = await collect(
    new Agentdock(graph).stream({ threadId: "tools", input: {} }),
  );
  const results = reduce(events).toolResults;
  assert.deepEqual(
    results.map((r) => r.input.q),
    ["B", "A"],
  );
  assert.equal(results.length, 2);
  assert.equal(new Set(results.map((r) => r.toolCallId)).size, 2);
  for (const result of results)
    assert.equal(result.output, `result-${result.input.q}`);
  assert.deepEqual((await graph.getState(config("tools"))).values.value, [
    "result-A",
    "result-B",
  ]);
});

test.each([false, true])(
  "approval identity matches native tool execution across resume (nested=%s)",
  async (nested) => {
    const { graph: child } = agent();
    const graph = nested
      ? new StateGraph(
          Annotation.Root({
            messages: Annotation({
              reducer: (a, b) => a.concat(b),
              default: () => [],
            }),
          }),
        )
          .addNode("child", child)
          .addEdge(START, "child")
          .addEdge("child", END)
          .compile({ checkpointer: new MemorySaver() })
      : child;
    const start = await collect(
      runtime(graph).stream({
        threadId: "ids",
        input: { messages: [new HumanMessage("hi")] },
        config: { subgraphs: true },
      }),
    );
    const cold = await runtime(graph).getResumeState("ids");
    assert.deepEqual(cold.interrupts, reduce(start).interrupts);
    const end = await collect(
      runtime(graph).stream({
        threadId: "ids",
        resume: {
          [cold.interrupt.interruptId]: { decisions: [{ type: "approve" }] },
        },
        config: { subgraphs: true },
      }),
    );
    const called = end.find((e) => e.type === "tool.called");
    assert.equal(
      cold.interrupt.actions[0].toolCallId,
      called.toolCall.toolCallId,
    );
    assert.equal(reduce(end, cold).status, "completed");
  },
);

test("native cache hits emit the same answer without another model invocation", async () => {
  let calls = 0;
  const model = createScriptedChatModel({
    chunks: [
      new AIMessageChunk({ id: "cached", content: "cached" }),
      new AIMessageChunk({
        id: "cached",
        content: " answer",
        usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      }),
    ],
  });
  const graph = new StateGraph(
    new StateSchema({ messages: z.array(z.unknown()) }),
  )
    .addNode(
      "generate",
      async () => {
        calls++;
        return { messages: [await model.invoke("hi")] };
      },
      { cachePolicy: { ttl: 60 } },
    )
    .addEdge(START, "generate")
    .addEdge("generate", END)
    .compile({ cache: new InMemoryCache() });
  const first = await collect(
    new Agentdock(graph).stream({
      threadId: "cache-1",
      input: { messages: [] },
    }),
  );
  const second = await collect(
    new Agentdock(graph).stream({
      threadId: "cache-2",
      input: { messages: [] },
    }),
  );
  assert.equal(calls, 1);
  assert.deepEqual(reduce(second).messages, reduce(first).messages);
  assert.equal(reduce(second).messages[0].content[0].text, "cached answer");
  assert.equal(first.filter((e) => e.type === "usage.updated").length, 1);
  assert.equal(second.filter((e) => e.type === "usage.updated").length, 0);
  assert.deepEqual(first.at(-1).usage, {
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
  });
  assert.equal(second.at(-1).usage, undefined);
  for (const events of [first, second]) {
    assert.equal(
      events.filter((e) => e.type === "message.completed").length,
      1,
    );
    assert.equal(events.at(-1).type, "run.completed");
  }
});
test("returned full message updates do not replay input history", async () => {
  const history = new AIMessage({ id: "old", content: "old answer" });
  const graph = simple(
    (state) => ({
      messages: [
        ...state.messages,
        new AIMessage({ id: "new", content: "new answer" }),
      ],
    }),
    { messages: z.array(z.unknown()) },
  );
  const events = await collect(
    new Agentdock(graph).stream({
      threadId: "history",
      input: { messages: [history] },
    }),
  );
  assert.deepEqual(
    reduce(events).messages.map((m) => m.messageId),
    ["new"],
  );
});
test("graph-configured recursion limit remains native unless explicitly overridden", async () => {
  const graph = new StateGraph(
    new StateSchema({ value: z.number().default(0) }),
  )
    .addNode("increment", (state) => ({ value: state.value + 1 }))
    .addEdge(START, "increment")
    .addConditionalEdges("increment", (state) =>
      state.value < 30 ? "increment" : END,
    )
    .compile()
    .withConfig({ recursionLimit: 40 });
  const end = await collect(
    new Agentdock(graph).stream({ threadId: "limit", input: { value: 0 } }),
  );
  assert.equal(end.at(-1).type, "run.completed");
  const limited = await collect(
    new Agentdock(graph, { recursionLimit: 2 }).stream({
      threadId: "limit-2",
      input: { value: 0 },
    }),
  );
  assert.equal(limited.at(-1).type, "run.failed");
});
test("static interruptAfter at the final node completes without a dead-end pause", async () => {
  const graph = simple(() => ({ value: "done" }));
  const events = await collect(
    new Agentdock(graph).stream({
      threadId: "last",
      input: {},
      config: { interruptAfter: ["work"] },
    }),
  );
  assert.equal(events.at(-1).type, "run.completed");
  assert.equal(await new Agentdock(graph).getResumeState("last"), null);
  const noop = await collect(
    new Agentdock(graph).stream({ threadId: "last", continue: true }),
  );
  assert.equal(noop.at(-1).type, "run.completed");
});
test("a failed initial native task is recoverable and continues natively", async () => {
  let tries = 0;
  const graph = simple(() => {
    if (++tries === 1) throw new Error("transient");
    return { value: "done" };
  });
  const failed = await collect(
    new Agentdock(graph).stream({ threadId: "retry", input: {} }),
  );
  assert.equal(failed.at(-1).recoverable, true);
  const cold = await new Agentdock(graph).getResumeState("retry");
  assert.deepEqual(reduce(failed).pausedNodes, cold.pausedNodes);
  const end = await collect(
    new Agentdock(graph).stream({ threadId: "retry", continue: true }),
  );
  assert.equal(reduce(end, reduce(failed)).status, "completed");
  assert.equal(tries, 2);
});

test("native response schemas survive serving and hydration; invalid resumes can be corrected", async () => {
  const schema = z.object({ answer: z.string().min(1) });
  const graph = simple(() => ({
    value: interrupt({ prompt: "Answer" }, { responseSchema: schema }),
  }));
  const start = await collect(
    new Agentdock(graph).stream({ threadId: "schema", input: {} }),
  );
  const pending = reduce(start).interrupt;
  assert.equal(pending.responseSchema.type, "object");
  assert.deepEqual(
    (await new Agentdock(graph).getResumeState("schema")).interrupt
      .responseSchema,
    pending.responseSchema,
  );
  const failed = await collect(
    new Agentdock(graph).stream({ threadId: "schema", resume: { answer: "" } }),
  );
  assert.equal(failed.at(-1).type, "run.failed");
  const end = await collect(
    new Agentdock(graph).stream({
      threadId: "schema",
      resume: { answer: "corrected" },
    }),
  );
  assert.equal(end.at(-1).type, "run.completed");
  assert.equal(reduce([...start, ...failed, ...end]).status, "completed");
  assert.deepEqual((await graph.getState(config("schema"))).values.value, {
    answer: "corrected",
  });
});

test("failure after nodes returning no values finds the invocation's native checkpoint", async () => {
  let tries = 0;
  const graph = new StateGraph(
    new StateSchema({ value: z.string().default("") }),
  )
    .addNode("empty", () => ({}))
    .addNode("fail", () => {
      if (++tries === 1) throw new Error("retry");
      return { value: "done" };
    })
    .addEdge(START, "empty")
    .addEdge("empty", "fail")
    .addEdge("fail", END)
    .compile({ checkpointer: new MemorySaver() });
  const failed = await collect(
    new Agentdock(graph).stream({ threadId: "empty", input: {} }),
  );
  assert.equal(failed.at(-1).recoverable, true);
  assert.deepEqual(reduce(failed).pausedNodes, ["fail"]);
  assert.deepEqual(
    (await new Agentdock(graph).getResumeState("empty")).pausedNodes,
    ["fail"],
  );
  const end = await collect(
    new Agentdock(graph).stream({ threadId: "empty", continue: true }),
  );
  assert.equal(reduce(end, reduce(failed)).status, "completed");
});

test("native tool generators correlate progress, one failure and one success", async () => {
  const lookup = tool(
    async function* ({ q }) {
      yield `progress-${q}`;
      if (q === "bad") throw new Error("private-tool-error");
      return `result-${q}`;
    },
    {
      name: "lookup",
      description: "Lookup",
      schema: z.object({ q: z.string() }),
    },
  );
  const graph = simple(async () => {
    const result = await Promise.allSettled([
      lookup.invoke({ q: "bad" }),
      lookup.invoke({ q: "good" }),
    ]);
    return { value: result.map((r) => r.status) };
  });
  const events = await collect(
    new Agentdock(graph).stream({ threadId: "tool-errors", input: {} }),
  );
  const state = reduce(events);
  assert.equal(state.toolResults[0].input.q, "good");
  assert.equal(state.toolErrors[0].input.q, "bad");
  const calls = new Map(state.toolCalls.map((c) => [c.toolCallId, c.input.q]));
  for (const progress of state.toolProgress)
    assert.equal(
      progress.content[0].text,
      `progress-${calls.get(progress.toolCallId)}`,
    );
  assert.equal(state.toolProgress.length, 2);
  assert.equal(state.status, "completed");
  assert.equal(JSON.stringify(events).includes("private-tool-error"), false);
});
test("parallel child agents reusing native call IDs keep independent approval correlations", async () => {
  const a = agent();
  const b = agent();
  const graph = new StateGraph(
    Annotation.Root({
      messages: Annotation({
        reducer: (x, y) => x.concat(y),
        default: () => [],
      }),
    }),
  )
    .addNode("a", a.graph)
    .addNode("b", b.graph)
    .addEdge(START, "a")
    .addEdge(START, "b")
    .addEdge("a", END)
    .addEdge("b", END)
    .compile({ checkpointer: new MemorySaver() });
  const start = await collect(
    runtime(graph).stream({
      threadId: "children",
      input: { messages: [new HumanMessage("hi")] },
      config: { subgraphs: true },
    }),
  );
  const seed = await runtime(graph).getResumeState("children");
  assert.equal(seed.interrupts.length, 2);
  const approved = seed.interrupts.map((i) => i.actions[0].toolCallId);
  assert.equal(new Set(approved).size, 2);
  const end = await collect(
    runtime(graph).stream({
      threadId: "children",
      resume: Object.fromEntries(
        seed.interrupts.map((i) => [
          i.interruptId,
          { decisions: [{ type: "approve" }] },
        ]),
      ),
      config: { subgraphs: true },
    }),
  );
  assert.deepEqual(
    end
      .filter((e) => e.type === "tool.called")
      .map((e) => e.toolCall.toolCallId)
      .sort(),
    approved.sort(),
  );
  assert.equal(reduce([...start, ...end]).status, "completed");
  assert.deepEqual(a.effects, ["original"]);
  assert.deepEqual(b.effects, ["original"]);
});
test("hidden native cached outputs remain hidden", async () => {
  const graph = new StateGraph(
    new StateSchema({ messages: z.array(z.unknown()) }),
  )
    .addNode(
      "generate",
      () => ({
        messages: [new AIMessage({ id: "secret", content: "hidden answer" })],
      }),
      { cachePolicy: { ttl: 60 } },
    )
    .addEdge(START, "generate")
    .addEdge("generate", END)
    .compile({ cache: new InMemoryCache() });
  for (const threadId of ["hidden-1", "hidden-2"]) {
    const events = await collect(
      new Agentdock(graph).stream({
        threadId,
        input: { messages: [] },
        config: { tags: ["langsmith:hidden"] },
      }),
    );
    assert.equal(events.at(-1).type, "run.completed");
    assert.deepEqual(reduce(events).messages, []);
    assert.equal(JSON.stringify(events).includes("hidden answer"), false);
  }
});

test("native context can remove approval requirements without a serving policy veto", async () => {
  const { graph, effects } = agent();
  const start = await collect(
    runtime(graph).stream({
      threadId: "removed-policy",
      input: { messages: [new HumanMessage("hi")] },
    }),
  );
  const end = await collect(
    runtime(graph).stream({
      threadId: "removed-policy",
      resume: { decisions: [] },
      context: { interruptOn: { lookup: false } },
    }),
  );
  assert.equal(reduce([...start, ...end]).status, "completed");
  assert.deepEqual(effects, ["original"]);
});

test("a new native interruption survives a parallel task failure and can be resumed", async () => {
  let tries = 0;
  const graph = new StateGraph(
    new StateSchema({
      answer: z.string().default(""),
      result: z.string().default(""),
    }),
  )
    .addNode("ask", () => ({ answer: interrupt("Question") }))
    .addNode("work", () => {
      if (++tries === 1) throw new Error("temporary");
      return { result: "done" };
    })
    .addEdge(START, "ask")
    .addEdge(START, "work")
    .addEdge("ask", END)
    .addEdge("work", END)
    .compile({ checkpointer: new MemorySaver() });
  const first = await collect(
    new Agentdock(graph).stream({ threadId: "parallel-error", input: {} }),
  );
  const warm = reduce(first);
  const cold = await new Agentdock(graph).getResumeState("parallel-error");
  assert.equal(first.at(-1).type, "run.failed");
  assert.equal(first.at(-1).recoverable, true);
  assert.deepEqual(warm.interrupts, cold.interrupts);
  assert.equal(warm.interrupts.length, 1);
  const end = await collect(
    new Agentdock(graph).stream({
      threadId: "parallel-error",
      resume: "answer",
    }),
  );
  assert.equal(reduce(end, warm).status, "completed");
  assert.deepEqual((await graph.getState(config("parallel-error"))).values, {
    answer: "answer",
    result: "done",
  });
});

test("an unaddressed native ID map does not falsely resolve the same question", async () => {
  const graph = simple(() => ({ value: interrupt("Question") }));
  const start = await collect(
    new Agentdock(graph).stream({ threadId: "ignored", input: {} }),
  );
  const pending = reduce(start).interrupt;
  const ignored = await collect(
    new Agentdock(graph).stream({
      threadId: "ignored",
      resume: { "00000000000000000000000000000000": "other" },
    }),
  );
  assert.equal(
    ignored.some((e) => e.type === "interrupt.resolved"),
    false,
  );
  assert.deepEqual(reduce(ignored, reduce(start)).interrupt, pending);
  const end = await collect(
    new Agentdock(graph).stream({ threadId: "ignored", resume: "answer" }),
  );
  assert.equal(reduce([...start, ...ignored, ...end]).status, "completed");
});
test("opaque custom resume objects retain ID-like keys and decisions as data", async () => {
  const graph = simple(() => ({ value: interrupt("Question") }));
  const start = await collect(
    new Agentdock(graph).stream({ threadId: "custom-data", input: {} }),
  );
  const id = reduce(start).interrupt.interruptId;
  const answer = { [id]: "inner", decisions: [1, 2], answer: "outer" };
  const end = await collect(
    new Agentdock(graph).stream({
      threadId: "custom-data",
      resume: { [id]: answer },
    }),
  );
  assert.deepEqual(end.find((e) => e.type === "interrupt.resolved").decisions, [
    answer,
  ]);
  assert.deepEqual(
    (await graph.getState(config("custom-data"))).values.value,
    answer,
  );
});

test("uncaught native tool errors retain execution identity and sanitized failure events", async () => {
  const lookup = tool(
    async () => {
      throw new Error("private-tool-secret");
    },
    {
      name: "lookup",
      description: "Lookup",
      schema: z.object({ q: z.string() }),
    },
  );
  const graph = simple(async () => ({
    value: await lookup.invoke({ q: "bad" }),
  }));
  const events = await collect(
    new Agentdock(graph).stream({ threadId: "uncaught-tool", input: {} }),
  );
  const called = events.find((e) => e.type === "tool.called");
  const failed = events.find((e) => e.type === "tool.failed");
  assert.ok(failed);
  assert.equal(failed.error.toolCallId, called.toolCall.toolCallId);
  assert.equal(JSON.stringify(events).includes("private-tool-secret"), false);
  assert.equal(events.at(-1).type, "run.failed");
  assert.equal(reduce(events).status, "waiting");
});
