import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  Command,
  isCommand,
  MemorySaver,
  StateGraph,
  StateSchema,
  START,
  END,
  interrupt,
} from "@langchain/langgraph";
import { z } from "zod";
import { Agentdock } from "../../src/index.js";
import {
  checkpointDigest,
  collectEvents,
  createSchemaWorkflow,
  forbidServingWrites,
  reduceEvents,
  threadConfig,
  workflowInput,
} from "../helpers/native-state-fixtures.mjs";

const readCases = ["sync", "async", "exit"].flatMap((durability) =>
  [false, true].flatMap((nested) =>
    ["first", "second", "completed"].map((stage) => ({
      durability,
      nested,
      stage,
    })),
  ),
);

test.each(readCases)(
  "checkpoint reads remain immutable: $durability / nested=$nested / $stage",
  async ({ durability, nested, stage }) => {
    const saver = new MemorySaver();
    const child = createSchemaWorkflow(saver, "zod");
    const graph = nested
      ? new StateGraph(
          new StateSchema({
            business: z.unknown(),
            answers: z.array(z.unknown()),
            total: z.number(),
          }),
        )
          .addNode("child", child)
          .addEdge(START, "child")
          .addEdge("child", END)
          .compile({ checkpointer: saver })
      : child;
    const assertNoWrites = forbidServingWrites(graph);
    const assertNoChildWrites = forbidServingWrites(child);
    const config = threadConfig("read-only", { durability });
    await graph.invoke(workflowInput("zod"), config);
    if (stage !== "first")
      await graph.invoke(new Command({ resume: "one" }), config);
    if (stage === "completed")
      await graph.invoke(new Command({ resume: "two" }), config);
    const nativeBefore = await graph.getState(config, { subgraphs: true });
    const historyBefore = await checkpointDigest(saver, config);
    const writes = ["put", "putWrites", "deleteThread"].map((name) =>
      vi.spyOn(saver, name),
    );
    const runtime = new Agentdock(graph);
    const expected = await runtime.getResumeState("read-only");
    for (let index = 0; index < 3; index++) {
      const seed = await new Agentdock(graph).getResumeState("read-only");
      assert.deepEqual(seed, expected);
      assert.deepEqual(await runtime.getMessages("read-only"), []);
      if (seed) {
        seed.pausedNodes.push("fabricated-node");
        seed.interrupt.prompt = "Changed client prompt";
        seed.interrupt.payload.details.owner = "Changed client owner";
        seed.interrupt.payload.details.labels.push("Changed client label");
        seed.interrupt.actions.push({
          toolCallId: "fake",
          name: "fake",
          input: {},
        });
      }
    }
    assert.deepEqual(
      await graph.getState(config, { subgraphs: true }),
      nativeBefore,
    );
    assert.equal(await checkpointDigest(saver, config), historyBefore);
    for (const write of writes) assert.equal(write.mock.calls.length, 0);
    assertNoWrites();
    assertNoChildWrites();
    if (stage === "completed") assert.equal(expected, null);
    else
      assert.equal(
        expected.interrupt.prompt,
        stage === "first" ? "First?" : "Second?",
      );
  },
);

test("thread identity overrides a conflicting caller configuration for hydration and continuation", async () => {
  const saver = new MemorySaver();
  const graph = createSchemaWorkflow(saver, "zod");
  const runtime = new Agentdock(graph);
  for (const threadId of ["allowed", "other"])
    await graph.invoke(
      { ...workflowInput("zod"), business: { owner: threadId, labels: [] } },
      threadConfig(threadId),
    );
  const otherBefore = await checkpointDigest(saver, threadConfig("other"));
  const hostileConfig = threadConfig("other");
  const seed = await runtime.getResumeState("allowed", hostileConfig);
  assert.equal(seed.interrupt.payload.details.owner, "allowed");
  const events = await collectEvents(
    runtime.stream({
      threadId: "allowed",
      resume: "one",
      config: hostileConfig,
    }),
  );
  assert.equal(reduceEvents(events, seed).interrupt.prompt, "Second?");
  assert.deepEqual(hostileConfig, threadConfig("other"));
  assert.equal(
    await checkpointDigest(saver, threadConfig("other")),
    otherBefore,
  );
});

