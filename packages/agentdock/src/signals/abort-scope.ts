export interface AbortScope {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  dispose(): void;
}

/** Owns cancellation for one consumer and detaches its optional parent signal. */
export function createAbortScope(parent?: AbortSignal): AbortScope {
  const controller = new AbortController();
  let listening = false;
  const dispose = () => {
    if (!listening) return;
    parent?.removeEventListener("abort", onParentAbort);
    listening = false;
  };
  const abort = (reason?: unknown) => {
    controller.abort(reason);
    dispose();
  };
  const onParentAbort = () => abort(parent?.reason);
  if (parent?.aborted) abort(parent.reason);
  else if (parent) {
    parent.addEventListener("abort", onParentAbort, { once: true });
    listening = true;
  }
  return { signal: controller.signal, abort, dispose };
}
