/** One producer and one queued event. Abort releases backpressure so settlement can finish. */
export function managedStream<T>(
  produce: (
    publish: (value: T) => Promise<void>,
    controller: AbortController,
  ) => Promise<void>,
  signal?: AbortSignal,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const controller = new AbortController();
      let queued: { value: T } | undefined;
      let done = false;
      let failure: unknown;
      let wakeReader: (() => void) | undefined;
      let releaseProducer: (() => void) | undefined;
      let task: Promise<void> | undefined;
      const abort = () => {
        controller.abort();
        releaseProducer?.();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      controller.signal.addEventListener("abort", () => releaseProducer?.(), {
        once: true,
      });

      const start = () => {
        task ??= produce(async (value) => {
          if (controller.signal.aborted) return;
          await new Promise<void>((resolve) => {
            releaseProducer = resolve;
            queued = { value };
            wakeReader?.();
          });
          releaseProducer = undefined;
        }, controller)
          .catch((error: unknown) => {
            failure = error;
          })
          .finally(() => {
            done = true;
            signal?.removeEventListener("abort", abort);
            wakeReader?.();
          });
      };

      return {
        async next(): Promise<IteratorResult<T>> {
          start();
          while (!queued && !done) {
            await new Promise<void>((resolve) => {
              wakeReader = resolve;
            });
            wakeReader = undefined;
          }
          if (queued) {
            const value = queued.value;
            queued = undefined;
            releaseProducer?.();
            return { value, done: false };
          }
          if (failure !== undefined) throw failure;
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<T>> {
          abort();
          queued = undefined;
          await task;
          signal?.removeEventListener("abort", abort);
          return { value: undefined, done: true };
        },
      };
    },
  };
}