test("checkpoint read errors fail before execution and preserve a valid native retry", async () => {
  const saver = new MemorySaver();
  const effects = [];
  const graph = createSchemaWorkflow(saver, "zod", effects);
  await graph.invoke(workflowInput("zod"), threadConfig("read-error"));
  const historyBefore = await checkpointDigest(
    saver,
    threadConfig("read-error"),
  );
  const effectsBefore = structuredClone(effects);
  const stream = vi.spyOn(graph, "stream");
  const getTuple = vi
    .spyOn(saver, "getTuple")
    .mockRejectedValue(new Error("Storage unavailable"));
  await assert.rejects(
    () => new Agentdock(graph).getResumeState("read-error"),
    /Storage unavailable/,
  );
  await assert.rejects(
    () =>
      collectEvents(
        new Agentdock(graph).stream({ threadId: "read-error", resume: "one" }),
      ),
    /Storage unavailable/,
  );
  assert.equal(stream.mock.calls.length, 0);
  assert.deepEqual(effects, effectsBefore);
  getTuple.mockRestore();
  assert.equal(
    await checkpointDigest(saver, threadConfig("read-error")),
    historyBefore,
  );
  const seed = await new Agentdock(graph).getResumeState("read-error");
  const retry = await collectEvents(
    new Agentdock(graph).stream({ threadId: "read-error", resume: "one" }),
  );
  assert.equal(reduceEvents(retry, seed).status, "waiting");
  assert.equal(
    (await new Agentdock(graph).getResumeState("read-error")).interrupt.prompt,
    "Second?",
  );
});

test("ephemeral invocation context is forwarded without becoming graph state or serving checkpoint metadata", async () => {
  const saver = new MemorySaver();
  const contexts = [];
  const graph = new StateGraph(new StateSchema({ approved: z.boolean() }))
    .addNode("ask", (_state, config) => {
      contexts.push(config.context.token);
      return { approved: interrupt("Approve?") };
    })
    .addEdge(START, "ask")
    .addEdge("ask", END)
    .compile({ checkpointer: saver });
  const assertNoWrites = forbidServingWrites(graph);
  const first = await collectEvents(
    new Agentdock(graph).stream({
      threadId: "context",
      input: { approved: false },
      context: { token: "ephemeral-first-secret" },
    }),
  );
  const second = await collectEvents(
    new Agentdock(graph).stream({
      threadId: "context",
      resume: true,
      context: { token: "ephemeral-resume-secret" },
    }),
  );
  assert.deepEqual(contexts, [
    "ephemeral-first-secret",
    "ephemeral-resume-secret",
  ]);
  assert.equal(reduceEvents([...first, ...second]).status, "completed");
  assert.deepEqual((await graph.getState(threadConfig("context"))).values, {
    approved: true,
  });
  assert.equal(
    (await checkpointDigest(saver, threadConfig("context"))).includes(
      "ephemeral-",
    ),
    false,
  );
  assertNoWrites();
});

