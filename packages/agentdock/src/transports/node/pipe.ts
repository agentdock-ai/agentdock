import {
  AGENT_EVENT_PROTOCOL_VERSION,
  AgentEventType,
  type AgentEvent,
} from "@agentdock-ai/contracts";
import { closeIterator } from "../../utils/close-iterator.js";
import { createAbortScope } from "../../signals/abort-scope.js";
import {
  ABORT_GRACE_MS,
  encodeSseEvent,
  SSE_HEADERS,
  SSE_HEARTBEAT,
  isTerminalEvent,
} from "../sse.js";
import { SseReader } from "../sse-reader.js";
import type { NodeSseResponse, Run } from "../../serving/types.js";

type WaitResult = "drain" | "close" | "abort" | "timeout";

export async function pipeEvents<
  TInput,
  TContext extends Record<string, unknown>,
>(
  response: NodeSseResponse,
  run: Run<TInput, TContext>,
  source: (run: Run<TInput, TContext>) => AsyncIterable<AgentEvent>,
  heartbeatMs = 15_000,
  options: {
    drainTimeoutMs?: number;
    onStall?: (error: Error, event: AgentEvent) => void;
  } = {},
): Promise<void> {
  const abortScope = createAbortScope(run.signal);
  // Preserve the start/resume discriminator while replacing only the signal.
  const streamRun: Run<TInput, TContext> = {
    ...run,
    signal: abortScope.signal,
  };
  let iterator: AsyncIterator<AgentEvent> | undefined;
  let reader: SseReader<AgentEvent> | undefined;
  let headersSent = false;
  let terminalSent = false;
  let disconnected = response.destroyed;
  let lastEvent: AgentEvent | undefined;
  // Reads stop only when the transport gives up, so an aborted source can
  // still deliver its terminal event.
  const stop = new AbortController();
  let grace: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    grace = setTimeout(() => stop.abort(), ABORT_GRACE_MS);
  };
  abortScope.signal.addEventListener("abort", onAbort, { once: true });
  if (abortScope.signal.aborted) onAbort();

  const onClose = () => {
    if (!response.writableEnded) {
      disconnected = true;
      stop.abort();
      abortScope.abort(new Error("Client disconnected."));
    }
  };
  response.on("close", onClose);

  const writeFrame = async (
    frame: string,
    event?: AgentEvent,
  ): Promise<boolean> => {
    if (disconnected || response.destroyed || response.writableEnded)
      return false;
    const writable = response.write(frame);
    if (event) {
      lastEvent = event;
      if (isTerminalEvent(event)) terminalSent = true;
    }
    if (writable) return true;
    const outcome = await waitForDrain(
      response,
      stop.signal,
      options.drainTimeoutMs ?? 60_000,
    );
    if (outcome === "timeout") {
      const error = new Error("Client stopped reading.");
      abortScope.abort(error);
      try {
        if (lastEvent) options.onStall?.(error, lastEvent);
      } catch {
        // Diagnostics must not prevent cleanup.
      }
      response.destroy();
    }
    return outcome === "drain" && !disconnected;
  };
  const writeEvent = (event: AgentEvent) =>
    writeFrame(encodeSseEvent(event), event);

  try {
    iterator = source(streamRun)[Symbol.asyncIterator]();
    // Let validation and resume-state lookup fail before committing HTTP 200.
    const first = await iterator.next();
    reader = new SseReader(iterator, heartbeatMs, stop.signal);
    if (disconnected || response.destroyed) return;
    response.writeHead(200, { ...SSE_HEADERS });
    headersSent = true;
    if (first.done || !(await writeEvent(first.value))) return;

    while (!disconnected && !terminalSent) {
      const next = await reader.next();
      if (next === null) {
        if (!(await writeFrame(SSE_HEARTBEAT))) break;
        continue;
      }
      if (next.done) break;
      if (!(await writeEvent(next.value))) break;
    }
  } catch (error) {
    if (
      !headersSent ||
      disconnected ||
      response.destroyed ||
      response.writableEnded ||
      !lastEvent
    ) {
      throw error;
    }
    if (!terminalSent) {
      const failure = transportFailureEvent(lastEvent);
      await writeEvent(failure);
    }
  } finally {
    clearTimeout(grace);
    abortScope.signal.removeEventListener("abort", onAbort);
    stop.abort();
    reader?.dispose();
    if (!terminalSent || disconnected) {
      abortScope.abort(new Error("Response stream closed."));
    }
    response.off("close", onClose);
    abortScope.dispose();
    try {
      if (headersSent && !response.destroyed && !response.writableEnded)
        response.end();
    } finally {
      await closeIterator(iterator);
    }
  }
}

function waitForDrain(
  response: NodeSseResponse,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<WaitResult> {
  if (response.destroyed || response.writableEnded)
    return Promise.resolve("close");
  if (signal.aborted) return Promise.resolve("abort");

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: WaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.off("drain", onDrain);
      response.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onDrain = () => finish("drain");
    const onClose = () => finish("close");
    const onAbort = () => finish("abort");
    response.on("drain", onDrain);
    response.on("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

function transportFailureEvent(previous: AgentEvent): AgentEvent {
  return {
    protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
    eventId: `${previous.runId}:${previous.logicalSequence + 1}`,
    runId: previous.runId,
    logicalSequence: previous.logicalSequence + 1,
    phaseId: previous.phaseId,
    sequence: previous.sequence + 1,
    timestamp: new Date().toISOString(),
    type: AgentEventType.RunFailed,
    code: "transport_error",
    message: "Agent stream transport failed.",
  };
}
