/** Keeps one source read pending across heartbeat pulls. */
export class SseReader<T> {
  private pending?: Promise<IteratorResult<T>>;
  private timer?: ReturnType<typeof setTimeout>;
  private wake?: (value: IteratorResult<T> | null) => void;

  constructor(
    private readonly iterator: AsyncIterator<T>,
    private readonly heartbeatMs: number,
    private readonly signal: AbortSignal,
  ) {
    signal.addEventListener("abort", this.stop, { once: true });
  }

  async next(): Promise<IteratorResult<T> | null> {
    if (this.signal.aborted) return { done: true, value: undefined };
    this.pending ??= Promise.resolve().then(() => this.iterator.next());
    try {
      const result = await Promise.race([
        this.pending,
        new Promise<IteratorResult<T> | null>((resolve) => {
          this.wake = resolve;
          if (this.heartbeatMs > 0)
            this.timer = setTimeout(() => resolve(null), this.heartbeatMs);
        }),
      ]);
      if (result !== null) this.pending = undefined;
      return result;
    } finally {
      clearTimeout(this.timer);
      this.wake = undefined;
    }
  }

  private readonly stop = () => {
    this.wake?.({ done: true, value: undefined });
  };

  dispose(): void {
    clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.stop);
    this.stop();
  }
}
