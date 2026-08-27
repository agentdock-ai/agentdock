import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

function streamParts(parts, finishReason = "stop") {
  return [
    { type: "stream-start", warnings: [] },
    ...parts,
    {
      type: "finish",
      finishReason: { unified: finishReason, raw: undefined },
      usage: {
        inputTokens: {
          total: 0,
          noCache: 0,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: 0,
          text: 0,
          reasoning: undefined,
        },
      },
    },
  ];
}

export function textResponse(text) {
  return streamParts([
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
  ]);
}

export function toolCallResponse({ toolCallId, toolName, input }) {
  return streamParts(
    [{
      type: "tool-call",
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    }],
    "tool-calls",
  );
}

export function createScriptedModel(responses) {
  let responseIndex = 0;
  const model = new MockLanguageModelV4({
    doStream: () => {
      const response = responses[responseIndex++];
      if (!response) {
        throw new Error("Test model received more calls than scripted");
      }

      return {
        stream: simulateReadableStream({
          chunks: response,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });

  return model;
}

export function createFailingModel(error = new Error("Model unavailable")) {
  return new MockLanguageModelV4({
    doStream: () => {
      throw error;
    },
  });
}
