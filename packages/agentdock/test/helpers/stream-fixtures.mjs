import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteCheckpoint } from "@agentdock/checkpoint-sqlite";

export function createScriptedMessageChunks(
  contents,
  { id, includeIds = true } = {},
) {
  return contents.map(
    (content) =>
      new AIMessageChunk({
        content,
        ...(includeIds && id !== undefined ? { id } : {}),
      }),
  );
}

export function createCompleteAssistantMessages(contents, { ids = [] } = {}) {
  return contents.map(
    (content, index) =>
      new AIMessage({
        content,
        ...(ids[index] !== undefined ? { id: ids[index] } : {}),
      }),
  );
}

export function createToolCallArgumentChunks({
  name,
  toolCallId,
  input,
  messageId,
  chunkCount = 3,
}) {
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 2) {
    throw new Error("chunkCount must be an integer greater than one.");
  }
  const serializedInput = JSON.stringify(input);
  const chunks = splitIntoChunks(serializedInput, chunkCount);
  return chunks.map(
    (args, index) =>
      new AIMessageChunk({
        content: "",
        ...(messageId === undefined ? {} : { id: messageId }),
        tool_call_chunks: [
          {
            ...(index === 0 ? { name } : {}),
            args,
            id: toolCallId,
            index: 0,
          },
        ],
      }),
  );
}

export function createScriptedChatModel({
  chunks = [],
  response = "",
  responseId,
} = {}) {
  return new ScriptedChatModel({ chunks, response, responseId });
}

export function createCooperativeTimeoutTool({ onStart, onAbort } = {}) {
  return async ({ signal }) => {
    onStart?.();
    await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        onAbort?.();
        reject(signal.reason ?? new Error("Aborted."));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          onAbort?.();
          reject(signal.reason ?? new Error("Aborted."));
        },
        { once: true },
      );
    });
  };
}

export function createUncooperativeTool({ onStarted } = {}) {
  return async () => {
    onStarted?.();
    return new Promise(() => {});
  };
}

export function createNeverSettlingAuthorization() {
  return async () => new Promise(() => {});
}

export function createMemoryCheckpoint() {
  return new MemorySaver();
}

export async function createSQLiteCheckpoint() {
  const directory = await mkdtemp(path.join(tmpdir(), "agentdock-phase0-"));
  const checkpoint = new SqliteCheckpoint({
    path: path.join(directory, "checkpoints.sqlite"),
  });

  return {
    checkpoint,
    cleanup: async () => {
      await checkpoint.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function splitIntoChunks(value, chunkCount) {
  const result = [];
  let offset = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const remaining = chunkCount - index;
    const length = Math.ceil((value.length - offset) / remaining);
    result.push(value.slice(offset, offset + length));
    offset += length;
  }
  return result;
}

class ScriptedChatModel extends BaseChatModel {
  constructor({ chunks, response, responseId }) {
    super({});
    this.chunks = chunks;
    this.response = response;
    this.responseId = responseId;
  }

  bindTools() {
    return this;
  }

  _llmType() {
    return "agentdock-scripted";
  }

  async *_stream() {
    for (const chunk of this.chunks) {
      yield new ChatGenerationChunk({ message: chunk });
    }
  }

  async _generate() {
    return {
      generations: [
        {
          message: new AIMessage({
            content: this.response,
            ...(this.responseId === undefined ? {} : { id: this.responseId }),
          }),
        },
      ],
    };
  }
}
