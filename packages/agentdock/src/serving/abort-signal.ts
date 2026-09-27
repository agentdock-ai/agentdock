export interface ComposedAbortSignal {
  signal: AbortSignal;
  dispose(): void;
}

/** Combines optional signals and removes its listeners when disposed. */
export function composeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): ComposedAbortSignal {
  const activeSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.clear();
  };

  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
    dispose();
  };

  const alreadyAborted = activeSignals.find((signal) => signal.aborted);
  if (alreadyAborted) {
    abortFrom(alreadyAborted);
    return { signal: controller.signal, dispose };
  }

  for (const signal of activeSignals) {
    const listener = () => abortFrom(signal);
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }

  return { signal: controller.signal, dispose };
}
