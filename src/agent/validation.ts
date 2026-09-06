import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolApprovalResponse,
} from "./permissions/types.js";
import type { AgentContext, RunAgentOptions } from "./types.js";
import type { AgentDockOptions } from "./agent-dock.js";
import type { CheckpointAdapter } from "@agentdock/checkpoint";
import { ToolRegistry } from "../tools/registry.js";
import { isRecord } from "./value.js";

export function assertDockOptions(
  options: unknown,
): asserts options is AgentDockOptions {
  if (!isRecord(options) || !isRecord(options.model)) {
    throw new Error("AgentDock requires a LangChain chat model.");
  }
  if (
    options.registry !== undefined &&
    !(options.registry instanceof ToolRegistry)
  ) {
    throw new Error("AgentDock registry must be a ToolRegistry instance.");
  }
  if (
    options.checkpointer !== undefined &&
    !isCheckpointSaver(options.checkpointer)
  ) {
    throw new Error("AgentDock checkpointer must be a LangGraph checkpointer.");
  }
  if (options.checkpoint !== undefined) {
    if (!isCheckpointAdapter(options.checkpoint)) {
      throw new Error(
        "AgentDock checkpoint must be a CheckpointAdapter instance.",
      );
    }
  }
  if (options.checkpoint !== undefined && options.checkpointer !== undefined) {
    throw new Error(
      "AgentDock checkpoint and checkpointer options cannot be used together.",
    );
  }
}

function isCheckpointAdapter(value: unknown): value is CheckpointAdapter {
  return (
    isRecord(value) &&
    isRecord(value.saver) &&
    typeof value.saver.getTuple === "function" &&
    typeof value.saver.list === "function" &&
    typeof value.saver.put === "function" &&
    typeof value.saver.putWrites === "function" &&
    typeof value.saver.deleteThread === "function" &&
    typeof value.initialize === "function" &&
    typeof value.close === "function"
  );
}

function isCheckpointSaver(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.getTuple === "function" &&
    typeof value.list === "function" &&
    typeof value.put === "function" &&
    typeof value.putWrites === "function" &&
    typeof value.deleteThread === "function"
  );
}

export function assertResumeInput(
  input: unknown,
): asserts input is { runId: string; approvals: ToolApprovalDecision[] } {
  if (!isRecord(input))
    throw new Error("Agent resume input must be an object.");
  assertNonEmptyString(input.runId, "Agent run ID");
  if (!Array.isArray(input.approvals))
    throw new Error("Approval decisions must be an array.");
}

export function assertContext(ctx: unknown): asserts ctx is AgentContext {
  if (!isRecord(ctx)) throw new Error("Agent context must be an object.");
}

export function assertRunOptions(
  options: unknown,
  requireSessionId: boolean,
): asserts options is RunAgentOptions {
  if (!isRecord(options))
    throw new Error("Agent run options must be an object.");
  assertOptionalString(options.runId, "Agent run ID");
  assertOptionalString(options.sessionId, "Agent session ID");
  assertOptionalString(options.systemPrompt, "Agent system prompt", false);
  if (requireSessionId)
    assertNonEmptyString(options.sessionId, "Agent session ID");
  if (
    options.maxSteps !== undefined &&
    (typeof options.maxSteps !== "number" ||
      !Number.isSafeInteger(options.maxSteps) ||
      options.maxSteps <= 0)
  ) {
    throw new Error("Agent maxSteps must be a positive integer.");
  }
  if (
    options.toolTimeout !== undefined &&
    (typeof options.toolTimeout !== "number" ||
      !Number.isFinite(options.toolTimeout) ||
      options.toolTimeout <= 0)
  ) {
    throw new Error("Agent toolTimeout must be a positive number.");
  }
  if (
    options.abortSignal !== undefined &&
    !isAbortSignal(options.abortSignal)
  ) {
    throw new Error("Agent abortSignal must be an AbortSignal.");
  }
}

export function validateApprovalDecisions(
  decisions: unknown,
  pending: ToolApprovalRequest[],
): ToolApprovalResponse[] {
  if (!Array.isArray(decisions))
    throw new Error("Approval decisions must be an array.");
  if (pending.length === 0 || decisions.length !== pending.length) {
    throw new Error("Approval decisions do not match a pending AgentDock run.");
  }

  const byId = new Map<string, ToolApprovalDecision>();
  for (const decision of decisions) {
    if (!isRecord(decision))
      throw new Error("Each approval decision must be an object.");
    assertNonEmptyString(decision.approvalId, "Approval ID");
    if (typeof decision.approved !== "boolean") {
      throw new Error("Approval decision approved must be a boolean.");
    }
    if (decision.reason !== undefined && typeof decision.reason !== "string") {
      throw new Error("Approval decision reason must be a string.");
    }
    if (byId.has(decision.approvalId)) {
      throw new Error("Approval decisions must use unique approval IDs.");
    }
    byId.set(decision.approvalId, {
      approvalId: decision.approvalId,
      approved: decision.approved,
      ...(typeof decision.reason === "string"
        ? { reason: decision.reason }
        : {}),
    });
  }

  return pending.map((request) => {
    const decision = byId.get(request.approvalId);
    if (!decision)
      throw new Error(
        "Approval decisions do not match a pending AgentDock run.",
      );
    return { ...decision, toolCall: request.toolCall };
  });
}

export function createSignal(
  controller: AbortController,
  signal: AbortSignal | undefined,
): AbortSignal {
  return signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;
}

export function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  assertOptionalString(value, label);
  if (value === undefined) throw new Error(`${label} is required.`);
}

function assertOptionalString(
  value: unknown,
  label: string,
  nonEmpty = true,
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || (nonEmpty && !value.trim())) {
    throw new Error(
      `${label} must be a${nonEmpty ? " non-empty" : ""} string.`,
    );
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function"
  );
}
