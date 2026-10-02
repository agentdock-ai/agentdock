import { isRecord } from "../utils/is-record.js";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

export interface ThreadSnapshot {
  values: unknown;
  next?: readonly string[];
  config?: LangGraphRunnableConfig;
  tasks?: readonly {
    id?: string;
    name?: string;
    result?: unknown;
    resumeCount?: number;
    error?: unknown;
    interrupts?: readonly unknown[];
    state?: unknown;
  }[];
}

export interface ReadableGraph {
  checkpointer?: unknown;
  getState(
    config: LangGraphRunnableConfig,
    options?: { subgraphs?: boolean },
  ): Promise<ThreadSnapshot>;
}

export async function getThreadSnapshot(
  graph: ReadableGraph,
  threadId: string,
  config: Omit<LangGraphRunnableConfig, "context" | "signal"> = {},
): Promise<ThreadSnapshot | null> {
  if (typeof threadId !== "string" || !threadId.trim())
    throw new Error("threadId must be a non-empty string.");
  const snapshot = await graph.getState(
    {
      ...config,
      configurable: { ...config.configurable, thread_id: threadId },
    },
    { subgraphs: true },
  );
  if (
    (!isRecord(snapshot.values) || Object.keys(snapshot.values).length === 0) &&
    !snapshot.tasks?.length &&
    !snapshot.next?.length
  ) {
    return null;
  }
  return normalizeSnapshot(graph, snapshot);
}

export async function getThreadMessages(
  graph: ReadableGraph,
  threadId: string,
  options: { channel?: string; config?: LangGraphRunnableConfig } = {},
): Promise<unknown[] | null> {
  const snapshot = await getThreadSnapshot(graph, threadId, options.config);
  if (!snapshot) return null;
  const channel = options.channel ?? "messages";
  if (!isRecord(snapshot.values)) return null;
  const messages = snapshot.values[channel];
  if (messages === undefined) return [];
  if (!Array.isArray(messages)) {
    throw new Error(`Thread state channel "${channel}" is not an array.`);
  }
  return messages;
}

/** Read native pending writes to distinguish task results from retained interrupt records. */
export async function normalizeSnapshot(
  graph: ReadableGraph,
  snapshot: ThreadSnapshot,
): Promise<ThreadSnapshot> {
  assertThreadSnapshot(snapshot);
  if (snapshot.tasks === undefined) return snapshot;
  const saver = graph.checkpointer;
  const completed = new Set<string>();
  const resumeCounts = new Map<string, number>();
  const canReadWrites =
    isCheckpointReader(saver) && snapshot.config !== undefined;
  if (isCheckpointReader(saver) && snapshot.config) {
    const saved = await saver.getTuple(snapshot.config);
    for (const [id, channel, value] of saved?.pendingWrites ?? []) {
      if (channel === "__resume__" && Array.isArray(value))
        resumeCounts.set(id, value.length);
      // These are native control writes, not a task's successful result.
      if (
        ![
          "__interrupt__",
          "__resume__",
          "__error__",
          "__error_source_node__",
          "__scheduled__",
        ].includes(channel)
      )
        completed.add(id);
    }
  }
  const tasks: NonNullable<ThreadSnapshot["tasks"]>[number][] = [];
  for (const task of snapshot.tasks ?? []) {
    if (task.id && completed.has(task.id)) continue;
    if (task.result !== undefined && !task.error) continue;
    let state = task.state;
    if (isRecord(state) && "values" in state) {
      assertThreadSnapshot(state);
      state = await normalizeSnapshot(graph, state);
    }
    const normalized = { ...task, state };
    if (canReadWrites && task.id)
      normalized.resumeCount = resumeCounts.get(task.id) ?? 0;
    tasks.push(normalized);
  }
  const result = { ...snapshot, tasks };
  if (
    snapshot.tasks.length &&
    snapshot.tasks.every((task) => typeof task.name === "string")
  )
    result.next = tasks.flatMap((task) =>
      typeof task.name === "string" ? [task.name] : [],
    );
  return result;
}
interface CheckpointReader {
  getTuple(config: LangGraphRunnableConfig): Promise<
    | {
        pendingWrites?: readonly (readonly [string, string, unknown])[];
      }
    | undefined
  >;
}
function isCheckpointReader(value: unknown): value is CheckpointReader {
  return isRecord(value) && typeof value.getTuple === "function";
}

export function assertThreadSnapshot(
  value: unknown,
): asserts value is ThreadSnapshot {
  if (!isRecord(value) || !("values" in value))
    throw new Error("Checkpoint contains invalid native state.");
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
          (task.id === undefined || typeof task.id === "string") &&
          (task.name === undefined || typeof task.name === "string") &&
          (task.interrupts === undefined || Array.isArray(task.interrupts)),
      ))
  )
    throw new Error("Checkpoint contains invalid native tasks.");
  if (value.config !== undefined && !isRecord(value.config))
    throw new Error("Checkpoint contains invalid configuration.");
}
