import {
  AgentEventType,
  cloneJsonValue,
  type AgentEvent,
  type AgentInterrupt,
  type JsonValue,
} from "@agentdock-ai/contracts";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { EventContext } from "../events/event-context.js";
import { isRecord } from "../utils/is-record.js";
import {
  normalizeSnapshot,
  type ReadableGraph,
  type ThreadSnapshot,
} from "./thread-read.js";
export interface NativeControlGraph extends ReadableGraph {
  getStateHistory?(
    config: LangGraphRunnableConfig,
  ): AsyncIterable<ThreadSnapshot>;
}

export async function readControlSnapshot(
  graph: NativeControlGraph,
  config: LangGraphRunnableConfig,
): Promise<ThreadSnapshot | undefined> {
  try {
    return await normalizeSnapshot(
      graph,
      await graph.getState(config, { subgraphs: true }),
    );
  } catch (error) {
    if (isRecord(error) && error.lc_error_code === "MISSING_CHECKPOINTER")
      return undefined;
    throw error;
  }
}
export async function readFailureSnapshot(
  graph: NativeControlGraph,
  config: LangGraphRunnableConfig,
  taskIds: Set<string>,
): Promise<ThreadSnapshot | undefined> {
  const snapshot = await readControlSnapshot(graph, config);
  if (
    !snapshot ||
    !taskIds.size ||
    snapshot.tasks?.some((task) => task.id && taskIds.has(task.id)) ||
    !graph.getStateHistory
  )
    return snapshot;
  // Cancellation can stop the reader before a checkpoint event arrives. Locate
  // the checkpoint containing the observed native task IDs, not a thread head.
  const configurable = { ...config.configurable };
  delete configurable.checkpoint_id;
  for await (const candidate of graph.getStateHistory({
    ...config,
    configurable,
  }))
    if (candidate.tasks?.some((task) => task.id && taskIds.has(task.id)))
      return normalizeSnapshot(graph, candidate);
  return snapshot;
}
export function reconcileInterrupts(
  context: EventContext,
  pending: AgentInterrupt[],
  current: AgentInterrupt[],
  resume: unknown,
  raised: Set<string>,
  next: readonly string[] = [],
): AgentEvent[] {
  const events: AgentEvent[] = [];
  const resolved = new Set<string>();
  for (const prior of pending) {
    const active = current.find(
      (item) => item.interruptId === prior.interruptId,
    );
    const addressed =
      resume !== undefined &&
      (pending.length === 1 ||
        (isRecord(resume) &&
          Object.prototype.hasOwnProperty.call(resume, prior.interruptId)));
    let replaced = addressed && raised.has(prior.interruptId);
    if (active?.occurrence !== undefined && prior.occurrence !== undefined)
      replaced = active.occurrence > prior.occurrence;
    if (active && !replaced) continue;
    resolved.add(prior.interruptId);
    events.push(
      context.emit({
        type: AgentEventType.InterruptResolved,
        interruptId: prior.interruptId,
        decisions: resumeDecisions(
          resume,
          prior.interruptId,
          pending.length,
          prior.kind,
        ),
      }),
    );
  }
  if (current.length || next.length)
    events.push(
      context.emit({ type: AgentEventType.RunPaused, next: [...next] }),
    );
  for (const interrupt of current) {
    if (
      pending.some((item) => item.interruptId === interrupt.interruptId) &&
      !resolved.has(interrupt.interruptId)
    )
      continue;
    events.push(
      context.emit({ type: AgentEventType.InterruptRequired, interrupt }),
    );
  }
  return events;
}
function resumeDecisions(
  value: unknown,
  id: string,
  count: number,
  kind: AgentInterrupt["kind"],
): JsonValue[] {
  if (value === undefined) return [];
  let response: unknown = value;
  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, id))
    response = value[id];
  else if (count > 1) return [];
  if (
    kind === "tool-approval" &&
    isRecord(response) &&
    Array.isArray(response.decisions)
  )
    return response.decisions.map((item) => cloneJsonValue(item));
  return [cloneJsonValue(response)];
}
