import { isRecord } from "../utils/is-record.js";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

export interface ThreadSnapshot {
  values: unknown;
}

interface ReadableGraph {
  getState(config: LangGraphRunnableConfig): Promise<{ values: unknown }>;
}

export async function getThreadSnapshot(
  graph: ReadableGraph,
  threadId: string,
): Promise<ThreadSnapshot | null> {
  const snapshot = await graph.getState({
    configurable: { thread_id: threadId },
  });
  if (!isRecord(snapshot.values) || Object.keys(snapshot.values).length === 0) {
    return null;
  }
  return { values: snapshot.values };
}

export async function getThreadMessages(
  graph: ReadableGraph,
  threadId: string,
  options: { channel?: string } = {},
): Promise<unknown[] | null> {
  const snapshot = await getThreadSnapshot(graph, threadId);
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
