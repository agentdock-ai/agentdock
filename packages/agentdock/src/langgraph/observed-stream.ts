import type { ToolObserver } from "./tool-observer.js";
import type { StreamChunk } from "./parse-stream-chunk.js";

export type ObservedChunk =
  | { source: "callback"; chunk: StreamChunk }
  | { source: "graph"; value: unknown };

/** Callback events must wake the consumer even while a native task is blocked. */
export async function* observeStream(
  iterator: AsyncIterator<unknown>,
  observer: ToolObserver,
  signal: AbortSignal,
): AsyncGenerator<ObservedChunk> {
  let result: IteratorResult<unknown> | undefined;
  let reading = false;
  let failed = false;
  let failure: unknown;
  let wake: () => void;
  let notification = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const notify = () => wake();
  const unsubscribe = observer.subscribe(notify);
  signal.addEventListener("abort", notify, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      if (!reading && !result && !failed) {
        reading = true;
        // Keep one native read in flight; callbacks do not start extra reads.
        Promise.resolve()
          .then(() => iterator.next())
          .then(
            (value) => {
              result = value;
              reading = false;
              notify();
            },
            (error: unknown) => {
              failure = error;
              failed = true;
              reading = false;
              notify();
            },
          );
      }
      for (const chunk of observer.drain()) yield { source: "callback", chunk };
      if (failed) throw failure;
      if (result) {
        const current = result;
        result = undefined;
        if (current.done) return;
        yield { source: "graph", value: current.value };
        continue;
      }
      await notification;
      notification = new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", notify);
  }
}
