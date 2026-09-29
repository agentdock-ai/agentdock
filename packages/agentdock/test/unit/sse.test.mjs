import assert from "node:assert/strict";
import { test } from "vitest";
import { EventContext } from "../../src/events/event-context.js";
import { encodeSseEvent, SSE_HEADERS } from "../../src/transports/sse.js";
import { AgentEventType } from "@agentdock-ai/contracts";

test("encodes an AgentEvent as one exact SSE data frame", () => {
  const event = new EventContext("run-1", 0).emit({
    type: AgentEventType.RunStarted,
  });

  assert.equal(encodeSseEvent(event), `data: ${JSON.stringify(event)}\n\n`);
});

test("exposes the required SSE response headers", () => {
  assert.deepEqual(SSE_HEADERS, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  });
});
