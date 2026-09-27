import type { AgentEvent } from "@agentdock-ai/contracts";
import { composeAbortSignals } from "./abort-signal.js";
import { encodeSseEvent, SSE_HEADERS } from "./sse.js";
import type { Run } from "./types.js";

export async function createSseResponse<
  TInput,
  TContext extends Record<string, unknown>,
>(
  run: Run<TInput, TContext>,
  source: (run: Run<TInput, TContext>) => AsyncIterable<AgentEvent>,
): Promise<Response> {
  const controller = new AbortController();
  const composed = composeAbortSignals(run.signal, controller.signal);
  // Preserve the start/resume discriminator while replacing only the signal.
  const streamRun: Run<TInput, TContext> = {
    ...run,
    signal: composed.signal,
  };
  const iterator = source(streamRun)[Symbol.asyncIterator]();
  let first: IteratorResult<AgentEvent>;
  try {
    // Validate the run and resume checkpoint before returning a committed 200.
    first = await iterator.next();
  } catch (error) {
    controller.abort(error);
    composed.dispose();
    if (iterator.return) await iterator.return().catch(() => undefined);
    throw error;
  }

  const encoder = new TextEncoder();
  let firstPending = !first.done;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      if (closed) return;
      try {
        const next = firstPending ? first : await iterator.next();
        firstPending = false;
        if (next.done) {
          closed = true;
          composed.dispose();
          streamController.close();
          return;
        }
        streamController.enqueue(encoder.encode(encodeSseEvent(next.value)));
      } catch (error) {
        closed = true;
        composed.dispose();
        streamController.error(error);
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      controller.abort(reason);
      composed.dispose();
      if (iterator.return) await iterator.return().catch(() => undefined);
    },
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}
