import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { test } from "vitest";
import {
  AgentEventType,
  agentEventStateSchema,
  createAgentReducerState,
  reduceAgentEvent,
  serveAgent,
} from "../../src/index.js";
import { EventContext } from "../../src/serving/event-context.js";
import { createSseResponse } from "../../src/serving/to-response.js";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import {
  createScriptedChatModel,
  createScriptedMessageChunks,
  createToolCallArgumentChunks,
  createCooperativeTimeoutTool,
} from "../helpers/stream-fixtures.mjs";

const MESSAGE_CHUNK = [
  "messages",
  [{ id: "assistant-message", content: "hello" }, { langgraph_node: "agent" }],
];

test("Node pipe writes SSE headers and waits for drain before its next event", async () => {
  const graph = createGraph({ chunks: [MESSAGE_CHUNK] });
  const runtime = serveAgent(graph);
  const response = new FakeResponse({ backpressureOnWrite: 1 });
  let nextSettled = false;
  const piping = runtime
    .pipe(response, {
      input: { messages: [{ role: "user", content: "hi" }] },
      threadId: "node-backpressure",
    })
    .then(() => {
      nextSettled = true;
    });

  await waitFor(() => response.frames.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(nextSettled, false);
  assert.equal(response.frames.length, 1);
  assert.equal(
    response.headers["content-type"],
    "text/event-stream; charset=utf-8",
  );
  response.emit("drain");
  await piping;
  assert.equal(response.endCount, 1);
  assert.deepEqual(
    readEvents(response.frames).map((event) => event.type),
    [
      AgentEventType.RunStarted,
      AgentEventType.MessageStarted,
      AgentEventType.MessagePartDelta,
      AgentEventType.MessageCompleted,
      AgentEventType.RunCompleted,
    ],
  );
});

test("a client close while waiting for drain aborts and cleans up", async () => {
  const response = new FakeResponse({ backpressureOnWrite: 1 });
  const piping = serveAgent(createGraph({ chunks: [MESSAGE_CHUNK] })).pipe(
    response,
    {
      input: { messages: [{ role: "user", content: "hi" }] },
      threadId: "node-drain-close-race",
    },
  );

  await waitFor(() => response.frames.length === 1);
  response.destroy();
  await piping;

  assert.equal(response.endCount, 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("drain"), 0);
});

test("pipe interoperates with a real node:http ServerResponse", async ({
  skip,
}) => {
  const runtime = serveAgent(createGraph({ chunks: [MESSAGE_CHUNK] }));
  const server = createServer((request, response) => {
    void runtime.pipe(response, {
      input: { messages: [{ role: "user", content: "hi" }] },
      threadId: "node-http-loopback",
    });
  });
  try {
    await new Promise((resolve, reject) => {
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(0, "127.0.0.1");
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      skip("The environment blocks loopback sockets.");
    }
    throw error;
  }

  try {
    const address = server.address();
    const result = await fetch(`http://127.0.0.1:${address.port}`);
    const body = await result.text();
    assert.equal(result.status, 200);
    assert.match(result.headers.get("content-type"), /text\/event-stream/);
    assert.deepEqual(
      readEvents([body])
        .map((event) => event.type)
        .slice(-1),
      [AgentEventType.RunCompleted],
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a disconnected Node response aborts the graph and cleans up its iterator", async () => {
  const graph = createGraph({ waitForAbort: true });
  const runtime = serveAgent(graph);
  const response = new FakeResponse();
  const piping = runtime.pipe(response, {
    input: { messages: [{ role: "user", content: "hi" }] },
    threadId: "node-disconnect",
  });
  await waitFor(
    () => response.frames.length >= 2 && graph.signals.length === 1,
  );
  response.destroy();
  await piping;
  assert.equal(graph.signals[0].aborted, true);
  assert.equal(graph.cleanupCount, 1);
  assert.equal(response.endCount, 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("Node disconnect aborts a cooperative LangChain tool", async () => {
  const cooperative = createCooperativeAgent();
  const response = new FakeResponse();
  const piping = serveAgent(cooperative.graph).pipe(response, {
    threadId: "node-cooperative-tool",
    input: { messages: [{ role: "user", content: "wait" }] },
  });

  await waitFor(() =>
    response.frames.some((frame) =>
      readEvents([frame]).some(
        (event) => event.type === AgentEventType.ToolCalled,
      ),
    ),
  );
  response.destroy();
  await piping;

  assert.equal(cooperative.aborts, 1);
  assert.equal(response.listenerCount("close"), 0);
});

test("a pre-aborted caller signal becomes a cancelled terminal event", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  const graph = createGraph({ honorAbort: true });
  const events = await collect(
    serveAgent(graph).stream({
      input: { messages: [{ role: "user", content: "hi" }] },
      threadId: "pre-aborted",
      signal: controller.signal,
    }),
  );
  assert.deepEqual(
    events.map((event) => event.type),
    [AgentEventType.RunStarted, AgentEventType.RunCancelled],
  );
  assert.equal(graph.signals[0].aborted, true);
});

test("consumer early return aborts the graph and returns its iterator", async () => {
  const graph = createGraph({ waitForAbort: true });
  const iterator = serveAgent(graph)
    .stream({
      input: { messages: [{ role: "user", content: "hi" }] },
      threadId: "early-return",
    })
    [Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, AgentEventType.RunStarted);
  assert.equal(
    (await iterator.next()).value.type,
    AgentEventType.MessageStarted,
  );
  await iterator.return();
  assert.equal(graph.signals[0].aborted, true);
  assert.equal(graph.cleanupCount, 1);
});

test("graph failures are framed once as a safe terminal event and end once", async () => {
  const runtime = serveAgent(
    createGraph({ error: new Error("database secret") }),
  );
  const response = new FakeResponse();
  await runtime.pipe(response, {
    input: { messages: [{ role: "user", content: "hi" }] },
    threadId: "node-error",
  });
  const events = readEvents(response.frames);
  assert.equal(
    events.filter((event) => event.type === AgentEventType.RunFailed).length,
    1,
  );
  assert.equal(events.at(-1).message, "Agent execution failed.");
  assert.doesNotMatch(JSON.stringify(events), /database secret/);
  assert.equal(response.endCount, 1);
});

test("a transport write failure sends one safe terminal event", async () => {
  const runtime = serveAgent(createGraph({ chunks: [MESSAGE_CHUNK] }));
  const response = new FakeResponse();
  const write = response.write.bind(response);
  let writes = 0;
  response.write = (frame) => {
    writes += 1;
    if (writes === 2) throw new Error("private socket details");
    return write(frame);
  };

  await runtime.pipe(response, {
    input: { messages: [{ role: "user", content: "hi" }] },
    threadId: "transport-write-failure",
  });

  const events = readEvents(response.frames);
  assert.deepEqual(
    events.map((event) => event.type),
    [AgentEventType.RunStarted, AgentEventType.RunFailed],
  );
  assert.equal(events[1].code, "transport_error");
  assert.doesNotMatch(JSON.stringify(events), /private socket details/);
  assert.equal(response.endCount, 1);
});

test("invalid runs fail before committing a Node or Web response", async () => {
  const runtime = serveAgent(createGraph({ chunks: [MESSAGE_CHUNK] }));
  const response = new FakeResponse();
  const invalidRun = { threadId: "" };

  await assert.rejects(runtime.pipe(response, invalidRun), /threadId/);
  await assert.rejects(runtime.toResponse(invalidRun), /threadId/);
  assert.equal(response.status, undefined);
  assert.equal(response.endCount, 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("Web stream errors propagate to the reader", async () => {
  let failNext;
  const failureGate = new Promise((resolve) => {
    failNext = resolve;
  });
  const context = new EventContext("web-error", "web-error", 0);
  const run = {
    threadId: "web-error",
    input: {},
  };
  const response = await createSseResponse(run, () => ({
    async *[Symbol.asyncIterator]() {
      yield context.emit({ type: AgentEventType.RunStarted });
      await failureGate;
      throw new Error("private iterator detail");
    },
  }));

  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(
    new TextDecoder().decode(first.value).includes("run.started"),
    true,
  );
  failNext();
  await assert.rejects(reader.read(), /private iterator detail/);
});

test("serveAgent rejects an invalid recursion limit", () => {
  assert.throws(() => serveAgent(createGraph(), { recursionLimit: 0 }));
});

test("Web Response uses the same event sequence and cancels graph work with its reader", async () => {
  const webGraph = createGraph({ chunks: [MESSAGE_CHUNK] });
  const webResponse = await serveAgent(webGraph).toResponse({
    input: { messages: [{ role: "user", content: "hi" }] },
    threadId: "web-events",
  });
  const webBody = await webResponse.text();
  const webEvents = readEvents([webBody]);

  const nodeResponse = new FakeResponse();
  await serveAgent(createGraph({ chunks: [MESSAGE_CHUNK] })).pipe(
    nodeResponse,
    {
      input: { messages: [{ role: "user", content: "hi" }] },
      threadId: "node-events",
    },
  );
  assert.deepEqual(
    normalizeTransportEvents(webEvents),
    normalizeTransportEvents(readEvents(nodeResponse.frames)),
  );

  const graph = createGraph({ waitForAbort: true });
  const response = await serveAgent(graph).toResponse({
    input: { messages: [{ role: "user", content: "hi" }] },
    threadId: "web-cancel",
  });
  const reader = response.body.getReader();
  await reader.read();
  await reader.read();
  await waitFor(() => graph.signals.length === 1);
  await reader.cancel("consumer closed");
  assert.equal(graph.signals[0].aborted, true);
  assert.equal(graph.cleanupCount, 1);
});

test("Web reader cancellation aborts a cooperative LangChain tool", async () => {
  const cooperative = createCooperativeAgent();
  const response = await serveAgent(cooperative.graph).toResponse({
    threadId: "web-cooperative-tool",
    input: { messages: [{ role: "user", content: "wait" }] },
  });
  const reader = response.body.getReader();

  while (true) {
    const next = await reader.read();
    if (next.done)
      throw new Error("The cooperative tool should still be running.");
    if (new TextDecoder().decode(next.value).includes("tool.called")) break;
  }
  await reader.cancel("consumer closed");

  assert.equal(cooperative.aborts, 1);
});

test("Web Response carries reducer-valid identity through a separate resume request", async () => {
  const { graph, executions } = createApprovalGraph();
  const threadId = "web-approval-resume";
  const first = await serveAgent(graph).toResponse({
    threadId,
    input: { messages: [{ role: "user", content: "send" }] },
  });
  const startEvents = readEvents([await first.text()]);
  assert.equal(startEvents.at(-1).type, AgentEventType.InterruptRequired);
  assert.equal(executions.length, 0);

  const next = await serveAgent(graph).toResponse({
    threadId,
    resume: { decisions: [{ type: "approve" }] },
  });
  const resumeEvents = readEvents([await next.text()]);
  assert.equal(resumeEvents[0].runId, startEvents[0].runId);
  assert.equal(resumeEvents[1].type, AgentEventType.InterruptResolved);
  assert.equal(executions.length, 1);
  const state = [...startEvents, ...resumeEvents].reduce(
    reduceAgentEvent,
    createAgentReducerState(),
  );
  assert.equal(state.status, "completed");
});

test("Node pipe resumes a checkpointed approval on the same thread and run", async () => {
  const { graph, executions } = createApprovalGraph();
  const threadId = "node-approval-resume";
  const startResponse = new FakeResponse();
  await serveAgent(graph).pipe(startResponse, {
    threadId,
    input: { messages: [{ role: "user", content: "send" }] },
  });
  const startEvents = readEvents(startResponse.frames);
  assert.equal(startEvents.at(-1).type, AgentEventType.InterruptRequired);

  const resumeResponse = new FakeResponse();
  await serveAgent(graph).pipe(resumeResponse, {
    threadId,
    resume: { decisions: [{ type: "approve" }] },
  });
  const resumeEvents = readEvents(resumeResponse.frames);
  assert.equal(resumeEvents[0].runId, startEvents[0].runId);
  assert.equal(resumeEvents[1].type, AgentEventType.InterruptResolved);
  assert.equal(executions.length, 1);
  const state = [...startEvents, ...resumeEvents].reduce(
    reduceAgentEvent,
    createAgentReducerState(),
  );
  assert.equal(state.status, "completed");
});

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  headers = {};
  frames = [];
  endCount = 0;
  writes = 0;

  constructor({ backpressureOnWrite } = {}) {
    super();
    this.backpressureOnWrite = backpressureOnWrite;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
    return this;
  }

  write(frame) {
    this.frames.push(frame);
    this.writes += 1;
    return this.writes !== this.backpressureOnWrite;
  }

  end() {
    this.endCount += 1;
    this.writableEnded = true;
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

function createGraph({
  chunks = [],
  error,
  waitForAbort = false,
  honorAbort = false,
} = {}) {
  const graph = {
    signals: [],
    cleanupCount: 0,
    async stream(_input, options) {
      graph.signals.push(options.signal);
      if (error) throw error;
      if (honorAbort && options.signal.aborted) throw options.signal.reason;
      return {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next() {
              if (waitForAbort && index === 0) {
                index += 1;
                return { done: false, value: MESSAGE_CHUNK };
              }
              if (waitForAbort) {
                return new Promise((resolve) => {
                  options.signal.addEventListener(
                    "abort",
                    () => {
                      resolve({ done: true, value: undefined });
                    },
                    { once: true },
                  );
                });
              }
              return index < chunks.length
                ? { done: false, value: chunks[index++] }
                : { done: true, value: undefined };
            },
            async return() {
              graph.cleanupCount += 1;
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
    async getState() {
      return { values: {} };
    },
    async updateState() {
      return {};
    },
  };
  return graph;
}

function createApprovalGraph() {
  const executions = [];
  const send = tool(
    async ({ body }) => {
      executions.push(body);
      return "sent";
    },
    {
      name: "send",
      description: "send",
      schema: z.object({ body: z.string() }),
    },
  );
  const graph = createAgent({
    model: createScriptedChatModel({
      streamSequences: [
        createToolCallArgumentChunks({
          name: "send",
          toolCallId: "call-send",
          input: { body: "hello" },
          messageId: "assistant-call",
          chunkCount: 2,
        }),
        createScriptedMessageChunks(["done"], { id: "assistant-done" }),
      ],
      responses: ["", "done"],
    }),
    tools: [send],
    stateSchema: agentEventStateSchema,
    checkpointer: new MemorySaver(),
    middleware: [humanInTheLoopMiddleware({ interruptOn: { send: true } })],
  }).graph;
  return { graph, executions };
}

function createCooperativeAgent() {
  let aborts = 0;
  const waitForCancellation = createCooperativeTimeoutTool({
    onAbort: () => {
      aborts += 1;
    },
  });
  const wait = tool(
    async (_input, config) => waitForCancellation({ signal: config.signal }),
    {
      name: "wait",
      description: "Wait until cancelled.",
      schema: z.object({}),
    },
  );
  const graph = createAgent({
    model: createScriptedChatModel({
      streamSequences: [
        createToolCallArgumentChunks({
          name: "wait",
          toolCallId: "call-wait",
          input: {},
          messageId: "assistant-wait",
        }),
      ],
      responses: [""],
    }),
    tools: [wait],
    stateSchema: agentEventStateSchema,
    checkpointer: new MemorySaver(),
  }).graph;

  return {
    graph,
    get aborts() {
      return aborts;
    },
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function readEvents(frames) {
  return frames
    .flatMap((frame) => frame.split("\n\n").filter(Boolean))
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")));
}

function normalizeTransportEvents(events) {
  return events.map(
    ({ eventId, phaseId, runId, sessionId, timestamp, ...event }) => event,
  );
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Condition did not become true in time.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
