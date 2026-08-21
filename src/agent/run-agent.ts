import { generateText, streamText, type ModelMessage } from "ai";
import { createAgentRunResult } from "./runtime/result.js";
import {
  buildModelRequest,
  prepareAgentRun,
} from "./runtime/run-context.js";
import type {
  AgentContext,
  AgentRunResult,
  RunAgentOptions,
  StreamAgentResult,
} from "./types.js";

export async function runAgent(
  userPrompt: string,
  ctx: AgentContext,
  options: RunAgentOptions = {},
): Promise<AgentRunResult> {
  const prepared = await prepareAgentRun(userPrompt, ctx, options);
  const result = await generateText(buildModelRequest(prepared));

  return createAgentRunResult(
    prepared,
    result.text,
    result.responseMessages,
    result.toolCalls,
    result.toolResults,
  );
}

export async function streamAgent(
  userPrompt: string,
  ctx: AgentContext,
  options: RunAgentOptions = {},
): Promise<StreamAgentResult> {
  const prepared = await prepareAgentRun(userPrompt, ctx, options);
  const stream = streamText(buildModelRequest(prepared));

  const result: Promise<AgentRunResult> = Promise.all([
    stream.text,
    stream.responseMessages,
    stream.toolCalls,
    stream.toolResults,
  ]).then(([text, responseMessages, toolCalls, toolResults]) =>
    createAgentRunResult(
      prepared,
      text,
      responseMessages as ModelMessage[],
      toolCalls,
      toolResults,
    ),
  );

  return {
    stream: stream.fullStream,
    result,
  };
}
