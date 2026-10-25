import type { AgentEvent } from "@agentdock-ai/contracts";
export const SSE_HEARTBEAT = ": ping\n\n";
/** After an abort, wait this long for the source's terminal event before closing. */
export const ABORT_GRACE_MS = 5_000;

export function resolveHeartbeatMs(value = 15_000): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("heartbeatMs must be a non-negative safe integer.");
  return value;
}

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
} as const;

export function encodeSseEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function isTerminalEvent(event: AgentEvent): boolean {
  return (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  );
}
