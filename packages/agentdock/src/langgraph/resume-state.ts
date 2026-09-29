import {
  AGENT_EVENT_PROTOCOL_VERSION,
  createAgentReducerState,
  type AgentReducerState,
} from "@agentdock-ai/contracts";
import { parseAgentEventState } from "./event-state.js";

export type CreateResumeStateResult =
  | { status: "ready"; state: AgentReducerState }
  | { status: "no_pending_interrupt" }
  | { status: "invalid_checkpoint" };

/** Builds reducer control state for a new client from a graph checkpoint. */
export function createResumeState(
  values: unknown,
  threadId: string,
): CreateResumeStateResult {
  if (!threadId.trim()) {
    throw new Error("threadId must be a non-empty string.");
  }
  const result = parseAgentEventState(values);
  if (result.status !== "valid") return { status: "invalid_checkpoint" };
  if (!result.state.pendingInterrupt) return { status: "no_pending_interrupt" };

  const { runId, logicalSequence, pendingInterrupt } = result.state;
  if (!runId || !pendingInterrupt) return { status: "invalid_checkpoint" };

  return {
    status: "ready",
    state: {
      ...createAgentReducerState(),
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      runId,
      threadId,
      status: "waiting",
      interrupt: pendingInterrupt,
      lastLogicalSequence: logicalSequence,
    },
  };
}
