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

export function deriveAbortSignal(
  abortSignal: AbortSignal | undefined,
  toolTimeout: number | undefined,
): AbortSignal | undefined {
  if (abortSignal && toolTimeout != null) {
    return AbortSignal.any([abortSignal, AbortSignal.timeout(toolTimeout)]);
  }
  if (abortSignal) return abortSignal;
  if (toolTimeout != null) return AbortSignal.timeout(toolTimeout);
  return undefined;
}
