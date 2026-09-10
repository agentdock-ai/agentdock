import type { ToolApprovalRequest } from "../../permissions/types.js";
import type { ToolCallRecord } from "../../types.js";
import { isRecord } from "../../value.js";

export interface PendingApprovalInterrupt {
  interruptId: string;
  requests: ToolApprovalRequest[];
}

export function readApprovalInterruptFromCheckpoint(
  state: unknown,
  finalizedToolCalls: readonly ToolCallRecord[],
  resolvedInterruptIds: ReadonlySet<string> = new Set(),
): PendingApprovalInterrupt | null {
  if (!isRecord(state)) return null;
  const interrupts = Array.isArray(state.tasks)
    ? state.tasks.flatMap((task) => {
        if (!isRecord(task) || !Array.isArray(task.interrupts)) return [];
        return task.interrupts;
      })
    : readPendingWriteInterrupts(state.pendingWrites);
  return readApprovalInterrupt(
    interrupts,
    finalizedToolCalls,
    resolvedInterruptIds,
  );
}

function readPendingWriteInterrupts(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((write) => {
    if (!Array.isArray(write) || write[1] !== "__interrupt__") return [];
    return [write[2]];
  });
}

export function readApprovalInterruptFromPayload(
  payload: unknown,
  finalizedToolCalls: readonly ToolCallRecord[],
  resolvedInterruptIds: ReadonlySet<string> = new Set(),
): PendingApprovalInterrupt | null {
  if (!isRecord(payload)) return null;
  return readApprovalInterrupt(
    payload.__interrupt__,
    finalizedToolCalls,
    resolvedInterruptIds,
  );
}

function readApprovalInterrupt(
  interrupts: unknown,
  finalizedToolCalls: readonly ToolCallRecord[],
  resolvedInterruptIds: ReadonlySet<string>,
): PendingApprovalInterrupt | null {
  if (!Array.isArray(interrupts)) return null;

  const active = flattenInterrupts(interrupts).filter((interrupt) => {
    if (!isRecord(interrupt) || !isRecord(interrupt.value)) return false;
    if (
      typeof interrupt.id === "string" &&
      resolvedInterruptIds.has(interrupt.id)
    )
      return false;
    const actions = interrupt.value.actionRequests;
    return Array.isArray(actions) && actions.length > 0;
  });
  if (active.length === 0) return null;
  if (active.length !== 1) {
    throw new Error("Current approval state contains multiple interrupts.");
  }
  const interrupt = active[0];
  if (
    !isRecord(interrupt) ||
    typeof interrupt.id !== "string" ||
    !interrupt.id
  ) {
    throw new Error("Current approval interrupt does not have an ID.");
  }
  const value = interrupt.value;
  if (!isRecord(value) || !Array.isArray(value.actionRequests)) {
    throw new Error("Current approval interrupt contains invalid actions.");
  }

  const remaining = [...finalizedToolCalls];
  const requests = value.actionRequests.map((action) => {
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
  return { interruptId: interrupt.id, requests };
}

function flattenInterrupts(interrupts: unknown[]): unknown[] {
  return interrupts.flatMap((interrupt) =>
    Array.isArray(interrupt) ? flattenInterrupts(interrupt) : [interrupt],
  );
}

function isEquivalentJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
