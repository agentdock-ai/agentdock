import type { AgentEvent } from "@agentdock-ai/contracts";
import { createAbortScope } from "../../signals/compose-abort-signals.js";
import { encodeSseEvent, SSE_HEADERS } from "../sse.js";
import type { Run } from "../../serving/types.js";

export async function createSseResponse<
  TInput,
  TContext extends Record<string, unknown>,
>(
  run: Run<TInput, TContext>,
  source: (run: Run<TInput, TContext>) => AsyncIterable<AgentEvent>,
): Promise<Response> {
  const abortScope = createAbortScope(run.signal);
  // Preserve the start/resume discriminator while replacing only the signal.
  const streamRun: Run<TInput, TContext> = {
    ...run,
    signal: abortScope.signal,
  };
  const iterator = source(streamRun)[Symbol.asyncIterator]();
  let first: IteratorResult<AgentEvent>;
  try {
    // Validate the run and resume checkpoint before returning a committed 200.
    first = await iterator.next();
  } catch (error) {
    abortScope.abort(error);
    abortScope.dispose();
    if (iterator.return) await iterator.return().catch(() => undefined);
    throw error;
  }

  const encoder = new TextEncoder();
  let firstPending = !first.done;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      if (closed) return;
      if (first.done) {
        closed = true;
        abortScope.dispose();
        streamController.close();
        return;
      }
      try {
        const next = firstPending ? first : await iterator.next();
        firstPending = false;
        if (next.done) {
          closed = true;
          abortScope.dispose();
          streamController.close();
          return;
        }
        streamController.enqueue(encoder.encode(encodeSseEvent(next.value)));
      } catch (error) {
        closed = true;
        abortScope.abort(error);
        abortScope.dispose();
        if (iterator.return) await iterator.return().catch(() => undefined);
        streamController.error(error);
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      abortScope.abort(reason);
      abortScope.dispose();
      if (iterator.return) await iterator.return().catch(() => undefined);
    },
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}
