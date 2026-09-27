import {
  AGENT_EVENT_PROTOCOL_VERSION,
  AgentEventType,
  type AgentEvent,
} from "@agentdock-ai/contracts";
import { composeAbortSignals } from "./abort-signal.js";
import { encodeSseEvent, SSE_HEADERS } from "./sse.js";
import type { NodeSseResponse, Run } from "./types.js";

type WaitResult = "drain" | "close" | "abort";

export async function pipeEvents<TInput, TContext extends Record<string, unknown>>(
  response: NodeSseResponse,
  run: Run<TInput, TContext>,
  source: (run: Run<TInput, TContext>) => AsyncIterable<AgentEvent>,
): Promise<void> {
  const clientController = new AbortController();
  const composed = composeAbortSignals(run.signal, clientController.signal);
  const streamRun = { ...run, signal: composed.signal } as Run<TInput, TContext>;
  const iterator = source(streamRun)[Symbol.asyncIterator]();
  let headersSent = false;
  let ended = false;
  let terminalSent = false;
  let disconnected = response.destroyed;
  let lastEvent: AgentEvent | undefined;

  const onClose = () => {
    if (!response.writableEnded) {
      disconnected = true;
      clientController.abort(new Error("Client disconnected."));
    }
  };
  response.on("close", onClose);

  const writeEvent = async (event: AgentEvent): Promise<boolean> => {
    if (disconnected || response.destroyed || response.writableEnded) return false;
    if (terminalSent) return false;
    const writable = response.write(encodeSseEvent(event));
    lastEvent = event;
    if (isTerminalEvent(event)) terminalSent = true;
    if (writable) return true;
    const outcome = await waitForDrain(response, composed.signal);
    return outcome === "drain" && !disconnected;
  };

  try {
    // Let validation and resume-state lookup fail before committing HTTP 200.
    const first = await iterator.next();
    if (disconnected || response.destroyed) return;
    response.writeHead(200, { ...SSE_HEADERS });
    headersSent = true;
    if (!first.done && !(await writeEvent(first.value))) return;

    while (!disconnected && !terminalSent) {
      const next = await iterator.next();
      if (next.done) break;
      if (!(await writeEvent(next.value))) break;
    }
  } catch (error) {
    if (!headersSent || disconnected || response.destroyed || response.writableEnded) {
      throw error;
    }
    if (!terminalSent && lastEvent) {
      const failure = transportFailureEvent(lastEvent);
      await writeEvent(failure);
    }
  } finally {
    response.off("close", onClose);
    composed.dispose();
    if (!ended && headersSent && !response.destroyed && !response.writableEnded) {
      ended = true;
      response.end();
    }
    if (!terminalSent || disconnected) {
      clientController.abort(new Error("Response stream closed."));
    }
    if (iterator.return) await iterator.return().catch(() => undefined);
  }
}

function waitForDrain(
  response: NodeSseResponse,
  signal: AbortSignal,
): Promise<WaitResult> {
  if (response.destroyed || response.writableEnded) return Promise.resolve("close");
  if (signal.aborted) return Promise.resolve("abort");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: WaitResult) => {
      if (settled) return;
      settled = true;
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
  });
}

function transportFailureEvent(previous: AgentEvent): AgentEvent {
  return {
    protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
    eventId: `${previous.runId}:${previous.logicalSequence + 1}`,
    runId: previous.runId,
    sessionId: previous.sessionId,
    logicalSequence: previous.logicalSequence + 1,
    phaseId: previous.phaseId,
    sequence: previous.sequence + 1,
    timestamp: new Date().toISOString(),
    type: AgentEventType.RunFailed,
    code: "transport_error",
    message: "Agent stream transport failed.",
  };
}

function isTerminalEvent(event: AgentEvent): boolean {
  return (
    event.type === AgentEventType.RunCompleted ||
    event.type === AgentEventType.RunFailed ||
    event.type === AgentEventType.RunCancelled
  );
}
