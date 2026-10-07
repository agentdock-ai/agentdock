import {
  AgentEventType,
  reduceAgentEvent,
  type AgentEvent,
  type AgentReducerState,
  type ConversationMessage,
} from "@agentdock-ai/contracts";
import { messagesForEvent, mapDisplayEvent, isTerminal } from "./transcript.js";
import type {
  ConversationRecords,
  ThreadRecord,
  OperationRecord,
} from "./store.js";

export interface OperationSettlement {
  durable: boolean;
  error?: unknown;
}

/** One ordered writer for the transcript and receipt of a native invocation. */
export class OperationPersistence {
  private readonly messages = new Map<string, ConversationMessage>();
  terminal = false;
  constructor(
    private readonly records: ConversationRecords,
    private readonly thread: ThreadRecord,
    private readonly operation: OperationRecord,
    private state: AgentReducerState,
    private readonly displayUrls: Map<string, string>,
    prompt: ConversationMessage | null,
  ) {
    if (prompt) this.messages.set(prompt.id, prompt);
  }

  async write(raw: AgentEvent): Promise<AgentEvent> {
    const event = mapDisplayEvent(raw, this.displayUrls);
    this.state = reduceAgentEvent(this.state, event);
    this.operation.runId = event.runId;
    this.operation.updatedAt = new Date().toISOString();
    const terminal =
      isTerminal(event) || event.type === AgentEventType.RunPaused;
    if (
      event.type === AgentEventType.RunPaused ||
      event.type === AgentEventType.InterruptRequired
    ) {
      this.operation.status = "paused";
    } else if (isTerminal(event)) {
      this.operation.status = "settled";
      this.operation.outcome = "stopped";
      if (event.type === AgentEventType.RunCompleted)
        this.operation.outcome = "complete";
      if (event.type === AgentEventType.RunFailed)
        this.operation.outcome = "error";
    }
    const changed = messagesForEvent(
      event,
      this.state,
      this.messages,
      this.thread,
      this.operation,
    );
    for (const message of changed)
      await this.records.putMessage(this.thread.id, message);
    this.operation.publishedPosition = this.thread.nextPosition;
    this.thread.lastOperation = this.operation;
    this.thread.updatedAt = this.operation.updatedAt;
    await this.records.putOperation(this.thread.id, this.operation);
    await this.records.putThread(this.thread);
    if (terminal) this.terminal = true;
    return event;
  }

  async markUncertain(): Promise<void> {
    this.operation.status = "uncertain";
    this.operation.updatedAt = new Date().toISOString();
    this.thread.lastOperation = this.operation;
    await this.records.putOperation(this.thread.id, this.operation);
    await this.records.putThread(this.thread);
  }
}

export async function runOperation(
  iterator: AsyncIterator<AgentEvent>,
  writer: OperationPersistence,
  publish: (event: AgentEvent) => Promise<void>,
  controller: AbortController,
  timeoutMs: number,
): Promise<OperationSettlement> {
  let durable = true;
  let failure: unknown;
  try {
    while (true) {
      const next = await nextWithSettlementDeadline(
        iterator,
        controller.signal,
        timeoutMs,
      );
      if (next.done) break;
      await publish(await writer.write(next.value));
    }
    if (!writer.terminal) {
      durable = false;
      failure = new Error("Execution ended without a terminal event.");
      await writer.markUncertain();
    }
  } catch (error) {
    failure = error;
    controller.abort();
    try {
      durable =
        error instanceof SettlementTimeout
          ? false
          : await drain(iterator, writer, timeoutMs);
    } catch (settlementError) {
      failure = settlementError;
      durable = false;
    }
    if (!durable) {
      try {
        await writer.markUncertain();
      } catch {
        /* Preserve the execution failure and retain ownership. */
      }
    }
  }
  return { durable, ...(failure === undefined ? {} : { error: failure }) };
}

async function drain(
  iterator: AsyncIterator<AgentEvent>,
  writer: OperationPersistence,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      iterator.next(),
      new Promise<null>((resolve) => {
        timer = setTimeout(
          () => resolve(null),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (next === null || next.done) return false;
    const event = await writer.write(next.value);
    if (event.type === AgentEventType.RunPaused || isTerminal(event))
      return true;
  }
  return false;
}

class SettlementTimeout extends Error {}

async function nextWithSettlementDeadline<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const aborted = () => {
    timer = setTimeout(
      () =>
        rejectDeadline(
          new SettlementTimeout(
            "Native execution did not acknowledge cancellation.",
          ),
        ),
      timeoutMs,
    );
  };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();
  try {
    return await Promise.race([iterator.next(), deadline]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", aborted);
  }
}
