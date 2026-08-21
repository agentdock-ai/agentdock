import type { ModelMessage } from "ai";
import type { AgentRunResult } from "../types.js";
import type { PreparedAgentRun } from "./run-context.js";
import { normalizeToolCalls, normalizeToolResults, toInternalMessages } from "./messages.js";

export function createAgentRunResult(
  prepared: PreparedAgentRun,
  text: string,
  responseMessages: ModelMessage[],
  toolCalls: any[],
  toolResults: any[],
): AgentRunResult {
  prepared.history.push(...toInternalMessages(responseMessages));

  return {
    content: text,
    messages: prepared.history,
    toolCalls: normalizeToolCalls(toolCalls),
    toolResults: normalizeToolResults(toolResults),
    toolErrors: prepared.toolErrors,
  };
}
