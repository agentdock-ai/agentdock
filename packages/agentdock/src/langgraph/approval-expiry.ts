import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { NativeControlGraph } from "./control-projection.js";
import {
  assertThreadSnapshot,
  normalizeSnapshot,
  type ThreadSnapshot,
} from "./thread-read.js";
import type { PendingDecision } from "./tool-approval-decisions.js";
import { isRecord } from "../utils/is-record.js";

export class ApprovalExpiredError extends Error {
  readonly status = 409;
  readonly code = "approval_expired";
  constructor() {
    super("This approval has expired. Reject it or request a new action.");
    this.name = "ApprovalExpiredError";
  }
}

function pendingTimestamp(
  snapshot: ThreadSnapshot,
  id: string,
  occurrence: number | undefined,
): string | undefined {
  for (const task of snapshot.tasks ?? []) {
    if (isRecord(task.state) && "values" in task.state) {
      assertThreadSnapshot(task.state);
      const timestamp = pendingTimestamp(task.state, id, occurrence);
      if (timestamp) return timestamp;
    }
    if (
      (task.resumeCount ?? 0) === (occurrence ?? 0) &&
      task.interrupts?.some((raw) => isRecord(raw) && raw.id === id)
    )
      return snapshot.createdAt;
  }
  return undefined;
}

export async function assertApprovalsFresh(
  decisions: readonly PendingDecision[],
  snapshot: ThreadSnapshot | undefined,
  graph: NativeControlGraph,
  config: LangGraphRunnableConfig,
  ttlMs: number,
): Promise<void> {
  const pending = new Map(
    decisions
      .filter((entry) => entry.decision.type !== "reject")
      .map((entry) => [entry.interrupt.interruptId, entry.interrupt]),
  );
  if (!pending.size) return;
  const timestamps = new Map<string, number>();
  for (const [id, interrupt] of pending) {
    const timestamp =
      snapshot && pendingTimestamp(snapshot, id, interrupt.occurrence);
    if (!timestamp || !Number.isFinite(Date.parse(timestamp)))
      throw new Error(
        "Cannot determine approval creation time from the native checkpoint.",
      );
    timestamps.set(id, Date.parse(timestamp));
  }
  // Walk contiguous pending checkpoints so another branch cannot renew an old approval.
  if (graph.getStateHistory) {
    const historyConfig = {
      ...config,
      configurable: { ...config.configurable },
    };
    delete historyConfig.configurable.checkpoint_id;
    const searching = new Map(pending);
    for await (const raw of graph.getStateHistory(historyConfig)) {
      const candidate = await normalizeSnapshot(graph, raw);
      for (const [id, interrupt] of searching) {
        const timestamp = pendingTimestamp(candidate, id, interrupt.occurrence);
        if (!timestamp) searching.delete(id);
        else {
          const at = Date.parse(timestamp);
          if (!Number.isFinite(at))
            throw new Error("Native approval checkpoint timestamp is invalid.");
          timestamps.set(id, Math.min(timestamps.get(id) ?? at, at));
        }
      }
      if (!searching.size) break;
    }
  }
  if ([...timestamps.values()].some((at) => Date.now() - at >= ttlMs))
    throw new ApprovalExpiredError();
}