test("native input, native Command and convenience resume retain caller data and checkpoint selection", async () => {
  const saver = new MemorySaver();
  const graph = new StateGraph(
    new StateSchema({ answer: z.unknown(), note: z.string() }),
  )
    .addNode("ask", () => ({ answer: interrupt("Question") }))
    .addEdge(START, "ask")
    .addEdge("ask", END)
    .compile({ checkpointer: saver });
  const assertNoWrites = forbidServingWrites(graph);
  const stream = vi.spyOn(graph, "stream");
  const input = Object.freeze({ answer: null, note: "Keep" });
  const initial = await collectEvents(
    new Agentdock(graph).stream({ threadId: "native-command", input }),
  );
  assert.equal(stream.mock.calls[0][0], input);
  const before = await graph.getState(threadConfig("native-command"));
  const command = new Command({
    resume: { [initial.at(-1).interrupt.interruptId]: { answer: false } },
    update: { note: "Native update" },
  });
  const completed = await collectEvents(
    new Agentdock(graph).stream({
      threadId: "native-command",
      input: command,
      config: before.config,
    }),
  );
  const [forwarded, options] = stream.mock.calls.at(-1);
  assert.equal(forwarded, command);
  assert.equal(
    options.configurable.checkpoint_id,
    before.config.configurable.checkpoint_id,
  );
  assert.equal(reduceEvents([...initial, ...completed]).status, "completed");
  assert.deepEqual(
    (await graph.getState(threadConfig("native-command"))).values,
    { answer: { answer: false }, note: "Native update" },
  );
  const convenience = await collectEvents(
    new Agentdock(graph).stream({ threadId: "convenience", input }),
  );
  const answer = { [convenience.at(-1).interrupt.interruptId]: null };
  await collectEvents(
    new Agentdock(graph).stream({ threadId: "convenience", resume: answer }),
  );
  assert.equal(isCommand(stream.mock.calls.at(-1)[0]), true);
  assert.equal(stream.mock.calls.at(-1)[0].resume, answer);
  assertNoWrites();
});

test.each(["native", "adapter"])(
  "native node retry policy owns attempts after approval (%s)",
  async (mode) => {
    let attempts = 0;
    const graph = new StateGraph(
      new StateSchema({ approved: z.boolean(), result: z.number() }),
    )
      .addNode("ask", () => ({ approved: interrupt("Approve?") }))
      .addNode(
        "work",
        () => {
          if (++attempts < 3) throw new Error("Transient failure");
          return { result: attempts };
        },
        {
          retryPolicy: {
            maxAttempts: 3,
            initialInterval: 1,
            maxInterval: 1,
            jitter: false,
            retryOn: () => true,
            logWarning: false,
          },
        },
      )
      .addEdge(START, "ask")
      .addEdge("ask", "work")
      .addEdge("work", END)
      .compile({ checkpointer: new MemorySaver() });
    const assertNoWrites = forbidServingWrites(graph);
    await graph.invoke(
      { approved: false, result: 0 },
      threadConfig("retry-policy"),
    );
    if (mode === "native")
      await graph.invoke(
        new Command({ resume: true }),
        threadConfig("retry-policy"),
      );
    else {
      const seed = await new Agentdock(graph).getResumeState("retry-policy");
      const events = await collectEvents(
        new Agentdock(graph).stream({ threadId: "retry-policy", resume: true }),
      );
      assert.equal(reduceEvents(events, seed).status, "completed");
      assert.equal(
        events.some((event) => event.type === "run.failed"),
        false,
      );
    }
    assert.equal(attempts, 3);
    assert.deepEqual(
      (await graph.getState(threadConfig("retry-policy"))).values,
      { approved: true, result: 3 },
    );
    assertNoWrites();
  },
);

test("a graph without a checkpointer can complete without the Agentdock schema", async () => {
  const graph = new StateGraph(new StateSchema({ count: z.number() }))
    .addNode("work", (state) => ({ count: state.count + 1 }))
    .addEdge(START, "work")
    .addEdge("work", END)
    .compile();
  const assertNoWrites = forbidServingWrites(graph);
  const events = await collectEvents(
    new Agentdock(graph).stream({ threadId: "stateless", input: { count: 1 } }),
  );
  assert.equal(reduceEvents(events).status, "completed");
  await assert.rejects(
    () =>
      collectEvents(
        new Agentdock(graph).stream({ threadId: "stateless", resume: true }),
      ),
    /no native pending/,
  );
  assertNoWrites();
});
