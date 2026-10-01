import {
  AGENT_EVENT_PROTOCOL_VERSION,
  createAgentReducerState,
  type AgentReducerState,
  type AgentInterrupt,
} from "@agentdock-ai/contracts";
import { WireEventMapper } from "../events/from-langgraph.js";
import { EventContext } from "../events/event-context.js";
import { isRecord } from "../utils/is-record.js";
import type { ThreadSnapshot } from "./thread-read.js";

export type CreateResumeStateResult =
  | { status: "ready"; state: AgentReducerState }
  | { status: "no_pending_interrupt" }
  | { status: "invalid_checkpoint" };

/** Native task interrupts are the execution authority; this helper never writes. */
interface PendingNativeInterrupt {
  raw: unknown;
  snapshot: ThreadSnapshot;
}

function pendingNative(snapshot: ThreadSnapshot): PendingNativeInterrupt[] {
  const pending: PendingNativeInterrupt[] = [];
  for (const task of snapshot.tasks ?? []) {
    if (
      snapshot.next &&
      task.name &&
      !snapshot.next.includes(task.name) &&
      !task.error
    )
      continue;
    if (isRecord(task.state) && "values" in task.state) {
      pending.push(...pendingNative(toNestedSnapshot(task.state)));
    }
    for (const raw of task.interrupts ?? []) {
      if (!isRecord(raw) || typeof raw.id !== "string")
        throw new Error("Checkpoint contains an invalid native interrupt.");
      if (!pending.some((item) => isRecord(item.raw) && item.raw.id === raw.id))
        pending.push({ raw, snapshot });
    }
  }
  return pending;
}

export function nativeInterrupts(snapshot: ThreadSnapshot): unknown[] {
  return pendingNative(snapshot).map((item) => item.raw);
}

export function mapSnapshotInterrupts(
  snapshot: ThreadSnapshot,
): AgentInterrupt[] {
  const interrupts = new Map<string, AgentInterrupt>();
  for (const pending of pendingNative(snapshot)) {
    const ns = pending.snapshot.config?.configurable?.checkpoint_ns;
    const namespace = typeof ns === "string" && ns ? ns.split("|") : [];
    const mapper = new WireEventMapper(
      new EventContext(crypto.randomUUID(), 0),
      namespace,
    );
    mapper.seedMessages(pending.snapshot.values);
    for (const event of mapper.map("updates", {
      __interrupt__: [pending.raw],
    })) {
      if (event.type === "interrupt.required")
        interrupts.set(event.interrupt.interruptId, event.interrupt);
    }
  }
  return [...interrupts.values()];
}

export function createResumeState(
  snapshot: ThreadSnapshot,
  threadId: string,
): CreateResumeStateResult {
  if (typeof threadId !== "string" || !threadId.trim())
    throw new Error("threadId must be a non-empty string.");
  try {
    const interrupts = mapSnapshotInterrupts(snapshot);
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
  if (
    value.next !== undefined &&
    (!Array.isArray(value.next) ||
      !value.next.every((node) => typeof node === "string"))
  )
    throw new Error("Checkpoint contains invalid pending nodes.");
  if (
    value.tasks !== undefined &&
    (!Array.isArray(value.tasks) ||
      !value.tasks.every(
        (task) =>
          isRecord(task) &&
          (task.interrupts === undefined || Array.isArray(task.interrupts)),
      ))
  )
    throw new Error("Checkpoint contains invalid native tasks.");
  if (value.config !== undefined && !isRecord(value.config))
    throw new Error("Checkpoint contains invalid configuration.");
  return value as unknown as ThreadSnapshot;
}
