import { isRecord } from "../utils/is-record.js";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

export interface ThreadSnapshot {
  values: unknown;
  next?: readonly string[];
  config?: LangGraphRunnableConfig;
  tasks?: readonly {
    name?: string;
    error?: unknown;
    interrupts?: readonly unknown[];
    state?: unknown;
  }[];
}

interface ReadableGraph {
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
  return snapshot;
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
