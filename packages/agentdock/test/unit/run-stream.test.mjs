import assert from "node:assert/strict";
import { test } from "vitest";
import { RunStream } from "../../src/serving/run-stream.js";

function graph({
  chunks = [],
  error,
  snapshot = { values: {}, next: [], tasks: [] },
} = {}) {
  return {
    calls: [],
    writes: 0,
    async stream(input, options) {
      this.calls.push({ input, options });
      if (error) throw error;
      return (async function* () {
        yield* chunks;
      })();
    },
    async getState() {
      return snapshot;
    },
    async updateState() {
      this.writes++;
      throw new Error("Serving must not write state");
    },
  };
}
const runtime = (current, options = {}) =>
  new RunStream(current, { recursionLimit: 25, ...options });
async function collect(source) {
  const result = [];
  for await (const event of source) result.push(event);
  return result;
}

test("serves interruptions without writing any graph checkpoints", async () => {
  const interruption = { id: "approval", value: { prompt: "Approve?" } };
  const current = graph({
    chunks: [["updates", { __interrupt__: [interruption] }]],
    snapshot: {
      values: {},
      next: ["ask"],
      tasks: [{ name: "ask", interrupts: [interruption] }],
    },
  });
  const events = await collect(
    runtime(current).stream({ threadId: "t", input: {} }),
  );
  assert.equal(events.at(-1).type, "interrupt.required");
  assert.equal(events.at(-1).interrupt.interruptId, "approval");
  assert.equal(current.writes, 0);
});

test("rejects resume without native pending work before invoking the graph", async () => {
  const current = graph();
  await assert.rejects(
    () => collect(runtime(current).stream({ threadId: "t", resume: true })),
    /native pending/,
  );
  assert.equal(current.calls.length, 0);
});

test("rejects malformed native checkpoint interruption before graph execution", async () => {
  const current = graph({
    snapshot: { values: {}, tasks: [{ interrupts: [{ value: "no ID" }] }] },
  });
  await assert.rejects(
    () => collect(runtime(current).stream({ threadId: "t", resume: true })),
    /invalid native interrupt/,
  );
  assert.equal(current.calls.length, 0);
});

test("independent invocations forward graph input without adding state fields", async () => {
  const current = graph();
  const stream = runtime(current);
  for (const input of [{ marker: "x" }, "text", [1, 2], null]) {
    const events = await collect(stream.stream({ threadId: "t", input }));
    assert.equal(current.calls.at(-1).input, input);
    assert.equal(events.at(-1).type, "run.completed");
    assert.equal(events[0].logicalSequence, 1);
  }
  assert.equal(current.writes, 0);
});

test("completion, graph errors, and cancellation emit exactly one terminal event", async () => {
  const cases = [
    [graph(), { input: {}, threadId: "complete" }, "run.completed"],
    [
      graph({ error: new Error("private secret") }),
      { input: {}, threadId: "failed" },
      "run.failed",
    ],
    [
      graph(),
      { input: {}, threadId: "cancel", signal: AbortSignal.abort() },
      "run.cancelled",
    ],
  ];
  for (const [current, run, expected] of cases) {
    const events = await collect(runtime(current).stream(run));
    assert.deepEqual(
      events
        .filter((event) =>
          ["run.completed", "run.failed", "run.cancelled"].includes(event.type),
        )
        .map((event) => event.type),
      [expected],
    );
    assert.equal(JSON.stringify(events).includes("private secret"), false);
    assert.equal(current.writes, 0);
  }
});

test("reports original causes server-side and isolates a throwing observer", async () => {
  const error = new Error("private secret");
  const observed = [];
  const events = await collect(
    runtime(graph({ error }), {
      onError(cause, details) {
        observed.push({ cause, details });
        throw new Error("logging failed");
      },
    }).stream({ threadId: "t", input: {} }),
  );
  assert.equal(observed[0].cause, error);
  assert.equal(observed[0].details.stage, "graph");
  assert.equal(observed[0].details.runId, events[0].runId);
  assert.equal(events.at(-1).type, "run.failed");
  assert.equal(events.at(-1).code, "graph_error");
});

test.each([
  ["encoding", "text/event-stream"],
  ["encoding", undefined],
])("rejects serving-owned config %s before starting", async (key, value) => {
  const current = graph();
  await assert.rejects(
    () =>
      collect(
        runtime(current).stream({
          threadId: "t",
          input: {},
          config: { [key]: value },
        }),
      ),
    /encoding/,
  );
  assert.equal(current.calls.length, 0);
});

test.each([
  { threadId: "t" },
  { threadId: "t", input: {}, resume: true },
  { threadId: "t", continue: false },
  { threadId: "t", input: {}, continue: true },
  { threadId: "t", input: {}, signal: {} },
])("rejects malformed runs: %j", async (run) => {
  await assert.rejects(() => collect(runtime(graph()).stream(run)));
});

test("mapper failures abort cooperative work and retain the original diagnostic", async () => {
  const current = graph({ chunks: [["unsupported", {}]] });
  const observed = [];
  const events = await collect(
    runtime(current, {
      onError(error, details) {
        observed.push({ error, details });
      },
    }).stream({ threadId: "t", input: {} }),
  );
  assert.equal(events.at(-1).code, "mapper_error");
  assert.equal(current.calls[0].options.signal.aborted, true);
  assert.equal(observed[0].details.stage, "mapper");
});

