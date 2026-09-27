import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import {
  AgentEventType,
  createAgentReducerState,
  reduceAgentEvent,
} from "@agentdock-ai/contracts";
import {
  Command,
  END,
  MemorySaver,
  START,
  StateSchema,
  StateGraph,
} from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import { z } from "zod";
import { agentEventStateSchema } from "../../src/agent/event-state.ts";
import {
  createMemoryCheckpoint,
  createScriptedChatModel,
  createScriptedMessageChunks,
  createToolCallArgumentChunks,
} from "../helpers/stream-fixtures.mjs";

function serveAgent(graph) {
  async function* stream(run) {
    const config = { configurable: { thread_id: run.threadId } };
    const resuming = "resume" in run;
    const checkpoint = resuming ? await graph.getState(config) : undefined;
    const previous = checkpoint?.values.agentdockEventState;
    const state = resuming
      ? previous
      : { runId: crypto.randomUUID(), logicalSequence: 0 };
    if (!state?.runId)
      throw new Error("Graph has no persisted AgentDock event state.");
    const runId = state.runId;
    let logicalSequence = state.logicalSequence;
    const phaseId = crypto.randomUUID();
    const emit = (input) => ({
      ...input,
      protocolVersion: 1,
      eventId: crypto.randomUUID(),
      runId,
      sessionId: run.threadId,
      logicalSequence: ++logicalSequence,
      phaseId,
      sequence: logicalSequence,
      timestamp: new Date().toISOString(),
    });

    yield emit({ type: AgentEventType.RunStarted });
    if (resuming) {
      yield emit({
        type: AgentEventType.InterruptResolved,
        interruptId: previous.pendingInterruptId ?? run.resume.interruptId,
        decisions: run.resume.decisions,
      });
    }

    let pendingInterrupt;
    try {
      const input = resuming
        ? new Command({ resume: run.resume })
        : {
            ...run.input,
            agentdockEventState: state,
          };
      const chunks = await graph.stream(input, {
        ...config,
        context: run.context,
        signal: run.signal,
        streamMode: ["messages", "updates"],
      });
      for await (const [mode, chunk] of chunks) {
        if (mode !== "updates" || !chunk?.__interrupt__?.length) continue;
        const value = chunk.__interrupt__[0];
        const requests = value.value?.actionRequests ?? [];
        const event = emit({
          type: AgentEventType.InterruptRequired,
          interrupt: {
            interruptId: value.id,
            kind: "tool-approval",
            prompt: "Approve this action",
            actions: requests.map((action, index) => {
              const id = String(
                action.id ?? action.toolCallId ?? `action-${index}`,
              );
              return {
                id,
                name: String(action.name ?? "tool"),
                input: action.args ?? {},
                toolCallId: String(action.toolCallId ?? id),
              };
            }),
          },
        });
        pendingInterrupt = { event, interruptId: value.id };
      }
      if (pendingInterrupt) {
        await graph.updateState(config, {
          agentdockEventState: {
            runId,
            logicalSequence: pendingInterrupt.event.logicalSequence,
            pendingInterruptId: pendingInterrupt.interruptId,
          },
        });
        yield pendingInterrupt.event;
      } else {
        yield emit({
          type: AgentEventType.RunCompleted,
          finishReason: "stop",
          content: [],
        });
      }
    } catch (error) {
      yield emit({
        type: AgentEventType.RunFailed,
        code: "graph_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function pipe(response, run) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for await (const event of stream(run)) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  }

  return { stream, pipe };
}

class FakeResponse extends EventEmitter {
  writes = [];
  ended = 0;
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }
  write(frame) {
    this.writes.push(frame);
    return true;
  }
  end() {
    this.ended += 1;
  }
  events() {
    return this.writes.map((frame) => JSON.parse(frame.slice("data: ".length)));
  }
}

test("event state schema composes with createAgent and a general StateGraph", async () => {
  const saver = createMemoryCheckpoint();
  const agent = createAgent({
    model: createScriptedChatModel({ response: "ok" }),
    tools: [],
    checkpointer: saver,
    stateSchema: agentEventStateSchema,
  });
  assert.equal(typeof agent.stream, "function");

  const base = new StateSchema({
    value: z.string().default(""),
  });
  const combined = new StateSchema({
    ...base.fields,
    ...agentEventStateSchema.fields,
  });
  const graph = new StateGraph(combined)
    .addNode("step", () => ({ value: "done" }))
    .addEdge(START, "step")
    .addEdge("step", END)
    .compile({ checkpointer: new MemorySaver() });
  assert.equal(typeof graph.stream, "function");
});

test("HITL event identity and sequence survive separate requests and runtime recreation", async () => {
  const { sent, agent, threadId } = await createApprovalAgent();
  const startResponse = new FakeResponse();
  const firstRuntime = serveAgent(agent);
  await firstRuntime.pipe(startResponse, {
    input: { messages: [{ role: "user", content: "send hello" }] },
    threadId,
  });
  const startEvents = startResponse.events();
  assert.equal(sent.length, 0);
  assert.equal(startEvents[0].type, AgentEventType.RunStarted);
  assert.equal(startEvents.at(-1).type, AgentEventType.InterruptRequired);
  const paused = await agent.getState({
    configurable: { thread_id: threadId },
  });
  assert.deepEqual(paused.values.agentdockEventState, {
    runId: startEvents[0].runId,
    logicalSequence: startEvents.at(-1).logicalSequence,
    pendingInterruptId: startEvents.at(-1).interrupt.interruptId,
  });

  const resumedRuntime = serveAgent(agent);
  const resumeResponse = new FakeResponse();
  await resumedRuntime.pipe(resumeResponse, {
    threadId,
    resume: {
      interruptId: startEvents.at(-1).interrupt.interruptId,
      decisions: [{ type: "approve" }],
    },
  });
  const resumeEvents = resumeResponse.events();
  assert.deepEqual(sent, ["hello"]);
  assert.equal(resumeEvents[0].runId, startEvents[0].runId);
  assert.ok(
    resumeEvents[0].logicalSequence > startEvents.at(-1).logicalSequence,
  );

  const finalState = [...startEvents, ...resumeEvents].reduce(
    reduceAgentEvent,
    createAgentReducerState(),
  );
  assert.equal(finalState.status, "completed", JSON.stringify(resumeEvents));
  assert.equal(finalState.interrupt, null);
});

async function createApprovalAgent() {
  const sent = [];
  const sideEffect = tool(
    async ({ body }) => {
      sent.push(body);
      return "sent";
    },
    {
      name: "send",
      description: "send",
      schema: z.object({ body: z.string() }),
    },
  );
  const chunks = createToolCallArgumentChunks({
    name: "send",
    toolCallId: "call-send",
    input: { body: "hello" },
    messageId: "assistant-call",
    chunkCount: 2,
  });
  const agent = createAgent({
    model: createScriptedChatModel({
      streamSequences: [
        [...chunks],
        createScriptedMessageChunks(["done"], { id: "assistant-done" }),
      ],
      responses: ["", "done"],
    }),
    tools: [sideEffect],
    checkpointer: createMemoryCheckpoint(),
    stateSchema: agentEventStateSchema,
    middleware: [humanInTheLoopMiddleware({ interruptOn: { send: true } })],
  });
  return { sent, agent, threadId: "event-state-hitl" };
}
