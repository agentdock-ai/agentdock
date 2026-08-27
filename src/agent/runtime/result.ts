import type { ModelMessage } from "ai";
import type { AgentRunResult } from "../types.js";
import type { ToolApprovalRequest } from "../permissions/types.js";
import type { PreparedAgentRun } from "./run-context.js";
import { normalizeToolCalls, normalizeToolResults, toInternalMessages } from "./messages.js";
import type { AgentRunStatus } from "../runs/store.js";

export function createAgentRunResult(
  prepared: PreparedAgentRun,
  text: string,
  responseMessages: ModelMessage[],
  toolCalls: any[],
  toolResults: any[],
  content: any[] = [],
  stepsCompleted = 1,
  status: AgentRunStatus = "completed",
): AgentRunResult {
  prepared.history.push(...toInternalMessages(responseMessages));

  const approvalRequests: ToolApprovalRequest[] = content
    .filter(
      (part) =>
        part?.type === "tool-approval-request" &&
        part.isAutomatic !== true,
    )
    .map((part) => ({
      approvalId: part.approvalId,
      toolCall: {
        toolCallId: part.toolCall.toolCallId,
        name: part.toolCall.toolName,
        input: part.toolCall.input,
      },
    }));

  return {
    runId: prepared.runId,
    sessionId: prepared.sessionId,
    status,
    content: text,
    messages: prepared.history,
    toolCalls: normalizeToolCalls(toolCalls),
    toolResults: normalizeToolResults(toolResults),
    toolErrors: prepared.toolErrors,
    approvalRequests,
    stepsCompleted,
  };
}
