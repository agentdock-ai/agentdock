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
