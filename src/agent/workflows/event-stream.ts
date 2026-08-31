import type { AgentEvent, AgentEventPayload } from "../events.js";

export class AgentEventStream implements AsyncIterable<AgentEvent> {
  private readonly values: AgentEvent[] = [];
  private waiter: ((result: IteratorResult<AgentEvent>) => void) | null = null;
  private sequence = 0;
  private closed = false;

  constructor(private readonly runId: string) {}

  emit(payload: AgentEventPayload): void {
    this.push({
      ...payload,
      version: 1,
      eventId: crypto.randomUUID(),
      runId: this.runId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  private push(value: AgentEvent): void {
    if (this.closed) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}
