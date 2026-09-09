import type { AgentEvent, AgentEventInput } from "../events.js";

export class AgentEventStream implements AsyncIterable<AgentEvent> {
  private readonly values: AgentEvent[] = [];
  private waiter: ((result: IteratorResult<AgentEvent>) => void) | null = null;
  private sequence = 0;
  private logicalSequence = 0;
  private closed = false;

  constructor(
    private readonly runId: string,
    private readonly sessionId = "",
    private readonly phaseId = crypto.randomUUID(),
  ) {}

  emit(input: AgentEventInput): void {
    const sequence = ++this.sequence;
    const logicalSequence = ++this.logicalSequence;
    this.push({
      ...input,
      eventId: crypto.randomUUID(),
      runId: this.runId,
      sessionId: this.sessionId,
      phaseId: this.phaseId,
      logicalSequence,
      sequence,
      timestamp: new Date().toISOString(),
    });
  }

  setLogicalSequenceStart(sequence: number): void {
    if (this.sequence !== 0) {
      throw new Error("Agent event sequence cannot start after emission.");
    }
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error(
        "Agent logical sequence start must be a non-negative integer.",
      );
    }
    this.logicalSequence = sequence;
  }

  getLogicalSequence(): number {
    return this.logicalSequence;
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
    let stopped = false;

    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        if (stopped) return Promise.resolve({ value: undefined, done: true });
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: (): Promise<IteratorResult<AgentEvent>> => {
        stopped = true;
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
