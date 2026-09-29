import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "vitest";
import {
  AgentEventType,
  createAgentReducerState,
  reduceAgentEvent,
} from "@agentdock-ai/contracts";
import { agentEventStateSchema, serveAgent } from "../../src/index.js";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import { z } from "zod";
import {
  createScriptedChatModel,
  createScriptedMessageChunks,
  createToolCallArgumentChunks,
} from "../helpers/stream-fixtures.mjs";

test("serves a completed createAgent workflow over an authenticated SSE route", async ({
  skip,
}) => {
  const graph = createAgent({
    model: createScriptedChatModel({
      streamSequences: [
        createScriptedMessageChunks(["Hello from the agent."], {
          id: "assistant-hello",
        }),
      ],
    }),
    tools: [],
    stateSchema: agentEventStateSchema,
    checkpointer: new MemorySaver(),
  }).graph;
  const runtime = serveAgent(graph);
  const server = createServer((request, response) => {
    void serveRequest(request, response, async (body, userId) => {
      await runtime.pipe(response, {
        threadId: userId,
        input: { messages: [{ role: "user", content: body.prompt }] },
      });
    });
  });
  const port = await listenOrSkip(server, skip);
  if (port === null) return;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/agent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-authenticated-user": "user-17",
      },
      body: JSON.stringify({
        prompt: "Say hello.",
        threadId: "client-cannot-choose-thread",
      }),
    });
    const events = readSseEvents(await response.text());

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.equal(events[0].type, AgentEventType.RunStarted);
    assert.ok(
      events.some(
        (event) =>
          event.type === AgentEventType.MessagePartDelta &&
          event.part.text === "Hello from the agent.",
      ),
    );
    assert.equal(events.at(-1).type, AgentEventType.RunCompleted);
    assert.ok(events.every((event) => event.sessionId === "user-17"));
    assert.equal(
      events.reduce(reduceAgentEvent, createAgentReducerState()).status,
      "completed",
    );
  } finally {
    await closeServer(server);
  }
});

test("resumes an approval across separate SSE requests on the same user thread", async ({
  skip,
}) => {
  const { graph, sideEffects } = createApprovalGraph();
  const server = createServer((request, response) => {
    void serveRequest(request, response, async (body, userId) => {
      const runtime = serveAgent(graph);
      const run =
        body.resume === undefined
          ? {
              threadId: userId,
              input: { messages: [{ role: "user", content: body.prompt }] },
            }
          : { threadId: userId, resume: body.resume };
      await runtime.pipe(response, run);
    });
  });
  const port = await listenOrSkip(server, skip);
  if (port === null) return;

  try {
    const startResponse = await postJson(port, {
      prompt: "Send hello.",
      userId: "user-approval-29",
    });
    const startEvents = readSseEvents(await startResponse.text());

    assert.equal(startEvents.at(-1).type, AgentEventType.InterruptRequired);
    assert.equal(sideEffects.length, 0);

    const resumeResponse = await postJson(port, {
      resume: { decisions: [{ type: "approve" }] },
      userId: "user-approval-29",
    });
    const resumeEvents = readSseEvents(await resumeResponse.text());
    const combinedEvents = [...startEvents, ...resumeEvents];

    assert.equal(resumeResponse.status, 200);
    assert.equal(resumeEvents[0].type, AgentEventType.RunStarted);
    assert.equal(resumeEvents[0].runId, startEvents[0].runId);
    assert.equal(resumeEvents[1].type, AgentEventType.InterruptResolved);
    assert.deepEqual(sideEffects, ["hello"]);
    assert.ok(
      resumeEvents.every((event) => event.sessionId === "user-approval-29"),
    );
    assert.equal(
      combinedEvents.reduce(reduceAgentEvent, createAgentReducerState()).status,
      "completed",
    );
  } finally {
    await closeServer(server);
  }
});

function createApprovalGraph() {
  const sideEffects = [];
  const send = tool(
    async ({ body }) => {
      sideEffects.push(body);
      return "sent";
    },
    {
      name: "send",
      description: "Send a message.",
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
        createScriptedMessageChunks(["Done."], { id: "assistant-done" }),
      ],
      responses: ["", "Done."],
    }),
    tools: [send],
    stateSchema: agentEventStateSchema,
    checkpointer: new MemorySaver(),
    middleware: [humanInTheLoopMiddleware({ interruptOn: { send: true } })],
  }).graph;
  return { graph, sideEffects };
}

async function serveRequest(request, response, run) {
  if (request.method !== "POST" || request.url !== "/agent") {
    response.writeHead(404).end();
    return;
  }
  const userId = request.headers["x-authenticated-user"];
  if (typeof userId !== "string" || userId.length === 0) {
    response.writeHead(401).end();
    return;
  }
  try {
    const body = await readJson(request);
    await run(body, userId);
  } catch {
    if (!response.headersSent) response.writeHead(500).end();
    else response.destroy();
  }
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function readSseEvents(body) {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")));
}

async function postJson(port, body) {
  const { userId, ...payload } = body;
  return fetch(`http://127.0.0.1:${port}/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-authenticated-user": userId,
    },
    body: JSON.stringify(payload),
  });
}

async function listenOrSkip(server, skip) {
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
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      skip("The environment blocks loopback sockets.");
      return null;
    }
    throw error;
  }
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
