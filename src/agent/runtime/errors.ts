export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "Tool execution was aborted";
    if (error.name === "TimeoutError") return `Tool timed out: ${error.message}`;
    return error.message;
  }
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "name" in error && "message" in error) {
    const value = error as { name: string; message: string };
    if (value.name === "TimeoutError") return `Tool timed out: ${value.message}`;
    if (value.name === "AbortError") return "Tool execution was aborted";
    return value.message;
  }
  return "Tool execution failed";
}

export function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const abortSignalCleanups = new WeakMap<AbortSignal, () => void>();

export function releaseAbortSignal(signal: AbortSignal | undefined): void {
  if (!signal) return;
  abortSignalCleanups.get(signal)?.();
}

export function deriveAbortSignal(
  abortSignal: AbortSignal | undefined,
  toolTimeout: number | undefined,
): AbortSignal | undefined {
  if (toolTimeout != null) {
    const timeoutController = new AbortController();
    const timeoutSignal = timeoutController.signal;
    const timeoutId = setTimeout(() => {
      timeoutController.abort(
        new DOMException("The operation timed out.", "TimeoutError"),
      );
    }, toolTimeout);
    const releaseTimeout = () => {
      clearTimeout(timeoutId);
      timeoutSignal.removeEventListener("abort", releaseTimeout);
      abortSignalCleanups.delete(timeoutSignal);
    };
    abortSignalCleanups.set(timeoutSignal, releaseTimeout);
    timeoutSignal.addEventListener("abort", releaseTimeout, { once: true });

    if (abortSignal) {
      const combinedSignal = AbortSignal.any([abortSignal, timeoutSignal]);
      const releaseCombined = () => {
        releaseAbortSignal(timeoutSignal);
        abortSignal?.removeEventListener("abort", releaseCombined);
        combinedSignal.removeEventListener("abort", releaseCombined);
        abortSignalCleanups.delete(combinedSignal);
      };
      abortSignalCleanups.set(combinedSignal, releaseCombined);
      abortSignal.addEventListener("abort", releaseCombined, { once: true });
      combinedSignal.addEventListener("abort", releaseCombined, { once: true });
      return combinedSignal;
    }

    return timeoutSignal;
  }
  if (abortSignal) return abortSignal;
  return undefined;
}
