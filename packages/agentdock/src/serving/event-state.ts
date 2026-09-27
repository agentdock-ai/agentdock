import { StateSchema } from "@langchain/langgraph";
import { z } from "zod";

const eventStateShape = z.object({
  runId: z.string().optional(),
  logicalSequence: z.number().int().nonnegative().default(0),
  pendingInterruptId: z.string().optional(),
});

export const agentEventStateSchema = new StateSchema({
  agentdockEventState: eventStateShape.default({ logicalSequence: 0 }),
});

export type AgentEventState = z.infer<typeof eventStateShape>;

export const AGENT_EVENT_STATE_KEY = "agentdockEventState";

export function readAgentEventState(value: unknown): AgentEventState | null {
  if (!isRecord(value) || !(AGENT_EVENT_STATE_KEY in value)) return null;
  const parsed = eventStateShape.safeParse(value[AGENT_EVENT_STATE_KEY]);
  return parsed.success ? parsed.data : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
