import {
  AGENT_EVENT_PROTOCOL_VERSION,
  createAgentReducerState,
  type AgentReducerState,
  type AgentInterrupt,
} from "@agentdock-ai/contracts";
import { WireEventMapper } from "../events/from-langgraph.js";
import { EventContext } from "../events/event-context.js";
import { isRecord } from "../utils/is-record.js";
import { assertThreadSnapshot, type ThreadSnapshot } from "./thread-read.js";

export type CreateResumeStateResult =
  | { status: "ready"; state: AgentReducerState }
  | { status: "no_pending_interrupt" }
  | { status: "invalid_checkpoint" };

/** Native task interrupts are the execution authority; this helper never writes. */
interface PendingNativeInterrupt {
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
      if (!pending.some((item) => isRecord(item.raw) && item.raw.id === raw.id))
        pending.push({ raw, snapshot, occurrence: task.resumeCount });
    }
  }
  return pending;
}

export function nativeInterrupts(snapshot: ThreadSnapshot): unknown[] {
  return pendingNative(snapshot).map((item) => item.raw);
}

export function mapSnapshotInterrupts(
  snapshot: ThreadSnapshot,
  interruptFormat: "opaque" | "langchain-hitl" = "opaque",
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
    for (const event of mapper.map("updates", {
      __interrupt__: [pending.raw],
    })) {
      if (event.type === "interrupt.required") {
        if (pending.occurrence !== undefined)
          event.interrupt.occurrence = pending.occurrence;
        interrupts.set(event.interrupt.interruptId, event.interrupt);
      }
    }
  }
  return [...interrupts.values()];
}

export function createResumeState(
  snapshot: ThreadSnapshot,
  threadId: string,
  interruptFormat: "opaque" | "langchain-hitl" = "opaque",
): CreateResumeStateResult {
  if (typeof threadId !== "string" || !threadId.trim())
    throw new Error("threadId must be a non-empty string.");
  try {
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
