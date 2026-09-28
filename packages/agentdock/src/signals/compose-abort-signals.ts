export interface ComposedAbortSignal {
  signal: AbortSignal;
  dispose(): void;
}

export interface AbortScope extends ComposedAbortSignal {
  abort(reason?: unknown): void;
}

/** Adds an owner-controlled abort signal to the supplied parent signals. */
export function createAbortScope(
  ...parentSignals: Array<AbortSignal | undefined>
): AbortScope {
  const owner = new AbortController();
  const composed = composeAbortSignals(...parentSignals, owner.signal);
  return {
    signal: composed.signal,
    abort: (reason) => owner.abort(reason),
    dispose: composed.dispose,
  };
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
