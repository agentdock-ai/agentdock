import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";

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
  streamSequences,
  response = "",
  responses,
  responseId,
} = {}) {
  return new ScriptedChatModel({
    chunks,
    streamSequences,
    response,
    responses,
    responseId,
  });
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

export function createMemoryCheckpoint() {
  return new MemorySaver();
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
  constructor({ chunks, streamSequences, response, responses, responseId }) {
    super({});
    this.chunks = chunks;
    this.streamSequences = streamSequences;
    this.response = response;
    this.responses = responses;
    this.responseId = responseId;
    this.streamIndex = 0;
    this.responseIndex = 0;
  }

  bindTools() {
    return this;
  }

  _llmType() {
    return "agentdock-scripted";
  }

  async *_streamResponseChunks(_messages, _options, runManager) {
    const chunks = this.streamSequences
      ? (this.streamSequences[this.streamIndex++] ?? [])
      : this.chunks;
    for (const chunk of chunks) {
      const generation = new ChatGenerationChunk({ message: chunk });
      yield generation;
      await runManager?.handleLLMNewToken(
        "",
        undefined,
        undefined,
        undefined,
        undefined,
        { chunk: generation },
      );
    }
  }

  async _generate() {
    const response = this.responses
      ? (this.responses[this.responseIndex++] ?? "")
      : this.response;
    return {
      generations: [
        {
          message: new AIMessage({
            content: response,
            ...(this.responseId === undefined ? {} : { id: this.responseId }),
          }),
        },
      ],
    };
  }
}
