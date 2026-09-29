import {
  assertAgentInterrupt,
  cloneJsonValue,
  type AgentInterrupt,
} from "@agentdock-ai/contracts";
import { z } from "zod";
import { isRecord } from "../utils/is-record.js";

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

export type AgentEventStateReadResult =
  | { status: "valid"; state: AgentEventState }
  | { status: "missing" }
  | { status: "invalid" };

/** Adds Agentdock's checkpoint state to fields supplied by the application. */
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

export function parsePendingInterrupt(value: unknown): AgentInterrupt | null {
  if (!isAgentInterrupt(value)) return null;
  return cloneJsonValue(
    value,
    "Checkpoint pending interrupt",
  ) as unknown as AgentInterrupt;
}

export function parseAgentEventState(
  values: unknown,
): AgentEventStateReadResult {
  if (
    !isRecord(values) ||
    !Object.prototype.hasOwnProperty.call(values, AGENT_EVENT_STATE_KEY)
  ) {
    return { status: "missing" };
  }

  const rawState = values[AGENT_EVENT_STATE_KEY];
  if (!isRecord(rawState)) return { status: "invalid" };
  const parsed = eventStateShape.safeParse(rawState);
  if (!parsed.success) return { status: "invalid" };

  const state = parsed.data;
  if (state.pendingInterrupt === undefined) {
    return { status: "valid", state };
  }
  if (!state.runId || state.logicalSequence < 1) {
    return { status: "invalid" };
  }

  const pendingInterrupt = parsePendingInterrupt(state.pendingInterrupt);
  if (!pendingInterrupt) return { status: "invalid" };
  return { status: "valid", state: { ...state, pendingInterrupt } };
}
