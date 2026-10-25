import assert from "node:assert/strict";
import { test } from "vitest";
import { Agentdock, ThreadBusyError } from "../../src/index.js";
const graph = () => ({
  async getState() {
    return { values: {} };
  },
  async *stream() {},
});
const run = { threadId: "same", input: {} };
async function collect(source) {
  const result = [];
  for await (const event of source) result.push(event);
  return result;
}

test("runtimes sharing a graph reject a second run before a Web response", async () => {
  const current = graph();
  const first = new Agentdock(current).stream(run)[Symbol.asyncIterator]();
  await first.next();
  await assert.rejects(new Agentdock(current).toResponse(run), ThreadBusyError);
  await first.return();
  assert.equal(
    (await collect(new Agentdock(current).stream(run))).at(-1).type,
    "run.completed",
  );
});
test("runtimes sharing a saver share the default lock", async () => {
  const saver = {};
  const a = new Agentdock({ ...graph(), checkpointer: saver });
  const b = new Agentdock({ ...graph(), checkpointer: saver });
  const iterator = a.stream(run)[Symbol.asyncIterator]();
  await iterator.next();
  await assert.rejects(b.toResponse(run), ThreadBusyError);
  await iterator.return();
});
test.each(["complete", "error", "cancel", "preflight"])(
  "releases its lease after %s",
  async (outcome) => {
    const current = graph();
    if (outcome === "error")
      current.stream = async () => {
        throw new Error("fail");
      };
    const runtime = new Agentdock(current);
    const invocation =
      outcome === "preflight"
        ? { threadId: "same", resume: true }
        : {
            ...run,
            signal: outcome === "cancel" ? AbortSignal.abort() : undefined,
          };
    if (outcome === "preflight")
      await assert.rejects(collect(runtime.stream(invocation)), /no native/);
    else await collect(runtime.stream(invocation));
    current.stream = async function* () {};
    assert.equal(
      (await collect(runtime.stream(run))).at(-1).type,
      "run.completed",
    );
  },
);
test("Web reader cancellation releases the thread", async () => {
  const runtime = new Agentdock(graph());
  const response = await runtime.toResponse(run);
  await response.body.cancel();
  await collect(runtime.stream(run));
});
test("hosts can disable locking or provide an asynchronous lease", async () => {
  const current = graph();
  const unlocked = new Agentdock(current, { threadLock: "none" });
  await Promise.all([
    collect(unlocked.stream(run)),
    collect(unlocked.stream(run)),
  ]);
  let released = 0;
  const runtime = new Agentdock(current, {
    threadLock: {
      async acquire(id) {
        assert.equal(id, "same");
        return async () => {
          released++;
        };
      },
    },
  });
  await collect(runtime.stream(run));
  assert.equal(released, 1);
  assert.throws(
    () => new Agentdock(current, { threadLock: "invalid" }),
    /threadLock/,
  );
});
