import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { AgentEventType } from "@agentdock-ai/contracts";
import { EventContext } from "../../src/events/event-context.js";
import { pipeEvents } from "../../src/transports/node/pipe.js";
import { createSseResponse } from "../../src/transports/web/to-response.js";

test("Node source errors before headers propagate and clean up", async () => {
  const response = new FakeResponse();
  let streamSignal;
  const source = (run) => {
    streamSignal = run.signal;
    return (async function* () {
      throw new Error("resume lookup failed");
    })();
  };

  await assert.rejects(
    pipeEvents(response, createRun("node-before-headers"), source),
    /resume lookup failed/,
  );

  assert.equal(response.status, undefined);
  assert.equal(response.endCount, 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(streamSignal.aborted, true);
});

test("Node transport skips a response that is already destroyed", async () => {
  const response = new FakeResponse();
  response.destroyed = true;
  let streamSignal;
  const source = (run) => {
    streamSignal = run.signal;
    return (async function* () {
      yield makeEvent(AgentEventType.RunStarted);
    })();
  };

  await pipeEvents(response, createRun("node-already-destroyed"), source);

  assert.equal(response.status, undefined);
  assert.equal(response.frames.length, 0);
  assert.equal(response.endCount, 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(streamSignal.aborted, true);
});

test("Node transport stops after the first terminal event", async () => {
  const response = new FakeResponse();
  const source = () =>
    (async function* () {
      yield makeEvent(AgentEventType.RunStarted);
      yield makeEvent(AgentEventType.RunCompleted);
      yield makeEvent(AgentEventType.RunFailed);
    })();

  await pipeEvents(response, createRun("node-terminal"), source);

  assert.deepEqual(
    response.frames.map((frame) => JSON.parse(frame.slice(6)).type),
    [AgentEventType.RunStarted, AgentEventType.RunCompleted],
  );
  assert.equal(response.endCount, 1);
});

test("Web response closes an empty source without pulling a completed iterator twice", async () => {
  let nextCalls = 0;
  const response = await createSseResponse(createRun("web-empty"), () => ({
    [Symbol.asyncIterator]() {
      return {
        async next() {
          nextCalls += 1;
          return { done: true, value: undefined };
        },
      };
    },
  }));

  const result = await response.body.getReader().read();
  assert.equal(result.done, true);
  assert.equal(nextCalls, 1);
});

test("Web source errors abort the source and return its iterator", async () => {
  let signal;
  let returnCalls = 0;
  const response = await createSseResponse(
    createRun("web-error-cleanup"),
    (run) => {
      signal = run.signal;
      let nextCalls = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCalls += 1;
              if (nextCalls === 1) {
                return {
                  done: false,
                  value: makeEvent(AgentEventType.RunStarted),
                };
              }
              throw new Error("source failed");
            },
            async return() {
              returnCalls += 1;
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  );

  const reader = response.body.getReader();
  await reader.read();
  await assert.rejects(reader.read(), /source failed/);

  assert.equal(signal.aborted, true);
  assert.equal(returnCalls, 1);
});

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  frames = [];
  endCount = 0;

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(frame) {
    this.frames.push(frame);
    return true;
  }

  end() {
    this.endCount += 1;
    this.writableEnded = true;
  }
}

function createRun(threadId) {
  return { input: {}, threadId };
}

function makeEvent(type) {
  const context = new EventContext("transport-run", 0);
  if (type === AgentEventType.RunCompleted) {
    return context.emit({
      type,
      finishReason: "stop",
      content: [],
    });
  }
  if (type === AgentEventType.RunFailed) {
    return context.emit({
      type,
      code: "graph_error",
      message: "Agent execution failed.",
    });
  }
  return context.emit({ type });
}

test.each(["node", "web"])(
  "%s source construction failures detach parent cancellation",
  async (transport) => {
    const parent = new AbortController();
    let added = 0;
    let removed = 0;
    const add = parent.signal.addEventListener.bind(parent.signal);
    const remove = parent.signal.removeEventListener.bind(parent.signal);
    parent.signal.addEventListener = (...args) => {
      added++;
      add(...args);
    };
    parent.signal.removeEventListener = (...args) => {
      removed++;
      remove(...args);
    };
    const response = new FakeResponse();
    let signal;
    const source = (run) => {
      signal = run.signal;
      throw new Error("construction failed");
    };
    const run = { ...createRun("construct"), signal: parent.signal };
    await assert.rejects(
      transport === "node"
        ? pipeEvents(response, run, source)
        : createSseResponse(run, source),
      /construction failed/,
    );
    assert.equal(added, 1);
    assert.equal(removed, 1);
    assert.equal(signal.aborted, true);
    assert.equal(response.listenerCount("close"), 0);
  },
);

test("Node response end failures still close the source iterator", async () => {
  const response = new FakeResponse();
  response.end = () => {
    throw new Error("end failed");
  };
  let returned = false;
  await assert.rejects(
    pipeEvents(response, createRun("end"), () =>
      (async function* () {
        try {
          yield makeEvent(AgentEventType.RunStarted);
          yield makeEvent(AgentEventType.RunCompleted);
        } finally {
          returned = true;
        }
      })(),
    ),
    /end failed/,
  );
  assert.equal(returned, true);
  assert.equal(response.listenerCount("close"), 0);
});

test.each([false, true])(
  "Web cancellation handles an in-flight read (reject=%s)",
  async (reject) => {
    let finish;
    let readStarted;
    const started = new Promise((resolve) => {
      readStarted = resolve;
    });
    let calls = 0;
    let returned = 0;
    let signal;
    const response = await createSseResponse(createRun("race"), (run) => {
      signal = run.signal;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              calls++;
              if (calls === 1)
                return {
                  done: false,
                  value: makeEvent(AgentEventType.RunStarted),
                };
              return new Promise((resolve, rejectRead) => {
                finish = () =>
                  reject
                    ? rejectRead(new Error("late rejection"))
                    : resolve({
                        done: false,
                        value: makeEvent(AgentEventType.RunStarted),
                      });
                readStarted();
              });
            },
            async return() {
              returned++;
              finish();
              return { done: true };
            },
          };
        },
      };
    });
    const reader = response.body.getReader();
    await reader.read();
    const pending = reader.read();
    await started;
    await reader.cancel("closed");
    assert.equal((await pending).done, true);
    assert.equal(signal.reason, "closed");
    assert.equal(returned, 1);
  },
);

