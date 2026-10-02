import {
  assertAgentInterrupt,
  type AgentInterrupt,
} from "@agentdock-ai/contracts";
import { z } from "zod";

function isAgentInterrupt(value: unknown): value is AgentInterrupt {
  try {
    assertAgentInterrupt(value);
    return true;
  } catch {
    return false;
  }
}

const pendingInterruptSchema = z.custom<AgentInterrupt>(isAgentInterrupt);

const eventStateShape = z
  .object({
    runId: z.string().min(1).optional(),
    logicalSequence: z.number().int().nonnegative().default(0),
    pendingInterrupt: pendingInterruptSchema.optional(),
  })
  .strict();

export type AgentEventState = z.infer<typeof eventStateShape>;

export const AGENT_EVENT_STATE_KEY = "agentEventState";

/** @deprecated Native tasks determine pending work; use an ordinary graph state schema. */
export function withAgentEventState<const Fields extends z.ZodRawShape>(
  fields: Fields &
    (typeof AGENT_EVENT_STATE_KEY extends keyof Fields ? never : unknown),
) {
  if (Object.prototype.hasOwnProperty.call(fields, AGENT_EVENT_STATE_KEY)) {
    throw new Error(`${AGENT_EVENT_STATE_KEY} is reserved by Agentdock.`);
  }
  return z.object({
    [AGENT_EVENT_STATE_KEY]: eventStateShape.default({ logicalSequence: 0 }),
    ...fields,
  });
}
