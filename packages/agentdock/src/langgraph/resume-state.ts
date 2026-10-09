import {
  AGENT_EVENT_PROTOCOL_VERSION,
  createAgentReducerState,
  type AgentReducerState,
  type AgentInterrupt,
} from "@agentdock-ai/contracts";
import { WireEventMapper } from "../events/from-langgraph.js";
import { EventContext } from "../events/event-context.js";
import type { InterruptFormat } from "../agentdock.js";
import { isRecord } from "../utils/is-record.js";
import { assertThreadSnapshot, type ThreadSnapshot } from "./thread-read.js";

export type CreateResumeStateResult =
  | { status: "ready"; state: AgentReducerState }
  | { status: "no_pending_interrupt" }
  | { status: "invalid_checkpoint" };

/** Native task interrupts are the execution authority; this helper never writes. */
interface PendingNativeInterrupt {
  id: string;
  raw: unknown;
  snapshot: ThreadSnapshot;
  occurrence?: number;
}

function pendingNative(snapshot: ThreadSnapshot): PendingNativeInterrupt[] {
  const pending: PendingNativeInterrupt[] = [];
  for (const task of snapshot.tasks ?? []) {
    if (isRecord(task.state) && "values" in task.state) {
      pending.push(...pendingNative(toNestedSnapshot(task.state)));
    }
    for (const raw of task.interrupts ?? []) {
      if (!isRecord(raw) || typeof raw.id !== "string")
        throw new Error("Checkpoint contains an invalid native interrupt.");
      if (!pending.some((item) => item.id === raw.id))
        pending.push({
          id: raw.id,
          raw,
          snapshot,
          occurrence: task.resumeCount,
        });
    }
  }
  return pending;
}

export function mapSnapshotInterrupts(
  snapshot: ThreadSnapshot,
  interruptFormat: InterruptFormat = "opaque",
): AgentInterrupt[] {
  const interrupts = new Map<string, AgentInterrupt>();
  for (const pending of pendingNative(snapshot)) {
    const ns = pending.snapshot.config?.configurable?.checkpoint_ns;
    const namespace = typeof ns === "string" && ns ? ns.split("|") : [];
    const mapper = new WireEventMapper(
      new EventContext(crypto.randomUUID(), 0),
      namespace,
      interruptFormat,
    );
    mapper.seedMessages(pending.snapshot.values);
    const interrupt = mapper.projectInterrupt(pending.raw);
    if (pending.occurrence !== undefined)
      interrupt.occurrence = pending.occurrence;
    interrupts.set(interrupt.interruptId, interrupt);
  }
  return [...interrupts.values()];
}

export function createResumeState(
  snapshot: ThreadSnapshot,
  threadId: string,
  interruptFormat: InterruptFormat = "opaque",
): CreateResumeStateResult {
  if (typeof threadId !== "string" || !threadId.trim())
    throw new Error("threadId must be a non-empty string.");
  try {
    assertThreadSnapshot(snapshot);
    const interrupts = mapSnapshotInterrupts(snapshot, interruptFormat);
    const pausedNodes = [...(snapshot.next ?? [])];
    if (interrupts.length === 0 && pausedNodes.length === 0)
      return { status: "no_pending_interrupt" };
    return {
      status: "ready",
      state: {
        ...createAgentReducerState(),
        protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
        threadId,
        status: "waiting",
        interrupts,
        interrupt: interrupts[0] ?? null,
        pausedNodes,
      },
    };
  } catch {
    return { status: "invalid_checkpoint" };
  }
}

function toNestedSnapshot(value: Record<string, unknown>): ThreadSnapshot {
  assertThreadSnapshot(value);
  return value;
}
