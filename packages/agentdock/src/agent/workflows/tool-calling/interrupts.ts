import type { ToolApprovalRequest } from "../../permissions/types.js";
import type { ToolCallRecord } from "../../types.js";
import { isRecord } from "../../value.js";

export const AGENTDOCK_APPROVAL_INTERRUPT_PROTOCOL =
  "agentdock.tool-approval.v1" as const;

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
  const taskInterrupts = Array.isArray(state.tasks)
    ? state.tasks.flatMap((task) => {
        if (!isRecord(task) || !Array.isArray(task.interrupts)) return [];
        return task.interrupts;
      })
    : [];
  const interrupts =
    taskInterrupts.length > 0
      ? taskInterrupts
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
    return (
      interrupt.value.agentdockApprovalProtocol ===
        AGENTDOCK_APPROVAL_INTERRUPT_PROTOCOL ||
      (Array.isArray(interrupt.value.actionRequests) &&
        Array.isArray(interrupt.value.reviewConfigs)) ||
      (isRecord(interrupt.value.resume) &&
        Array.isArray(interrupt.value.resume.actionRequests) &&
        Array.isArray(interrupt.value.resume.reviewConfigs))
    );
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
  if (!isRecord(value)) {
    throw new Error("Current approval interrupt contains invalid data.");
  }
  if (
    value.agentdockApprovalProtocol !== AGENTDOCK_APPROVAL_INTERRUPT_PROTOCOL
  ) {
    throw new Error(
      "This session has a pending approval from the legacy HITL flow and cannot be resumed. Resolve it before upgrading or start a new session.",
    );
  }
  if (!Array.isArray(value.actionRequests)) {
    throw new Error("Current approval interrupt contains invalid actions.");
  }

  const callsById = new Map(
    finalizedToolCalls.map((toolCall) => [toolCall.toolCallId, toolCall]),
  );
  const seenApprovalIds = new Set<string>();
  const seenToolCallIds = new Set<string>();
  const requests = value.actionRequests.map((action) => {
    if (
      !isRecord(action) ||
      typeof action.id !== "string" ||
      action.id.length === 0 ||
      typeof action.name !== "string" ||
      typeof action.toolCallId !== "string" ||
      action.toolCallId.length === 0 ||
      !isRecord(action.args)
    ) {
      throw new Error(
        "Current approval interrupt contains an action without exact tool-call identity.",
      );
    }
    if (seenApprovalIds.has(action.id)) {
      throw new Error(
        "Current approval interrupt contains duplicate action IDs.",
      );
    }
    if (seenToolCallIds.has(action.toolCallId)) {
      throw new Error(
        "Current approval interrupt contains duplicate toolCallIds.",
      );
    }
    seenApprovalIds.add(action.id);
    seenToolCallIds.add(action.toolCallId);

    const toolCall = callsById.get(action.toolCallId);
    if (!toolCall) {
      throw new Error(
        `Current approval interrupt references an unknown toolCallId: ${action.toolCallId}`,
      );
    }
    if (
      toolCall.name !== action.name ||
      !isEquivalentJson(toolCall.input, action.args)
    ) {
      throw new Error(
        `Current approval interrupt toolCallId does not match action ${action.name}.`,
      );
    }
    return { approvalId: action.id, toolCall };
  });
  if (requests.length === 0) {
    throw new Error("Current approval interrupt does not contain any actions.");
  }
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
