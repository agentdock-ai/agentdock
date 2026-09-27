import { StateSchema } from "@langchain/langgraph";
import { z } from "zod";

export const agentEventStateSchema = new StateSchema({
  agentdockEventState: z
    .object({
      runId: z.string().optional(),
      logicalSequence: z.number().int().nonnegative().default(0),
      pendingInterruptId: z.string().optional(),
    })
    .default({ logicalSequence: 0 }),
});

export type AgentEventState = typeof agentEventStateSchema.State;

export const AGENT_EVENT_STATE_KEY = "agentdockEventState";

export function readAgentEventState(value: unknown): AgentEventState | null {
  if (!isRecord(value) || !(AGENT_EVENT_STATE_KEY in value)) return null;
  const parsed = agentEventStateSchema.safeParse({
    [AGENT_EVENT_STATE_KEY]: value[AGENT_EVENT_STATE_KEY],
  });
  return parsed.success ? parsed.data : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
