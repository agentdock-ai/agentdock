import { StateSchema } from "@langchain/langgraph";
import { z } from "zod";

/**
 * Optional LangGraph state extension used to carry AgentEvent identity across
 * interrupt/resume requests. Compose its fields into a graph's state schema
 * when serving that graph through AgentDock's compatibility mapper.
 */
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
