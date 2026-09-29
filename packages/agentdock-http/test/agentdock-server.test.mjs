import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "vitest";
import { AgentdockServer } from "../src/index.js";
import { Agentdock } from "@agentdock-ai/agentdock";

const interrupt = {
  kind: "custom",
  interruptId: "saved-interrupt",
  prompt: "Continue?",
  actions: [{ id: "yes", name: "continue", input: {} }],
};

test("authorizes thread routes and rejects bodies with server-owned fields", async () => {
  const graph = createGraph();
  const authorized = [];
  const server = new AgentdockServer({
    agent: new Agentdock(graph),
    basePath: "/v1/agent",
    authorize: async (request, threadId) => {
      authorized.push([request.method, threadId]);
      return null;
    },
  });

  const denied = await server.toHttp()(
    request("POST", "/v1/agent/threads/thread-a/runs", { input: {} }),
  );
  assert.equal(denied.status, 403);
  assert.equal(graph.streamCalls.length, 0);
  assert.deepEqual(authorized, [["POST", "thread-a"]]);

  const allowedServer = new AgentdockServer({
    agent: server.agent,
    basePath: "/v1/agent",
    authorize: async () => ({ context: { userId: "user-1" } }),
  });
  const invalid = await allowedServer.toHttp()(
    request("POST", "/v1/agent/threads/thread-a/runs", {
      input: {},
      context: { userId: "spoofed" },
    }),
  );
  assert.equal(invalid.status, 400);
  assert.equal(graph.streamCalls.length, 0);
});

test("routes reads, optional thread listing, and not-found cases", async () => {
  const graph = createGraph({
    values: {
      messages: [{ role: "assistant", content: "saved" }],
      agentEventState: {
        runId: "saved-run",
        logicalSequence: 4,
        pendingInterrupt: interrupt,
      },
    },
  });
  const requests = [];
  const server = new AgentdockServer({
    agent: new Agentdock(graph),
    authorize: async (_request, threadId) => {
      requests.push(threadId);
      return { context: {} };
    },
    threads: {
      listThreads: async ({ request: current }) => ({
        user: new URL(current.url).searchParams.get("user"),
        threads: ["thread-a"],
      }),
    },
  });
  const handle = server.toHttp();

  const messages = await handle(
    request("GET", "/agent/threads/thread-a/messages"),
  );
  assert.deepEqual(await messages.json(), {
    threadId: "thread-a",
    messages: [{ role: "assistant", content: "saved" }],
  });

  const resumeState = await handle(
    request("GET", "/agent/threads/thread-a/resume-state"),
  );
  const resumeBody = await resumeState.json();
  assert.equal(resumeBody.state.status, "waiting");
  assert.equal(resumeBody.state.runId, "saved-run");

  const listed = await handle(request("GET", "/agent/threads?user=user-1"));
  assert.deepEqual(await listed.json(), {
    threads: { user: "user-1", threads: ["thread-a"] },
  });
  assert.deepEqual(requests, ["thread-a", "thread-a"]);

  const missing = await handle(
    request("GET", "/other/threads/thread-a/messages"),
  );
  assert.equal(missing.status, 404);

  const unconfigured = new AgentdockServer({
    agent: new Agentdock(graph),
    authorize: async () => ({ context: {} }),
  });
  const notImplemented = await unconfigured.toHttp()(
    request("GET", "/agent/threads"),
  );
  assert.equal(notImplemented.status, 501);
});

test("serves SSE run and resume requests across separate HTTP calls", async () => {
  const graph = createGraph({
    values: {
      messages: [],
      agentEventState: {
        runId: "saved-run",
        logicalSequence: 4,
        pendingInterrupt: interrupt,
      },
    },
  });
  const server = new AgentdockServer({
    agent: new Agentdock(graph),
    authorize: async () => ({ context: { userId: "user-1" } }),
  });
  const handle = server.toHttp();

  const started = await handle(
    request("POST", "/agent/threads/thread-a/runs", {
      input: { messages: [] },
    }),
  );
  assert.match(started.headers.get("content-type"), /text\/event-stream/);
  const startedText = await started.text();
  assert.match(startedText, /run\.completed/);

  const resumed = await handle(
    request("POST", "/agent/threads/thread-a/resume", {
      resume: { decisions: [{ type: "approve" }] },
    }),
  );
  const resumedText = await resumed.text();
  assert.match(resumedText, /interrupt\.resolved/);
  assert.match(resumedText, /run\.completed/);
  assert.equal(graph.streamCalls.length, 2);
  assert.equal(graph.streamCalls[1].options.configurable.thread_id, "thread-a");
});

test("bridges node:http requests to Web routes", async ({ skip }) => {
  const app = new AgentdockServer({
    agent: new Agentdock(createGraph()),
    authorize: async () => ({ context: {} }),
  });
  const httpServer = createServer(app.toNode());
  try {
    await listen(httpServer);
  } catch (error) {
    if (error?.code === "EPERM")
      skip("The environment blocks loopback sockets.");
    throw error;
  }

  try {
    const address = httpServer.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/agent/threads/thread-a/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { messages: [] } }),
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.match(await response.text(), /run\.completed/);
  } finally {
    await new Promise((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a Node client disconnect aborts the graph run", async ({ skip }) => {
  const graph = createGraph({ waitForAbort: true });
  const app = new AgentdockServer({
    agent: new Agentdock(graph),
    authorize: async () => ({ context: {} }),
  });
  const httpServer = createServer(app.toNode());
  try {
    await listen(httpServer);
  } catch (error) {
    if (error?.code === "EPERM")
      skip("The environment blocks loopback sockets.");
    throw error;
  }

  try {
    const address = httpServer.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/agent/threads/thread-a/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { messages: [] } }),
      },
    );
    const reader = response.body.getReader();
    await reader.read();
    await waitFor(() => graph.signals.length === 1);
    await reader.cancel();
    await waitFor(() => graph.signals[0].aborted);
    assert.equal(graph.signals[0].aborted, true);
  } finally {
    httpServer.closeAllConnections();
    await new Promise((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function request(method, path, body) {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

function createGraph({ values = { messages: [] }, waitForAbort = false } = {}) {
  const graph = {
    values,
    streamCalls: [],
    signals: [],
    async getState() {
      return { values: this.values };
    },
    async updateState(_config, update) {
      this.values = { ...this.values, ...update };
      return {};
    },
    async stream(input, options) {
      this.streamCalls.push({ input, options });
      if (waitForAbort) {
        this.signals.push(options.signal);
        return (async function* () {
          yield ["messages", [{ id: "partial", content: "hello" }, {}]];
          await new Promise((resolve) =>
            options.signal.addEventListener("abort", resolve, { once: true }),
          );
        })();
      }
      return async function* () {
        yield [
          "messages",
          [{ id: `message-${this.streamCalls.length}`, content: "hello" }, {}],
        ];
      }.bind(this)();
    },
  };
  return graph;
}

function listen(server) {
  return new Promise((resolve, reject) => {
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
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
