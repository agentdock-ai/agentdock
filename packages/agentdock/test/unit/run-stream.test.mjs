import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentEventType } from "@agentdock-ai/contracts";
import { RunStream } from "../../src/serving/run-stream.js";

const RECURSION_LIMIT = 25;

test("persists checkpoint event state before yielding an interrupt", async () => {
  const graph = createGraph({
    chunks: [
      [
        "updates",
        {
          __interrupt__: [{ id: "approval-1", value: { prompt: "Approve?" } }],
        },
      ],
    ],
  });
  let persistedBeforeInterrupt = false;
  graph.onUpdate = () => {
    persistedBeforeInterrupt = true;
  };
  const stream = new RunStream(graph, { recursionLimit: RECURSION_LIMIT });

  for await (const event of stream.stream({
    input: {},
    threadId: "interrupt",
  })) {
    if (event.type === AgentEventType.InterruptRequired) {
      assert.equal(persistedBeforeInterrupt, true);
      assert.deepEqual(graph.values.agentEventState, {
        runId: event.runId,
        logicalSequence: event.logicalSequence,
        pendingInterrupt: event.interrupt,
      });
    }
  }

  assert.equal(persistedBeforeInterrupt, true);
});

test("rejects resume without saved event state before starting the graph", async () => {
  const graph = createGraph();
  const iterator = new RunStream(graph, { recursionLimit: RECURSION_LIMIT })
    .stream({ threadId: "missing-checkpoint", resume: { decisions: [] } })
    [Symbol.asyncIterator]();

  await assert.rejects(
    iterator.next(),
    /must use withAgentEventState and have a valid pending interrupt/,
  );
  assert.equal(graph.streamCalls.length, 0);
});

test("rejects a corrupt saved interrupt before starting the graph", async () => {
  const graph = createGraph({
    values: {
      agentEventState: {
        runId: "saved-run",
        logicalSequence: 4,
        pendingInterrupt: {
          kind: "custom",
          interruptId: "approval-1",
          prompt: "Continue?",
          actions: undefined,
        },
      },
    },
  });
  const iterator = new RunStream(graph, { recursionLimit: RECURSION_LIMIT })
    .stream({ threadId: "corrupt-checkpoint", resume: { decisions: [] } })
    [Symbol.asyncIterator]();

  await assert.rejects(iterator.next(), /pending interrupt/);
  assert.equal(graph.streamCalls.length, 0);
});

test("read-back verification rejects a checkpoint that drops interrupt data", async () => {
  const graph = createGraph({
    chunks: [
      [
        "updates",
        {
          __interrupt__: [{ id: "approval-1", value: { prompt: "Approve?" } }],
        },
      ],
    ],
  });
  graph.updateState = async (_config, update) => {
    const persistedState = structuredClone(update.agentEventState);
    if (persistedState.pendingInterrupt) {
      persistedState.pendingInterrupt.prompt = "Wrong prompt";
    }
    graph.values = { ...graph.values, agentEventState: persistedState };
  };

  const events = await collect(
    new RunStream(graph, { recursionLimit: RECURSION_LIMIT }).stream({
      input: {},
      threadId: "bad-read-back",
    }),
  );

  assert.equal(events.at(-1).type, AgentEventType.RunFailed);
  assert.equal(
    events.some((event) => event.type === AgentEventType.InterruptRequired),
    false,
  );
});

test("resume restores run identity and advances the saved logical sequence", async () => {
  const graph = createGraph({
    values: {
      agentEventState: {
        runId: "saved-run",
        logicalSequence: 8,
        pendingInterrupt: {
          kind: "custom",
          interruptId: "approval-2",
          prompt: "Approve?",
          actions: [],
        },
      },
    },
  });
  const events = await collect(
    new RunStream(graph, { recursionLimit: RECURSION_LIMIT }).stream({
      threadId: "resume-thread",
      resume: { decisions: [{ type: "approve" }] },
    }),
  );

  assert.deepEqual(
    events.map(({ type, logicalSequence }) => ({ type, logicalSequence })),
    [
      { type: AgentEventType.RunStarted, logicalSequence: 9 },
      { type: AgentEventType.InterruptResolved, logicalSequence: 10 },
      { type: AgentEventType.RunCompleted, logicalSequence: 11 },
    ],
  );
  assert.ok(events.every((event) => event.runId === "saved-run"));
  assert.deepEqual(graph.values.agentEventState, {
    runId: "saved-run",
    logicalSequence: 11,
  });
});

test("emits exactly one terminal event for completion, failure, and cancellation", async () => {
  const cases = [
    {
      name: "completion",
      graph: createGraph(),
      run: { input: {}, threadId: "completed" },
      expected: AgentEventType.RunCompleted,
    },
    {
      name: "failure",
      graph: createGraph({ error: new Error("private graph error") }),
      run: { input: {}, threadId: "failed" },
      expected: AgentEventType.RunFailed,
    },
    {
      name: "cancellation",
      graph: createGraph(),
      run: cancelledRun("cancelled"),
      expected: AgentEventType.RunCancelled,
    },
  ];

  for (const scenario of cases) {
    const events = await collect(
      new RunStream(scenario.graph, { recursionLimit: RECURSION_LIMIT }).stream(
        scenario.run,
      ),
    );
    const terminalEvents = events.filter((event) =>
      [
        AgentEventType.RunCompleted,
        AgentEventType.RunFailed,
        AgentEventType.RunCancelled,
      ].includes(event.type),
    );

    assert.deepEqual(
      terminalEvents.map((event) => event.type),
      [scenario.expected],
      scenario.name,
    );
  }
});

test("concurrent runs keep event identity and message state isolated", async () => {
  const graph = createGraph({
    streamChunks: (input) => [
      [
        "messages",
        [{ id: `message-${input.marker}`, content: input.marker }, {}],
      ],
    ],
  });
  const stream = new RunStream(graph, { recursionLimit: RECURSION_LIMIT });
  const [first, second] = await Promise.all([
    collect(stream.stream({ input: { marker: "first" }, threadId: "first" })),
    collect(stream.stream({ input: { marker: "second" }, threadId: "second" })),
  ]);

  assert.notEqual(first[0].runId, second[0].runId);
  assert.ok(first.every((event) => event.runId === first[0].runId));
  assert.ok(second.every((event) => event.runId === second[0].runId));
  assert.ok(first.some((event) => event.messageId === "message-first"));
  assert.ok(second.some((event) => event.messageId === "message-second"));
  assert.ok(first.every((event) => event.messageId !== "message-second"));
  assert.ok(second.every((event) => event.messageId !== "message-first"));
});

function createGraph({ chunks = [], streamChunks, values = {}, error } = {}) {
  return {
    values,
    streamCalls: [],
    async stream(input, options) {
      this.streamCalls.push({ input, options });
      if (error) throw error;
      const currentChunks = streamChunks ? streamChunks(input) : chunks;
      return (async function* () {
        for (const chunk of currentChunks) yield chunk;
      })();
    },
    async getState() {
      return { values: this.values };
    },
    async updateState(_config, update) {
      this.onUpdate?.(update);
      this.values = { ...this.values, ...update };
    },
  };
}

function cancelledRun(threadId) {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  return { input: {}, threadId, signal: controller.signal };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}
