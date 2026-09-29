import {
  AGENT_EVENT_PROTOCOL_VERSION,
  createAgentReducerState,
  type AgentReducerState,
} from "@agentdock-ai/contracts";
import { parseAgentEventState } from "./event-state.js";

export type CreateResumeStateResult =
  | { status: "ready"; state: AgentReducerState }
  | { status: "no_pending_interrupt" }
  | { status: "legacy_checkpoint"; interruptId: string }
  | { status: "invalid_checkpoint" };

/** Builds reducer control state for a new client from a graph checkpoint. */
export function createResumeState(
  values: unknown,
  sessionId?: string,
): CreateResumeStateResult {
  if (sessionId !== undefined && !sessionId.trim()) {
    return { status: "invalid_checkpoint" };
  }
  const result = parseAgentEventState(values);
  if (result.status !== "valid") return { status: "invalid_checkpoint" };
  if (result.interruptStatus === "none") {
    return { status: "no_pending_interrupt" };
  }
  if (result.interruptStatus === "legacy") {
    const interruptId = result.state.pendingInterruptId;
    return interruptId
      ? { status: "legacy_checkpoint", interruptId }
      : { status: "invalid_checkpoint" };
  }

  const { runId, logicalSequence, pendingInterrupt } = result.state;
  if (!runId || !pendingInterrupt) return { status: "invalid_checkpoint" };

  return {
    status: "ready",
    state: {
      ...createAgentReducerState(),
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      runId,
      sessionId: sessionId ?? null,
      status: "waiting",
      interrupt: pendingInterrupt,
      lastLogicalSequence: logicalSequence,
    },
  };
}
