import {
  assertAgentInterrupt,
  cloneJsonValue,
  type AgentInterrupt,
} from "@agentdock-ai/contracts";
import { isRecord } from "../utils/is-record.js";
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

const eventStateShape = z.object({
  runId: z.string().min(1).optional(),
  logicalSequence: z.number().int().nonnegative().default(0),
  pendingInterruptId: z.string().min(1).optional(),
  pendingInterrupt: pendingInterruptSchema.optional(),
});

export const agentEventStateSchema = z.object({
  agentdockEventState: eventStateShape.default({ logicalSequence: 0 }),
});

export type AgentEventState = z.infer<typeof eventStateShape>;

export const AGENT_EVENT_STATE_KEY = "agentdockEventState";

export type AgentEventStateReadResult =
  | {
      status: "valid";
      state: AgentEventState;
      interruptStatus: "none" | "legacy" | "complete";
    }
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
  value: unknown,
): AgentEventStateReadResult {
  if (!isRecord(value) || !(AGENT_EVENT_STATE_KEY in value)) {
    return { status: "missing" };
  }

  const rawState = value[AGENT_EVENT_STATE_KEY];
  if (!isRecord(rawState)) return { status: "invalid" };
  const parsed = eventStateShape.safeParse(rawState);
  if (!parsed.success) return { status: "invalid" };

  const state = parsed.data;
  const hasPendingInterrupt = Object.prototype.hasOwnProperty.call(
    rawState,
    "pendingInterrupt",
  );
  const hasPendingInterruptId = state.pendingInterruptId !== undefined;

  if (!hasPendingInterrupt && !hasPendingInterruptId) {
    return {
      status: "valid",
      state,
      interruptStatus: "none",
    };
  }

  if (!state.runId || !hasPendingInterruptId || state.logicalSequence < 1) {
    return { status: "invalid" };
  }

  if (!hasPendingInterrupt) {
    return {
      status: "valid",
      state,
      interruptStatus: "legacy",
    };
  }

  const pendingInterrupt = parsePendingInterrupt(rawState.pendingInterrupt);
  if (
    !pendingInterrupt ||
    pendingInterrupt.interruptId !== state.pendingInterruptId
  ) {
    return { status: "invalid" };
  }

  return {
    status: "valid",
    state: { ...state, pendingInterrupt },
    interruptStatus: "complete",
  };
}

export function readAgentEventState(value: unknown): AgentEventState | null {
  const result = parseAgentEventState(value);
  return result.status === "valid" ? result.state : null;
}
