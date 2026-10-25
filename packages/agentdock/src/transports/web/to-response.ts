import type { AgentEvent } from "@agentdock-ai/contracts";
import { closeIterator } from "../../utils/close-iterator.js";
import { createAbortScope } from "../../signals/abort-scope.js";
import {
  ABORT_GRACE_MS,
  encodeSseEvent,
  SSE_HEADERS,
  SSE_HEARTBEAT,
  resolveHeartbeatMs,
  isTerminalEvent,
} from "../sse.js";
import { SseReader } from "../sse-reader.js";
import type { Run } from "../../serving/types.js";

export async function createSseResponse<
  TInput,
  TContext extends Record<string, unknown>,
>(
  run: Run<TInput, TContext>,
  source: (run: Run<TInput, TContext>) => AsyncIterable<AgentEvent>,
  heartbeatMs = 15_000,
): Promise<Response> {
  return createEventResponse((signal) => source({ ...run, signal }), {
    signal: run.signal,
    heartbeatMs,
    isTerminal: isTerminalEvent,
  });
}

/** SSE adaptation for event producers, including conversation envelopes. */
export async function createEventResponse<T>(
  source: (signal: AbortSignal) => AsyncIterable<T>,
  options: {
    signal?: AbortSignal;
    heartbeatMs?: number;
    isTerminal?: (event: T) => boolean;
  } = {},
): Promise<Response> {
  const heartbeatMs = resolveHeartbeatMs(options.heartbeatMs);
  const abortScope = createAbortScope(options.signal);
  let iterator: AsyncIterator<T> | undefined;
  let first: IteratorResult<T>;
  try {
    iterator = source(abortScope.signal)[Symbol.asyncIterator]();
    // Validate the run and resume checkpoint before returning a committed 200.
    first = await iterator.next();
  } catch (error) {
    abortScope.abort(error);
    abortScope.dispose();
    await closeIterator(iterator);
    throw error;
  }

  const streamIterator = iterator;
  // The reader stops only when the transport gives up, so an aborted source
  // can still deliver its terminal event.
  const stop = new AbortController();
  const reader = new SseReader(streamIterator, heartbeatMs, stop.signal);
  const encoder = new TextEncoder();
  let firstPending = !first.done;
  let closed = false;
  let pulling: Promise<void> | undefined;
  let draining = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const dispose = () => {
    clearTimeout(grace);
    stop.abort();
    reader.dispose();
    abortScope.signal.removeEventListener("abort", onAbort);
    abortScope.dispose();
  };
  const finish = async () => {
    closed = true;
    dispose();
    await closeIterator(streamIterator);
    try {
      controller.close();
    } catch {
      // The consumer cancelled while the source was closing.
    }
  };
  const readOne = async () => {
    if (first.done) {
      closed = true;
      dispose();
      controller.close();
      return;
    }
    try {
      const next = firstPending ? first : await reader.next();
      if (closed) return;
      firstPending = false;
      if (next === null) {
        controller.enqueue(encoder.encode(SSE_HEARTBEAT));
        return;
      }
      if (next.done) return await finish();
      controller.enqueue(encoder.encode(encodeSseEvent(next.value)));
      if (options.isTerminal?.(next.value)) await finish();
    } catch (error) {
      if (closed) return;
      // Sources commonly reject once aborted; end cleanly rather than erroring.
      if (abortScope.signal.aborted) return await finish();
      closed = true;
      dispose();
      abortScope.abort(error);
      await closeIterator(streamIterator);
      controller.error(error);
    }
  };
  // Read the source's remaining events without waiting for pulls, so cleanup
  // does not depend on a reader that may already be gone.
  const onAbort = () => {
    draining = true;
    // Every close path clears this timer, so it fires only while still open.
    grace = setTimeout(() => void finish(), ABORT_GRACE_MS);
    void (async () => {
      await pulling;
      while (!closed) await readOne();
    })();
  };
  const body = new ReadableStream<Uint8Array>({
    start(current) {
      controller = current;
      abortScope.signal.addEventListener("abort", onAbort, { once: true });
      if (abortScope.signal.aborted) onAbort();
    },
    async pull() {
      if (draining) return;
      pulling = readOne();
      await pulling;
      pulling = undefined;
    },
    async cancel(reason) {
      closed = true;
      dispose();
      abortScope.abort(reason);
      await closeIterator(streamIterator);
    },
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}
