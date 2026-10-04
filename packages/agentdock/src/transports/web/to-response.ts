import type { AgentEvent } from "@agentdock-ai/contracts";
import { closeIterator } from "../../utils/close-iterator.js";
import { createAbortScope } from "../../signals/abort-scope.js";
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
  let iterator: AsyncIterator<AgentEvent> | undefined;
  let first: IteratorResult<AgentEvent>;
  try {
    iterator = source(streamRun)[Symbol.asyncIterator]();
    // Validate the run and resume checkpoint before returning a committed 200.
    first = await iterator.next();
  } catch (error) {
    abortScope.abort(error);
    abortScope.dispose();
    await closeIterator(iterator);
    throw error;
  }

  const streamIterator = iterator;
  const encoder = new TextEncoder();
  let firstPending = !first.done;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      if (first.done) {
        closed = true;
        abortScope.dispose();
        streamController.close();
        return;
      }
      try {
        const next = firstPending ? first : await streamIterator.next();
        if (closed) return;
        firstPending = false;
        if (next.done) {
          closed = true;
          abortScope.dispose();
          streamController.close();
          return;
        }
        streamController.enqueue(encoder.encode(encodeSseEvent(next.value)));
      } catch (error) {
        if (closed) return;
        closed = true;
        abortScope.abort(error);
        abortScope.dispose();
        await closeIterator(streamIterator);
        streamController.error(error);
      }
    },
    async cancel(reason) {
      closed = true;
      abortScope.abort(reason);
      abortScope.dispose();
      await closeIterator(streamIterator);
    },
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}