test("one runtime isolates concurrent invocation IDs and messages", async () => {
  const current = graph();
  current.stream = async (input) =>
    (async function* () {
      yield ["messages", [{ id: input.marker, content: input.marker }, {}]];
    })();
  const stream = runtime(current);
  const results = await Promise.all(
    ["first", "second"].map((marker) =>
      collect(stream.stream({ input: { marker }, threadId: marker })),
    ),
  );
  assert.notEqual(results[0][0].runId, results[1][0].runId);
  for (const [index, events] of results.entries()) {
    assert.equal(events.at(-1).type, "run.completed");
    assert.equal(
      events.find((event) => event.type === "message.part.delta").part.text,
      ["first", "second"][index],
    );
  }
});

test("rejects static continuation while a dynamic interrupt is waiting", async () => {
  const current = graph({
    snapshot: {
      values: {},
      next: ["ask"],
      tasks: [{ name: "ask", interrupts: [{ id: "i", value: "Choose" }] }],
    },
  });
  await assert.rejects(
    () => collect(runtime(current).stream({ threadId: "t", continue: true })),
    /require a resume/,
  );
  assert.equal(current.calls.length, 0);
});

test("a continuation leaving the same interrupts pending ends in waiting state", async () => {
  const raw = { id: "i", value: "Choose" };
  const current = graph({
    chunks: [["updates", { __interrupt__: [raw] }]],
    snapshot: {
      values: {},
      next: ["ask"],
      tasks: [{ name: "ask", interrupts: [raw] }],
    },
  });
  const events = await collect(
    runtime(current).stream({ threadId: "t", resume: { other: true } }),
  );
  assert.equal(events.at(-1).type, "run.paused");
  assert.equal(
    events.some((event) => event.type === "interrupt.resolved"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "interrupt.required"),
    false,
  );
});

test("checkpoint failures preserve original diagnostics and emit a sanitized terminal event", async () => {
  const raw = { id: "i", value: "Choose" };
  const current = graph({ chunks: [["updates", { __interrupt__: [raw] }]] });
  const error = new Error("private checkpoint failure");
  current.getState = async () => {
    throw error;
  };
  const observed = [];
  const events = await collect(
    runtime(current, {
      onError(cause, details) {
        observed.push({ cause, details });
      },
    }).stream({ threadId: "t", input: {} }),
  );
  assert.equal(events.at(-1).code, "checkpoint_error");
  assert.equal(observed[0].cause, error);
  assert.equal(observed[0].details.stage, "checkpoint");
  assert.equal(JSON.stringify(events).includes(error.message), false);
});

test("a completed native continuation is not advertised as recoverable after mapper failure", async () => {
  const raw = { id: "i", value: "Choose" };
  const current = graph({ chunks: [["messages", null]] });
  let reads = 0;
  current.getState = async () =>
    ++reads === 1
      ? {
          values: {},
          next: ["ask"],
          tasks: [{ name: "ask", interrupts: [raw] }],
        }
      : { values: {}, next: [], tasks: [] };
  const events = await collect(
    runtime(current).stream({ threadId: "t", resume: true }),
  );
  assert.equal(events.at(-1).recoverable, false);
});

test("consumer return aborts unfinished graph work and closes its iterator", async () => {
  const current = graph();
  let returned = false;
  current.stream = async (_input, options) => {
    current.options = options;
    return (async function* () {
      try {
        yield ["messages", [{ id: "m", content: "one" }, {}]];
        yield ["messages", [{ id: "m", content: "two" }, {}]];
      } finally {
        returned = true;
      }
    })();
  };
  const source = runtime(current).stream({ threadId: "t", input: {} });
  await source.next();
  await source.next();
  await source.return();
  assert.equal(current.options.signal.aborted, true);
  assert.equal(returned, true);
});

test("application preflight validation receives current context and runs before graph execution", async () => {
  const current = graph({
    snapshot: {
      values: {},
      tasks: [{ interrupts: [{ id: "i", value: "Choose" }] }],
    },
  });
  const context = { policy: "current" };
  const calls = [];
  const source = runtime(current, {
    async validateResume(value, pending, receivedContext) {
      calls.push({ value, pending, receivedContext });
      throw new Error("Application rejected response");
    },
  });
  await assert.rejects(
    () => collect(source.stream({ threadId: "t", resume: true, context })),
    /Application rejected/,
  );
  assert.equal(current.calls.length, 0);
  assert.equal(calls[0].receivedContext, context);
  assert.equal(calls[0].pending[0].interruptId, "i");
});
test("opaque resume is not inspected without an application validator", async () => {
  const current = graph({
    snapshot: {
      values: {},
      tasks: [{ interrupts: [{ id: "i", value: "Choose" }] }],
    },
  });
  const events = await collect(
    runtime(current).stream({
      threadId: "t",
      resume: { decision: "application-defined" },
    }),
  );
  assert.deepEqual(current.calls[0].input.resume, {
    decision: "application-defined",
  });
  assert.equal(events.at(-1).type, "run.completed");
});
