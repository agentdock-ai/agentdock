import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "vitest";
import { AIMessageChunk } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import { z } from "zod";
import { Agentdock } from "../../src/index.js";
import {
  createScriptedChatModel,
  createScriptedMessageChunks,
} from "../helpers/stream-fixtures.mjs";

test("HTTP approvals preserve permissions, reject renames, serialize resumes and audit mixed decisions", async ({
  skip,
}) => {
  const effects = [];
  const audit = [];
  let admitted;
  const entered = new Promise((resolve) => {
    admitted = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tools = ["list_files", "run_command"].map((name) =>
    tool(
      async (args) => {
        effects.push({ name, args });
        return "done";
      },
      { name, description: name, schema: z.object({ value: z.string() }) },
    ),
  );
  const graph = createAgent({
    model: createScriptedChatModel({
      streamSequences: [
        [
          new AIMessageChunk({
            content: "",
            id: "assistant",
            tool_call_chunks: tools.map((current, index) => ({
              name: current.name,
              id: `call-${index}`,
              args: JSON.stringify({ value: "original" }),
              index,
            })),
          }),
        ],
        createScriptedMessageChunks(["done"], { id: "done" }),
      ],
      responses: ["", "done"],
    }),
    tools,
    checkpointer: new MemorySaver(),
    middleware: [
      humanInTheLoopMiddleware({
        interruptOn: {
          list_files: true,
          run_command: { allowedDecisions: ["approve", "reject"] },
        },
      }),
    ],
  }).graph;
  const runtime = new Agentdock(graph, {
    interruptFormat: Agentdock.HITL,
    async onDecision(record) {
      audit.push(record);
      admitted();
      await gate;
    },
  });
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const invocation = {
        threadId: "server-thread",
        context: { actorId: "trusted-user" },
      };
      if (body.resume) invocation.resume = body.resume;
      else
        invocation.input = {
          messages: [{ role: "user", content: "list and run" }],
        };
      await runtime.pipe(response, invocation);
    } catch (error) {
      if (response.headersSent) response.end();
      else {
        response.writeHead(error.status ?? 500, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ error: error.message }));
      }
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      skip("Loopback sockets are blocked.");
      return;
    }
    throw error;
  }
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body) =>
    fetch(url, { method: "POST", body: JSON.stringify(body) });
  try {
    const first = await post({});
    const initial = await first.text();
    assert.equal(first.status, 200);
    assert.match(initial, /interrupt.required/);
    const state = await new Agentdock(graph, {
      interruptFormat: Agentdock.HITL,
    }).getResumeState("server-thread");
    assert.deepEqual(
      state.interrupt.actions.map((action) => action.allowedDecisions),
      [
        ["approve", "edit", "reject"],
        ["approve", "reject"],
      ],
    );
    const rename = await post({
      resume: {
        decisions: [
          {
            type: "edit",
            editedAction: { name: "run_command", args: { value: "bypass" } },
          },
          { type: "approve" },
        ],
      },
    });
    assert.equal(rename.status, 400);
    assert.match(await rename.text(), /cannot change/);
    const forbidden = await post({
      resume: {
        decisions: [
          { type: "approve" },
          {
            type: "edit",
            editedAction: { name: "run_command", args: { value: "edit" } },
          },
        ],
      },
    });
    assert.equal(forbidden.status, 400);
    assert.match(await forbidden.text(), /not allowed/);
    assert.deepEqual(effects, []);
    assert.deepEqual(audit, []);
    const body = {
      resume: {
        [state.interrupt.interruptId]: {
          decisions: [{ type: "approve" }, { type: "reject" }],
        },
      },
    };
    const approved = post(body);
    await entered;
    const duplicate = await post(body);
    assert.equal(duplicate.status, 409);
    assert.match(await duplicate.text(), /already active/);
    release();
    const result = await approved;
    const final = await result.text();
    assert.equal(result.status, 200);
    assert.match(final, /run.completed/);
    // Native HITL replans the batch when any tool is rejected.
    assert.deepEqual(effects, []);
    assert.match(final, /User rejected the tool call/);
    assert.deepEqual(
      audit.map((record) => record.decision),
      ["approve", "reject"],
    );
    assert.equal(new Set(audit.map((record) => record.id)).size, 2);
    assert.ok(
      audit.every((record) => record.context.actorId === "trusted-user"),
    );
  } finally {
    release();
    await new Promise((resolve) => server.close(resolve));
  }
});