test("Node close after a normal response end does not signal a disconnect", async () => {
  const response = new FakeResponse();
  let signal;
  response.write = (frame) => {
    response.frames.push(frame);
    response.writableEnded = true;
    response.emit("close");
    return true;
  };
  await pipeEvents(response, createRun("ended"), (run) => {
    signal = run.signal;
    return (async function* () {
      yield makeEvent(AgentEventType.RunCompleted);
    })();
  });
  assert.equal(signal.aborted, false);
  assert.equal(response.endCount, 0);
});

test("Node backpressure handles a response destroyed during write", async () => {
  const response = new FakeResponse();
  response.write = () => {
    response.destroyed = true;
    return false;
  };
  await pipeEvents(response, createRun("destroyed-write"), () =>
    (async function* () {
      yield makeEvent(AgentEventType.RunStarted);
    })(),
  );
  assert.equal(response.endCount, 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("drain"), 0);
});

test("Node source failure on an empty stream propagates when no event can frame it", async () => {
  const response = new FakeResponse();
  let calls = 0;
  // Failure to commit headers cannot be framed as a stream event.
  response.writeHead = () => {
    throw new Error("headers failed");
  };
  await assert.rejects(
    pipeEvents(response, createRun("headers"), () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: true };
          },
          async return() {
            calls++;
            return { done: true };
          },
        };
      },
    })),
    /headers failed/,
  );
  assert.equal(calls, 1);
  assert.equal(response.listenerCount("close"), 0);
});

test("Node closes an empty source without pulling a completed iterator twice", async () => {
  const response = new FakeResponse();
  let calls = 0;
  await pipeEvents(response, createRun("empty"), () => ({
    [Symbol.asyncIterator]() {
      return {
        async next() {
          calls++;
          return { done: true };
        },
      };
    },
  }));
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.equal(response.endCount, 1);
});

test("a first Node write failure propagates and returns the source", async () => {
  const response = new FakeResponse();
  response.write = () => {
    throw new Error("first write failed");
  };
  let returned = false;
  await assert.rejects(
    pipeEvents(response, createRun("first-write"), () =>
      (async function* () {
        try {
          yield makeEvent(AgentEventType.RunStarted);
        } finally {
          returned = true;
        }
      })(),
    ),
    /first write failed/,
  );
  assert.equal(returned, true);
  assert.equal(response.endCount, 1);
});
