import type { AgentEvent } from "@agentdock-ai/contracts";

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
} as const;

export function encodeSseEvent(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
