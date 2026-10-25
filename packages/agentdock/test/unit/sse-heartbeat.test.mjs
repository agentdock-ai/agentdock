import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, test, vi } from "vitest";
import { Agentdock, createEventResponse } from "../../src/index.js";
import { EventContext } from "../../src/events/event-context.js";
import { pipeEvents } from "../../src/transports/node/pipe.js";
import { SseReader } from "../../src/transports/sse-reader.js";
import { ABORT_GRACE_MS } from "../../src/transports/sse.js";

const run = { threadId: "heartbeat", input: {} };
afterEach(() => vi.useRealTimers());

function silentSource() {
  const context = new EventContext("heartbeat", 0);
  let finish;
  let calls = 0;
  let returned = 0;
  return {
    get calls() {
      return calls;
    },
    get returned() {
      return returned;
    },
    finish() {
      finish({
        done: false,
        value: context.emit({
          type: "run.completed",
          content: [],
          finishReason: "stop",
        }),
      });
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          calls++;
          if (calls === 1)
            return {
              done: false,
              value: context.emit({ type: "run.started" }),
            };
          if (calls > 2) return { done: true };
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        async return() {
          returned++;
          finish?.({ done: true });
          return { done: true };
        },
      };
    },
  };
}
class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  frames = [];
  writeHead() {
    return this;
  }
  write(frame) {
    this.frames.push(frame);
    return this.blockAt !== this.frames.length;
  }
  end() {
    this.writableEnded = true;
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

test.each([0, 15000])(
  "Node idle heartbeats respect interval %s and stop at completion",
  async (heartbeatMs) => {
    vi.useFakeTimers();
    const source = silentSource();
    const response = new Response();
    const piping = pipeEvents(response, run, () => source, heartbeatMs);
    await vi.advanceTimersByTimeAsync(40000);
    assert.equal(
      response.frames.filter((frame) => frame === ": ping\n\n").length,
      heartbeatMs === 0 ? 0 : 2,
    );
    assert.equal(source.calls, 2);
    source.finish();
    await piping;
    await vi.advanceTimersByTimeAsync(60000);
    assert.equal(response.frames.at(-1).includes("run.completed"), true);
    assert.equal(vi.getTimerCount(), 0);
  },
);

test("Node heartbeat backpressure queues no further pings and close clears the timer", async () => {
  vi.useFakeTimers();
  const source = silentSource();
  const response = new Response();
  response.blockAt = 2;
  const piping = pipeEvents(response, run, () => source);
  await vi.advanceTimersByTimeAsync(45000);
  assert.equal(response.frames.length, 2);
  assert.equal(source.calls, 2);
  response.emit("drain");
  await vi.advanceTimersByTimeAsync(15000);
  assert.equal(response.frames.length, 3);
  response.destroy();
  await piping;
  await vi.advanceTimersByTimeAsync(60000);
  assert.equal(response.frames.length, 3);
  assert.equal(source.returned, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test.each([0, 15000])(
  "Web idle heartbeats keep one source read pending (interval %s)",
  async (heartbeatMs) => {
    vi.useFakeTimers();
    const source = silentSource();
    const response = await createEventResponse(() => source, { heartbeatMs });
    const reader = response.body.getReader();
    await reader.read();
    if (heartbeatMs) {
      for (let i = 0; i < 2; i++) {
        const read = reader.read();
        await vi.advanceTimersByTimeAsync(15000);
        assert.equal(
          new TextDecoder().decode((await read).value),
          ": ping\n\n",
        );
        assert.equal(source.calls, 2);
      }
    }
    const read = reader.read();
    await vi.advanceTimersByTimeAsync(heartbeatMs ? 10000 : 40000);
    source.finish();
    assert.match(new TextDecoder().decode((await read).value), /run.completed/);
    assert.equal((await reader.read()).done, true);
    await vi.advanceTimersByTimeAsync(60000);
    assert.equal(vi.getTimerCount(), 0);
  },
);

test("Web cancellation releases a pending heartbeat pull", async () => {
  vi.useFakeTimers();
  const source = silentSource();
  const response = await createEventResponse(() => source);
  const reader = response.body.getReader();
  await reader.read();
  const read = reader.read();
  await vi.advanceTimersByTimeAsync(0);
  await reader.cancel();
  assert.equal((await read).done, true);
  assert.equal(source.returned, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test.each([-1, 0.5, Infinity, NaN])(
  "heartbeat options reject invalid interval %s",
  async (heartbeatMs) => {
    assert.throws(() => new Agentdock({}, { heartbeatMs }), /heartbeatMs/);
    await assert.rejects(
      createEventResponse(() => silentSource(), { heartbeatMs }),
      /heartbeatMs/,
    );
  },
);

test("an aborted SSE reader does not advance its source", async () => {
  const source = silentSource();
  const reader = new SseReader(
    source[Symbol.asyncIterator](),
    0,
    AbortSignal.abort(),
  );
  assert.equal((await reader.next()).done, true);
  assert.equal(source.calls, 0);
  reader.dispose();
});

test.each([0, 60000])(
  "stalled Node readers respect drain timeout %s",
  async (drainTimeoutMs) => {
    vi.useFakeTimers();
    const source = silentSource();
    const response = new Response();
    response.blockAt = 1;
    let error;
    let event;
    const piping = pipeEvents(response, run, () => source, 15000, {
      drainTimeoutMs,
      onStall(cause, current) {
        error = cause;
        event = current;
      },
    });
    await vi.advanceTimersByTimeAsync(60001);
    if (!drainTimeoutMs) {
      assert.equal(response.destroyed, false);
      response.destroy();
    }
    await piping;
    assert.equal(response.destroyed, true);
    assert.equal(source.returned, 1);
    assert.equal(response.listenerCount("drain"), 0);
    assert.equal(vi.getTimerCount(), 0);
    if (drainTimeoutMs) {
      assert.equal(error.message, "Client stopped reading.");
      assert.equal(event.type, "run.started");
    }
  },
);

test("drain clears the stall deadline and diagnostics cannot block cleanup", async () => {
  vi.useFakeTimers();
  const source = silentSource();
  const response = new Response();
  response.blockAt = 1;
  const piping = pipeEvents(response, run, () => source, 0, {
    drainTimeoutMs: 100,
  });
  await vi.advanceTimersByTimeAsync(50);
  response.emit("drain");
  await vi.advanceTimersByTimeAsync(100);
  assert.equal(response.destroyed, false);
  source.finish();
  await piping;
  assert.equal(vi.getTimerCount(), 0);
  const second = new Response();
  second.blockAt = 1;
  const stalled = pipeEvents(second, run, () => silentSource(), 0, {
    drainTimeoutMs: 10,
    onStall() {
      throw new Error("logger");
    },
  });
  await vi.advanceTimersByTimeAsync(10);
  await stalled;
  assert.equal(second.destroyed, true);
});

test("Agentdock reports the client_stalled diagnostic and validates the drain deadline", async () => {
  vi.useFakeTimers();
  const graph = {
    async getState() {
      return { values: {} };
    },
    async *stream() {},
  };
  assert.throws(
    () => new Agentdock(graph, { drainTimeoutMs: -1 }),
    /drainTimeoutMs/,
  );
  const observed = [];
  const runtime = new Agentdock(graph, {
    drainTimeoutMs: 100,
    onError(error, details) {
      observed.push({ error, details });
    },
  });
  const response = new Response();
  response.blockAt = 1;
  const piping = runtime.pipe(response, run);
  await vi.advanceTimersByTimeAsync(100);
  await piping;
  assert.equal(observed[0].details.code, "client_stalled");
  assert.equal(observed[0].details.stage, "transport");
});

test("heartbeats sustain three minutes of silence with a single graph read", async () => {
  vi.useFakeTimers();
  const source = silentSource();
  const response = new Response();
  const piping = pipeEvents(response, run, () => source);
  await vi.advanceTimersByTimeAsync(180000);
  assert.equal(source.calls, 2);
  assert.equal(
    response.frames.filter((frame) => frame === ": ping\n\n").length,
    12,
  );
  source.finish();
  await piping;
});

test("Web terminal events close the source without additional pulls or heartbeats", async () => {
  vi.useFakeTimers();
  const source = silentSource();
  const response = await createEventResponse(() => source, {
    isTerminal: (event) => event.type === "run.completed",
  });
  const reader = response.body.getReader();
  await reader.read();
  const final = reader.read();
  await vi.advanceTimersByTimeAsync(0);
  source.finish();
  await final;
  assert.equal((await reader.read()).done, true);
  await vi.advanceTimersByTimeAsync(60000);
  assert.equal(source.calls, 2);
  assert.equal(source.returned, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("aborting an unread Web response returns a source that ignores abort after the grace period", async () => {
  vi.useFakeTimers();
  const source = silentSource();
  const controller = new AbortController();
  const response = await createEventResponse(() => source, {
    signal: controller.signal,
  });
  controller.abort();
  await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS - 1);
  assert.equal(source.returned, 0);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(source.returned, 1);
  const reader = response.body.getReader();
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /run.started/,
  );
  assert.equal((await reader.read()).done, true);
  assert.equal(vi.getTimerCount(), 0);
});

test("a late source rejection racing Web cancellation is contained", async () => {
  let reject;
  let calls = 0;
  const context = new EventContext("late", 0);
  const response = await createEventResponse(() => ({
    [Symbol.asyncIterator]() {
      return {
        next() {
          return calls++ === 0
            ? Promise.resolve({
                done: false,
                value: context.emit({ type: "run.started" }),
              })
            : new Promise((_, fail) => {
                reject = fail;
              });
        },
        async return() {
          return { done: true };
        },
      };
    },
  }));
  const reader = response.body.getReader();
  await reader.read();
  const pending = reader.read();
  await new Promise((resolve) => setImmediate(resolve));
  reject(new Error("late rejection"));
  await reader.cancel();
  assert.equal((await pending).done, true);
});

test("a heartbeat that stalls is destroyed without a diagnostic observer", async () => {
  vi.useFakeTimers();
  const response = new Response();
  response.blockAt = 2;
  const piping = pipeEvents(response, run, () => silentSource(), 10, {
    drainTimeoutMs: 20,
  });
  await vi.advanceTimersByTimeAsync(30);
  await piping;
  assert.equal(response.destroyed, true);
});

test.each(["writableEnded", "destroyed"])(
  "Node stops writing when %s changes during a source read",
  async (property) => {
    vi.useFakeTimers();
    const source = silentSource();
    const response = new Response();
    const piping = pipeEvents(response, run, () => source, 0);
    await vi.advanceTimersByTimeAsync(0);
    response[property] = true;
    source.finish();
    await piping;
    assert.equal(response.frames.length, 1);
    assert.equal(source.returned, 1);
  },
);

test("a Web source ignores no cleanup when the request was already aborted", async () => {
  vi.useFakeTimers();
  const source = silentSource();
  const response = await createEventResponse(() => source, {
    signal: AbortSignal.abort(),
  });
  await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS);
  assert.equal(source.returned, 1);
  const body = await response.text();
  assert.match(body, /run.started/);
  assert.equal(vi.getTimerCount(), 0);
});

test("an aborted Node pipe closes a source that ignores abort after the grace period", async () => {
  vi.useFakeTimers();
  const source = silentSource();
  const controller = new AbortController();
  const response = new Response();
  const piping = pipeEvents(
    response,
    { ...run, signal: controller.signal },
    () => source,
    0,
  );
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS - 1);
  assert.equal(source.returned, 0);
  await vi.advanceTimersByTimeAsync(1);
  await piping;
  assert.equal(source.returned, 1);
  assert.equal(response.writableEnded, true);
  assert.equal(vi.getTimerCount(), 0);
});

test("an abort racing terminal detection keeps the Web response closed", async () => {
  const source = silentSource();
  const controller = new AbortController();
  const response = await createEventResponse(() => source, {
    signal: controller.signal,
    isTerminal() {
      controller.abort();
      throw new Error("Aborted terminal detection");
    },
  });
  const body = await response.text();
  assert.match(body, /run.started/);
  assert.equal(source.returned, 1);
});

function abortAwareSource({ rejectOnAbort = false } = {}) {
  const context = new EventContext("abort-aware", 0);
  let calls = 0;
  let returned = 0;
  let rejectPending;
  return {
    get returned() {
      return returned;
    },
    rejectPending: (error) => rejectPending?.(error),
    source(signal) {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              calls++;
              if (calls === 1)
                return {
                  done: false,
                  value: context.emit({ type: "run.started" }),
                };
              if (calls > 2) return { done: true };
              return new Promise((resolve, reject) => {
                rejectPending = reject;
                const settle = () =>
                  rejectOnAbort
                    ? reject(new Error("aborted"))
                    : resolve({
                        done: false,
                        value: context.emit({
                          type: "run.cancelled",
                          recoverable: false,
                        }),
                      });
                // Like the core, a cooperative source honours an earlier abort.
                if (signal.aborted) settle();
                else signal.addEventListener("abort", settle, { once: true });
              });
            },
            async return() {
              returned++;
              return { done: true };
            },
          };
        },
      };
    },
  };
}

test("a Web source that rejects once aborted ends the response cleanly", async () => {
  const source = abortAwareSource({ rejectOnAbort: true });
  const controller = new AbortController();
  const response = await createEventResponse(source.source, {
    signal: controller.signal,
    heartbeatMs: 0,
  });
  const body = response.text();
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  const text = await body;
  assert.match(text, /run.started/);
  assert.doesNotMatch(text, /run.failed/);
  assert.equal(source.returned, 1);
});

test("a source rejection after the reader cancelled is contained", async () => {
  const source = abortAwareSource();
  const response = await createEventResponse(source.source, { heartbeatMs: 0 });
  const reader = response.body.getReader();
  await reader.read();
  const pending = reader.read();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await reader.cancel("gone");
  source.rejectPending(new Error("late"));
  assert.equal((await pending).done, true);
  assert.equal(source.returned, 1);
});

test("a reader that pulls while an aborted Web response drains still gets the terminal event", async () => {
  const source = abortAwareSource();
  const controller = new AbortController();
  const response = await createEventResponse(source.source, {
    signal: controller.signal,
    heartbeatMs: 0,
    isTerminal: (event) => event.type === "run.cancelled",
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /run.started/);
  controller.abort();
  assert.match(decoder.decode((await reader.read()).value), /run.cancelled/);
  assert.equal((await reader.read()).done, true);
});

test("a pre-aborted Node pipe still delivers the source's terminal event", async () => {
  const source = abortAwareSource();
  const response = new Response();
  const signal = AbortSignal.abort();
  await pipeEvents(
    response,
    { ...run, signal },
    (current) => source.source(current.signal),
    0,
  );
  assert.deepEqual(
    response.frames.map((frame) => JSON.parse(frame.slice(6)).type),
    ["run.started", "run.cancelled"],
  );
});
