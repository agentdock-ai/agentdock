import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createCompleteAssistantMessages,
  createCooperativeTimeoutTool,
  createMemoryCheckpoint,
  createScriptedChatModel,
  createScriptedMessageChunks,
  createToolCallArgumentChunks,
} from "../helpers/stream-fixtures.mjs";

test("scripted model fixtures preserve repeated chunks and omitted message IDs", async () => {
  const model = createScriptedChatModel({
    chunks: createScriptedMessageChunks(["x", "x"], {
      id: "assistant-1",
    }),
    response: "xx",
  });
  const generations = [];
  for await (const generation of model._streamResponseChunks([], {}))
    generations.push(generation.message);

  assert.deepEqual(
    generations.map((message) => message.content),
    ["x", "x"],
  );
  assert.deepEqual(
    generations.map((message) => message.id),
    ["assistant-1", "assistant-1"],
  );

  const anonymousChunks = createScriptedMessageChunks(["first", "second"], {
    includeIds: false,
  });
  assert.deepEqual(
    anonymousChunks.map((message) => message.id),
    [undefined, undefined],
  );
});

test("scripted model fixtures create snapshots and split tool JSON chunks", () => {
  const snapshots = createCompleteAssistantMessages(["before", "after"], {
    ids: ["assistant-1", "assistant-2"],
  });
  assert.deepEqual(
    snapshots.map((message) => ({ id: message.id, content: message.content })),
    [
      { id: "assistant-1", content: "before" },
      { id: "assistant-2", content: "after" },
    ],
  );

  const input = { city: "Lahore", units: "metric" };
  const chunks = createToolCallArgumentChunks({
    name: "get_weather",
    toolCallId: "call-weather",
    input,
    messageId: "assistant-tools",
    chunkCount: 3,
  });
  assert.equal(chunks.length, 3);
  assert.equal(
    chunks.map((chunk) => chunk.tool_call_chunks[0].args).join(""),
    JSON.stringify(input),
  );
  assert.equal(chunks[0].tool_call_chunks[0].name, "get_weather");
  assert.equal(chunks[1].tool_call_chunks[0].name, undefined);
  assert.equal(chunks[2].tool_call_chunks[0].id, "call-weather");
});

test("checkpoint fixture provides reusable in-memory storage", () => {
  const memory = createMemoryCheckpoint();
  assert.equal(typeof memory.getTuple, "function");
  assert.equal(typeof memory.put, "function");
});

test("cooperative timeout fixture observes an abort signal", async () => {
  let aborts = 0;
  const tool = createCooperativeTimeoutTool({
    onAbort: () => {
      aborts += 1;
    },
  });
  const controller = new AbortController();
  const pending = tool({ signal: controller.signal });

  controller.abort(new Error("fixture abort"));

  await assert.rejects(pending, /fixture abort/);
  assert.equal(aborts, 1);
});
