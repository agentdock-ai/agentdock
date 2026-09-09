import type { ToolApprovalRequest } from "../../permissions/types.js";
import type { ToolCallRecord } from "../../types.js";
import { isRecord } from "../../value.js";

export function readApprovalRequestsFromCheckpoint(
  state: unknown,
  finalizedToolCalls: readonly ToolCallRecord[],
): ToolApprovalRequest[] {
  if (!isRecord(state)) return [];
  const interrupts = Array.isArray(state.tasks)
    ? state.tasks.flatMap((task) => {
        if (!isRecord(task) || !Array.isArray(task.interrupts)) return [];
        return task.interrupts;
      })
    : readPendingWriteInterrupts(state.pendingWrites);
  return matchApprovalActions(interrupts, finalizedToolCalls);
}

function readPendingWriteInterrupts(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((write) => {
    if (!Array.isArray(write) || write[1] !== "__interrupt__") return [];
    return [write[2]];
  });
}

export function readApprovalRequestsFromPayload(
  payload: unknown,
  finalizedToolCalls: readonly ToolCallRecord[],
): ToolApprovalRequest[] {
  if (!isRecord(payload)) return [];
  return matchApprovalActions(payload.__interrupt__, finalizedToolCalls);
}

function matchApprovalActions(
  interrupts: unknown,
  finalizedToolCalls: readonly ToolCallRecord[],
): ToolApprovalRequest[] {
  if (!Array.isArray(interrupts)) return [];

  const actionRequests = interrupts.flatMap((interrupt) => {
    if (!isRecord(interrupt) || !isRecord(interrupt.value)) return [];
    const actions = interrupt.value.actionRequests;
    return Array.isArray(actions) ? actions : [];
  });
  if (actionRequests.length === 0) return [];

  const remaining = [...finalizedToolCalls];
  return actionRequests.map((action) => {
    if (!isRecord(action) || typeof action.name !== "string") {
      throw new Error("Current approval interrupt contains an invalid action.");
    }
    const index = remaining.findIndex(
      (toolCall) =>
        toolCall.name === action.name &&
        isEquivalentJson(toolCall.input, action.args),
    );
    if (index < 0) {
      throw new Error(
        `Current approval interrupt references an unknown finalized tool call: ${action.name}`,
      );
    }
    const [toolCall] = remaining.splice(index, 1);
    return { approvalId: toolCall.toolCallId, toolCall };
  });
}

function isEquivalentJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
