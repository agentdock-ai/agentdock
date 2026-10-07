import { randomUUID, createHash } from "node:crypto";
import { messagesForEvent, mapDisplayEvent, isTerminal } from "./transcript.js";
import { managedStream } from "./managed-stream.js";
import {
  AgentEventType,
  createAgentReducerState,
  reduceAgentEvent,
  type AgentEvent,
  type AgentReducerState,
  type ConversationActions,
  type ConversationAttachment,
  type ConversationApprovalRequest,
  type ConversationContinueRequest,
  type ConversationEventEnvelope,
  type ConversationHistory,
  type ConversationMessage,
  type ConversationStartRequest,
  type ConversationStopRequest,
  type ConversationThread,
  type ConversationThreadPage,
} from "@agentdock-ai/contracts";
import type { Run } from "@agentdock-ai/agentdock";
import type { AgentInterrupt } from "@agentdock-ai/contracts";
import {
  ConversationRecords,
  type AttachmentRecord,
  type ConversationStore,
  type OperationRecord,
  type ThreadRecord,
} from "./store.js";
import type {
  ConversationFileStorage,
  ConversationInputAttachment,
  ConversationUpload,
} from "./attachment-storage.js";

export interface ConversationRuntime<Input> {
  stream(run: Run<Input, Record<string, unknown>>): AsyncIterable<AgentEvent>;
  getResumeState(threadId: string): Promise<AgentReducerState | null>;
}

export interface ConversationInputContext {
  actorId: string;
  threadId: string;
  prompt: string;
  attachmentIds: readonly string[];
  attachments: readonly ConversationInputAttachment[];
}

export interface ConversationServiceOptions<Input> {
  runtime: ConversationRuntime<Input>;
  store: ConversationStore;
  prepareInput(context: ConversationInputContext): Input | Promise<Input>;
  fileStorage?: ConversationFileStorage;
  maxAttachmentBytes?: number;
  pageSize?: number;
  maxActiveOperations?: number;
  settlementTimeoutMs?: number;
}

interface ActiveOperation {
  operationId: string;
  controller: AbortController;
  settled: Promise<{ durable: boolean; error?: unknown }>;
  settle(result: { durable: boolean; error?: unknown }): void;
}

export class ConversationService<Input> {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly renaming = new Set<string>();
  private closing = false;
  private readonly pageSize: number;
  private readonly maxActive: number;
  private readonly settlementTimeoutMs: number;
  private readonly maxAttachmentBytes: number;

  constructor(private readonly options: ConversationServiceOptions<Input>) {
    this.pageSize = positiveInteger(options.pageSize ?? 40, "pageSize", 100);
    this.maxActive = positiveInteger(
      options.maxActiveOperations ?? 32,
      "maxActiveOperations",
      1024,
    );
    this.settlementTimeoutMs = positiveInteger(
      options.settlementTimeoutMs ?? 30_000,
      "settlementTimeoutMs",
      300_000,
    );
    this.maxAttachmentBytes = positiveInteger(
      options.maxAttachmentBytes ?? 5 * 1024 * 1024,
      "maxAttachmentBytes",
      25 * 1024 * 1024,
    );
  }

  get maxAttachmentSizeBytes(): number {
    return this.maxAttachmentBytes;
  }

  async createThread(
    actorId: string,
    title = "New conversation",
  ): Promise<ConversationThread> {
    const cleanTitle = validateTitle(title);
    const records = this.records(actorId);
    const now = new Date().toISOString();
    const thread: ThreadRecord = {
      id: randomUUID(),
      ownerHash: records.ownerHash,
      title: cleanTitle,
      createdAt: now,
      updatedAt: now,
      nextPosition: 0,
      nextTurn: 0,
      lastOperation: null,
      revision: 0,
    };
    await records.putThread(thread);
    return publicThread(thread);
  }

  async listThreads(
    actorId: string,
    cursor?: string | null,
  ): Promise<ConversationThreadPage> {
    const offset = decodeCursor(cursor);
    const records = this.records(actorId);
    const page = await records.listThreads(this.pageSize, offset);
    const threads = page
      .slice(0, this.pageSize)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      );
    const hasMore = page.length > this.pageSize;
    return {
      protocolVersion: 1,
      threads: threads.map(publicThread),
      nextCursor: hasMore ? encodeCursor(offset + this.pageSize) : null,
    };
  }

  async renameThread(
    actorId: string,
    threadId: string,
    title: string,
  ): Promise<ConversationThread> {
    const records = this.records(actorId);
    const key = this.activeKey(records.ownerHash, threadId);
    if (this.active.has(key) || this.renaming.has(key))
      throw conversationError(
        409,
        "Wait for the active operation or rename to finish.",
      );
    this.renaming.add(key);
    try {
      const thread = await this.requireThread(records, threadId);
      thread.title = validateTitle(title);
      thread.updatedAt = new Date().toISOString();
      await records.putThread(thread);
      return publicThread(thread);
    } finally {
      this.renaming.delete(key);
    }
  }

  async uploadAttachment(
    actorId: string,
    threadId: string,
    upload: ConversationUpload,
  ): Promise<ConversationAttachment> {
    if (!this.options.fileStorage)
      throw conversationError(503, "Attachment storage is not configured.");
    const records = this.records(actorId);
    await this.requireThread(records, threadId);
    const name = validateAttachmentName(upload.name);
    const mimeType = sniffImage(upload.bytes);
    if (!mimeType || mimeType !== upload.mimeType)
      throw conversationError(
        415,
        "Upload a valid PNG, JPEG, GIF, or WebP image.",
      );
    if (
      upload.bytes.byteLength < 1 ||
      upload.bytes.byteLength > this.maxAttachmentBytes
    )
      throw conversationError(
        413,
        "Image is empty or exceeds the configured size limit.",
      );
    const id = randomUUID();
    const storageRef = await this.options.fileStorage.put({
      id,
      mimeType,
      bytes: upload.bytes,
    });
    const record: AttachmentRecord = {
      id,
      threadId,
      ownerHash: records.ownerHash,
      name,
      mimeType,
      size: upload.bytes.byteLength,
      storageRef,
      createdAt: new Date().toISOString(),
    };
    try {
      await records.putAttachment(threadId, record);
    } catch (error) {
      try {
        await this.options.fileStorage.delete(storageRef);
      } catch {
        throw conversationError(
          503,
          "Attachment reference persistence failed and orphan cleanup also failed.",
        );
      }
      throw conversationError(503, "Attachment reference persistence failed.");
    }
    return publicAttachment(record);
  }

  async readAttachment(
    actorId: string,
    threadId: string,
    attachmentId: string,
  ): Promise<{ attachment: ConversationAttachment; bytes: Uint8Array }> {
    if (!this.options.fileStorage)
      throw conversationError(503, "Attachment storage is not configured.");
    const records = this.records(actorId);
    await this.requireThread(records, threadId);
    const record = await records.getAttachment(threadId, attachmentId);
    if (!record) throw conversationError(404, "Attachment was not found.");
    const bytes = await this.options.fileStorage.get(record.storageRef);
    if (!bytes)
      throw conversationError(404, "Attachment bytes are unavailable.");
    if (bytes.byteLength !== record.size)
      throw conversationError(
        503,
        "Stored attachment failed its integrity check.",
      );
    return { attachment: publicAttachment(record), bytes };
  }

  async deleteAttachment(
    actorId: string,
    threadId: string,
    attachmentId: string,
  ): Promise<void> {
    if (!this.options.fileStorage)
      throw conversationError(503, "Attachment storage is not configured.");
    const records = this.records(actorId);
    await this.requireThread(records, threadId);
    const record = await records.getAttachment(threadId, attachmentId);
    if (!record) return;
    await records.deleteAttachment(threadId, attachmentId);
    try {
      await this.options.fileStorage.delete(record.storageRef);
    } catch {
      throw conversationError(
        503,
        "Attachment reference was removed, but byte cleanup failed.",
      );
    }
  }

  async getHistory(
    actorId: string,
    threadId: string,
    cursor?: string | null,
  ): Promise<ConversationHistory> {
    return this.readHistory(actorId, threadId, cursor, 0);
  }

  private async readHistory(
    actorId: string,
    threadId: string,
    cursor: string | null | undefined,
    attempt: number,
  ): Promise<ConversationHistory> {
    const records = this.records(actorId);
    const thread = await this.requireThread(records, threadId);
    const beforePosition = cursor
      ? decodePositionCursor(cursor)
      : thread.nextPosition;
    const [page, nativeState] = await Promise.all([
      records.listMessages(threadId, this.pageSize + 1, beforePosition),
      this.options.runtime.getResumeState(threadId),
    ]);
    const latest = await this.requireThread(records, threadId);
    if (latest.revision !== thread.revision) {
      if (attempt >= 3)
        throw conversationError(
          409,
          "Conversation is changing; reload its history.",
        );
      return this.readHistory(actorId, threadId, cursor, attempt + 1);
    }
    const active = this.active.get(this.activeKey(records.ownerHash, threadId));
    const currentOperation = thread.lastOperation;
    const interrupts = nativeState?.interrupts ?? [];
    const pendingNodes = nativeState?.pausedNodes ?? [];
    const paused = interrupts.length > 0 || pendingNodes.length > 0;
    if (
      !active &&
      currentOperation &&
      ["accepted", "running"].includes(currentOperation.status)
    ) {
      currentOperation.status = "uncertain";
      thread.lastOperation = currentOperation;
      await records.putOperation(threadId, currentOperation);
      await records.putThread(thread);
    }
    const execution = active
      ? {
          operationId: active.operationId,
          runId: currentOperation?.runId ?? null,
          status: "running" as const,
          action: currentOperation?.action ?? "start",
        }
      : currentOperation &&
          (currentOperation.status === "paused" ||
            currentOperation.status === "uncertain" ||
            currentOperation.status === "settled")
        ? {
            operationId: currentOperation.id,
            runId: currentOperation.runId,
            status: currentOperation.status,
            action: currentOperation.action,
          }
        : null;
    const actions: ConversationActions = {
      canStart:
        !active &&
        interrupts.length === 0 &&
        currentOperation?.status !== "uncertain",
      canStop: Boolean(active),
      canContinue:
        !active && pendingNodes.length > 0 && interrupts.length === 0,
      canRespondToInterrupt: !active && interrupts.length > 0,
    };
    return {
      protocolVersion: 1,
      thread: publicThread(thread),
      messages: page
        .slice(-this.pageSize)
        .map((message) =>
          !active && message.outcome === "streaming"
            ? { ...message, outcome: "stopped" as const }
            : message,
        ),
      nextCursor:
        page.length > this.pageSize
          ? encodePositionCursor(page.slice(-this.pageSize)[0]!.position)
          : null,
      snapshotId: `${thread.updatedAt}:${thread.nextPosition}`,
      execution:
        paused || active || currentOperation?.status === "uncertain"
          ? execution
          : null,
      nativeControls: { pendingNodes, interrupts },
      interrupts,
      actions,
    };
  }

  start(
    actorId: string,
    request: ConversationStartRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ConversationEventEnvelope> {
    return this.runAction(
      actorId,
      request.threadId,
      request.operationId,
      "start",
      request,
      async (signal, turnId, attachments) => {
        const nativeState = await this.options.runtime.getResumeState(
          request.threadId,
        );
        const current = (
          await this.requireThread(this.records(actorId), request.threadId)
        ).lastOperation;
        if (
          current &&
          ["accepted", "running", "uncertain"].includes(current.status)
        )
          throw conversationError(
            409,
            "Reconcile uncertain work or start a new conversation.",
          );
        if (nativeState?.interrupts.length)
          throw conversationError(
            409,
            "Resolve the pending native approval before starting another prompt.",
          );
        const input = await this.options.prepareInput({
          actorId,
          threadId: request.threadId,
          prompt: request.prompt,
          attachmentIds: request.attachments,
          attachments,
        });
        return { run: { input, threadId: request.threadId, signal }, turnId };
      },
      signal,
    );
  }

  continue(
    actorId: string,
    request: ConversationContinueRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ConversationEventEnvelope> {
    return this.runAction(
      actorId,
      request.threadId,
      request.operationId,
      "continue",
      request,
      async (signal) => {
        const state = await this.options.runtime.getResumeState(
          request.threadId,
        );
        if (
          !state ||
          state.pausedNodes.length === 0 ||
          state.interrupts.length > 0
        )
          throw conversationError(
            409,
            "No native static continuation is pending.",
          );
        const records = this.records(actorId);
        const previous = (await this.requireThread(records, request.threadId))
          .lastOperation;
        if (
          !previous ||
          previous.id !== request.pendingOperationId ||
          !["paused", "settled", "uncertain"].includes(previous.status)
        )
          throw conversationError(
            409,
            "The referenced operation is not continuable.",
          );
        return {
          run: { continue: true, threadId: request.threadId, signal },
          turnId: previous.turnId,
        };
      },
      signal,
    );
  }

  respondToInterrupt(
    actorId: string,
    request: ConversationApprovalRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ConversationEventEnvelope> {
    return this.runAction(
      actorId,
      request.threadId,
      request.operationId,
      "approval",
      request,
      async (signal) => {
        const state = await this.options.runtime.getResumeState(
          request.threadId,
        );
        const interrupt = state?.interrupts.find(
          (item) => item.interruptId === request.interruptId,
        );
        if (!interrupt)
          throw conversationError(
            409,
            "The native interrupt is no longer pending.",
          );
        validateDecisions(interrupt, request.decisions);
        const previous = (
          await this.requireThread(this.records(actorId), request.threadId)
        ).lastOperation;
        if (!previous)
          throw conversationError(
            409,
            "No paused operation is available to resume.",
          );
        return {
          run: {
            resume: { [request.interruptId]: { decisions: request.decisions } },
            threadId: request.threadId,
            signal,
          },
          turnId: previous.turnId,
        };
      },
      signal,
    );
  }

  async stop(actorId: string, request: ConversationStopRequest): Promise<void> {
    const records = this.records(actorId);
    await this.requireThread(records, request.threadId);
    const active = this.active.get(
      this.activeKey(records.ownerHash, request.threadId),
    );
    if (!active) {
      const previous = await records.getOperation(
        request.threadId,
        request.targetOperationId,
      );
      if (previous?.status === "settled" && previous.outcome === "stopped")
        return;
      throw conversationError(409, "The target operation is not active.");
    }
    if (active.operationId !== request.targetOperationId)
      throw conversationError(409, "The target operation is not active.");
    active.controller.abort();
    const result = await this.waitForSettlement(active);
    if (!result.durable)
      throw conversationError(
        503,
        "The operation stopped without durable settlement.",
      );
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const active = [...this.active.values()];
    for (const operation of active) operation.controller.abort();
    const results = await Promise.all(
      active.map((operation) => this.waitForSettlement(operation)),
    );
    if (results.some((result) => !result.durable))
      throw conversationError(
        503,
        "Shutdown could not durably settle every operation.",
      );
  }

  private async waitForSettlement(
    operation: ActiveOperation,
  ): Promise<{ durable: boolean; error?: unknown }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      operation.settled,
      new Promise<{ durable: boolean }>((resolve) => {
        timer = setTimeout(
          () => resolve({ durable: false }),
          this.settlementTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  private runAction(
    actorId: string,
    threadId: string,
    operationId: string,
    action: OperationRecord["action"],
    request: unknown,
    prepareRun: (
      signal: AbortSignal,
      turnId: string,
      attachments: readonly ConversationInputAttachment[],
    ) => Promise<{ run: Run<Input, Record<string, unknown>>; turnId: string }>,
    signal?: AbortSignal,
  ): AsyncIterable<ConversationEventEnvelope> {
    return managedStream(async (publish, controller) => {
      await this.executeAction(
        actorId,
        threadId,
        operationId,
        action,
        request,
        prepareRun,
        publish,
        controller,
      );
    }, signal);
  }

  private async executeAction(
    actorId: string,
    threadId: string,
    operationId: string,
    action: OperationRecord["action"],
    request: unknown,
    prepareRun: (
      signal: AbortSignal,
      turnId: string,
      attachments: readonly ConversationInputAttachment[],
    ) => Promise<{ run: Run<Input, Record<string, unknown>>; turnId: string }>,
    publish: (value: ConversationEventEnvelope) => Promise<void>,
    controller: AbortController,
  ): Promise<void> {
    const records = this.records(actorId);
    const activeKey = this.activeKey(records.ownerHash, threadId);
    if (this.closing)
      throw conversationError(503, "Conversation service is shutting down.");
    if (this.active.has(activeKey) || this.renaming.has(activeKey))
      throw conversationError(409, "A conversation operation is active.");
    if (this.active.size >= this.maxActive)
      throw conversationError(
        503,
        "Conversation capacity is full; retry later.",
      );
    let settle!: ActiveOperation["settle"];
    const settled = new Promise<{ durable: boolean; error?: unknown }>(
      (resolve) => {
        settle = resolve;
      },
    );
    const active: ActiveOperation = {
      operationId,
      controller,
      settled,
      settle,
    };
    this.active.set(activeKey, active);
    let executionStarted = false;
    try {
      if (controller.signal.aborted)
        throw conversationError(
          409,
          "Operation request was cancelled before admission.",
        );
      const thread = await this.requireThread(records, threadId);
      const requestHash = hash(
        JSON.stringify(request, (_key, value) => {
          if (value && typeof value === "object" && !Array.isArray(value))
            return Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
            );
          return value;
        }),
      );
      const prior = await records.getOperation(threadId, operationId);
      if (prior) {
        if (prior.requestHash !== requestHash || prior.action !== action)
          throw conversationError(
            409,
            "Operation ID was reused for a different request.",
          );
        throw conversationError(
          409,
          "Operation outcome is already recorded; reconcile before retrying.",
        );
      }

      const now = new Date().toISOString();
      let turnId =
        action === "start" ? undefined : thread.lastOperation?.turnId;
      if (!turnId) {
        thread.nextTurn += 1;
        turnId = `${threadId}:${thread.nextTurn}`;
      }
      let operation: OperationRecord = {
        id: operationId,
        action,
        requestHash,
        turnId,
        status: "accepted",
        runId: null,
        createdAt: now,
        updatedAt: now,
        publishedPosition: thread.nextPosition,
      };
      const inputAttachments =
        action === "start"
          ? await this.loadInputAttachments(
              actorId,
              threadId,
              (request as ConversationStartRequest).attachments,
            )
          : [];
      const displayUrls = new Map(
        inputAttachments.map((attachment) => [
          `data:${attachment.mimeType};base64,${Buffer.from(attachment.bytes).toString("base64")}`,
          attachment.url,
        ]),
      );
      const prepared = await prepareRun(
        controller.signal,
        turnId,
        inputAttachments,
      );
      controller.signal.throwIfAborted();
      operation.turnId = prepared.turnId;
      turnId = prepared.turnId;
      thread.lastOperation = operation;
      await records.putThread(thread);
      await records.putOperation(threadId, operation);
      let promptMessage: ConversationMessage | null = null;
      if (action === "start") {
        const start = request as ConversationStartRequest;
        const userMessage: ConversationMessage = {
          id: `user:${operationId}`,
          turnId,
          operationId,
          position: thread.nextPosition++,
          role: "user",
          content: [
            ...(start.prompt
              ? [{ type: "text" as const, text: start.prompt }]
              : []),
            ...inputAttachments.map((attachment) => ({
              type: "image" as const,
              url: attachment.url,
              mimeType: attachment.mimeType,
            })),
          ],
          outcome: "complete",
          createdAt: now,
        };
        promptMessage = userMessage;
        await records.putMessage(threadId, userMessage);
        operation.publishedPosition = thread.nextPosition;
        await records.putThread(thread);
        await records.putOperation(threadId, operation);
      }
      const run = prepared.run;
      operation.status = "running";
      operation.updatedAt = new Date().toISOString();
      await records.putOperation(threadId, operation);
      const iterator = this.options.runtime.stream(run)[Symbol.asyncIterator]();
      executionStarted = true;
      let reducer =
        action === "start"
          ? createAgentReducerState()
          : ((await this.options.runtime.getResumeState(threadId)) ??
            createAgentReducerState());
      const messages = new Map<string, ConversationMessage>();
      if (promptMessage) messages.set(promptMessage.id, promptMessage);
      let terminal = false;
      let durable = true;
      let failure: unknown;
      try {
        while (true) {
          const next = await nextWithSettlementDeadline(
            iterator,
            controller.signal,
            this.settlementTimeoutMs,
          );
          if (next.done) break;
          const event = mapDisplayEvent(next.value, displayUrls);
          reducer = reduceAgentEvent(reducer, event);
          operation.runId = event.runId;
          operation.updatedAt = new Date().toISOString();
          if (isTerminal(event) || event.type === AgentEventType.RunPaused) {
            terminal = true;
            operation.status =
              event.type === AgentEventType.RunPaused ? "paused" : "settled";
            if (isTerminal(event))
              operation.outcome =
                event.type === AgentEventType.RunCompleted
                  ? "complete"
                  : event.type === AgentEventType.RunFailed
                    ? "error"
                    : "stopped";
          } else if (event.type === AgentEventType.InterruptRequired) {
            operation.status = "paused";
          }
          const changed = messagesForEvent(
            event,
            reducer,
            messages,
            thread,
            operation,
          );
          for (const message of changed)
            await records.putMessage(threadId, message);
          operation.publishedPosition = thread.nextPosition;
          if (event.type === AgentEventType.RunStarted && event.runId)
            operation.runId = event.runId;
          thread.lastOperation = operation;
          thread.updatedAt = new Date().toISOString();
          await records.putOperation(threadId, operation);
          await records.putThread(thread);
          await publish({
            protocolVersion: 1,
            operationId,
            threadId,
            event,
          });
        }
        if (!terminal) {
          operation.status = "uncertain";
          operation.updatedAt = new Date().toISOString();
          await records.putOperation(threadId, operation);
          durable = false;
          failure = new Error("Execution ended without a terminal event.");
        }
      } catch (error) {
        failure = error;
        controller.abort();
        try {
          durable =
            error instanceof SettlementTimeout
              ? false
              : await this.drain(
                  iterator,
                  records,
                  threadId,
                  thread,
                  operation,
                  reducer,
                  messages,
                  displayUrls,
                );
        } catch (settlementError) {
          failure = settlementError;
          durable = false;
        }
        if (!durable) {
          operation.status = "uncertain";
          operation.updatedAt = new Date().toISOString();
          try {
            await records.putOperation(threadId, operation);
          } catch {
            // The original failure remains the public persistence result.
          }
        }
      } finally {
        if (!terminal && failure === undefined) {
          controller.abort();
          try {
            durable = await this.drain(
              iterator,
              records,
              threadId,
              thread,
              operation,
              reducer,
              messages,
              displayUrls,
            );
          } catch (error) {
            failure = error;
            durable = false;
          }
          if (!durable) {
            operation.status = "uncertain";
            operation.updatedAt = new Date().toISOString();
            try {
              await records.putOperation(threadId, operation);
            } catch {
              /* retain uncertain ownership */
            }
          }
        }
        thread.updatedAt = new Date().toISOString();
        try {
          if (durable) {
            await records.putThread(thread);
            this.active.delete(activeKey);
          }
        } catch (error) {
          durable = false;
          failure = error;
        }
        settle({
          durable,
          ...(failure === undefined ? {} : { error: failure }),
        });
      }
      if (!durable || failure !== undefined)
        throw Object.assign(
          conversationError(
            503,
            "Conversation persistence or execution settlement failed.",
          ),
          { cause: failure },
        );
    } catch (error) {
      if (!executionStarted && this.active.get(activeKey) === active)
        this.active.delete(activeKey);
      settle({ durable: false, error });
      throw error;
    }
  }

  private async drain(
    iterator: AsyncIterator<AgentEvent>,
    records: ConversationRecords,
    threadId: string,
    thread: ThreadRecord,
    operation: OperationRecord,
    reducer: AgentReducerState,
    messages: Map<string, ConversationMessage>,
    displayUrls: Map<string, string>,
  ): Promise<boolean> {
    const deadline = Date.now() + this.settlementTimeoutMs;
    let state = reducer;
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
      if (next === null) return false;
      if (next.done) return false;
      const event = mapDisplayEvent(next.value, displayUrls);
      state = reduceAgentEvent(state, event);
      const changed = messagesForEvent(
        event,
        state,
        messages,
        thread,
        operation,
      );
      for (const message of changed)
        await records.putMessage(threadId, message);
      operation.publishedPosition = thread.nextPosition;
      operation.runId = next.value.runId;
      operation.updatedAt = new Date().toISOString();
      if (next.value.type === AgentEventType.RunPaused) {
        operation.status = "paused";
      } else if (isTerminal(next.value)) {
        operation.status = "settled";
        operation.outcome =
          next.value.type === AgentEventType.RunCompleted
            ? "complete"
            : next.value.type === AgentEventType.RunFailed
              ? "error"
              : "stopped";
      }
      await records.putOperation(threadId, operation);
      if (
        next.value.type === AgentEventType.RunPaused ||
        isTerminal(next.value)
      )
        return true;
    }
    throw new Error(
      "Conversation execution did not settle before the deadline.",
    );
  }

  private records(actorId: string) {
    return new ConversationRecords(this.options.store, actorId);
  }

  private async loadInputAttachments(
    actorId: string,
    threadId: string,
    ids: readonly string[],
  ): Promise<ConversationInputAttachment[]> {
    if (ids.length === 0) return [];
    if (!this.options.fileStorage)
      throw conversationError(503, "Attachment storage is not configured.");
    const records = this.records(actorId);
    await this.requireThread(records, threadId);
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length)
      throw conversationError(
        400,
        "An attachment was selected more than once.",
      );
    const loaded: ConversationInputAttachment[] = [];
    for (const id of unique) {
      const record = await records.getAttachment(threadId, id);
      if (!record)
        throw conversationError(
          400,
          "An attachment is missing or belongs to another thread.",
        );
      const bytes = await this.options.fileStorage.get(record.storageRef);
      if (!bytes || bytes.byteLength !== record.size)
        throw conversationError(
          503,
          "An attachment is unavailable or failed its integrity check.",
        );
      loaded.push({ ...publicAttachment(record), bytes });
    }
    return loaded;
  }

  private async requireThread(
    records: ConversationRecords,
    id: string,
  ): Promise<ThreadRecord> {
    if (typeof id !== "string" || !id.trim())
      throw conversationError(400, "threadId is required.");
    const thread = await records.getThread(id);
    if (!thread) throw conversationError(404, "Conversation was not found.");
    return thread;
  }

  private activeKey(ownerHash: string, threadId: string): string {
    return `${ownerHash}:${threadId}`;
  }
}

function validateDecisions(
  interrupt: AgentInterrupt,
  decisions: ConversationApprovalRequest["decisions"],
): void {
  if (decisions.length !== interrupt.actions.length)
    throw conversationError(
      400,
      "Supply one native decision for each pending action.",
    );
  for (const decision of decisions) {
    if (
      typeof decision !== "object" ||
      decision === null ||
      Array.isArray(decision)
    )
      throw conversationError(
        400,
        "Each approval decision must be a native decision object.",
      );
    const type = (decision as Record<string, unknown>).type;
    if (
      !(["approve", "reject", "edit"] as const).includes(
        type as "approve" | "reject" | "edit",
      )
    )
      throw conversationError(
        400,
        "Decision type must be approve, reject, or edit.",
      );
  }
}

function publicThread(thread: ThreadRecord): ConversationThread {
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function publicAttachment(record: AttachmentRecord): ConversationAttachment {
  return {
    id: record.id,
    threadId: record.threadId,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    url: `/conversations/${encodeURIComponent(record.threadId)}/attachments/${encodeURIComponent(record.id)}`,
    createdAt: record.createdAt,
  };
}

function sniffImage(bytes: Uint8Array): AttachmentRecord["mimeType"] | null {
  const data = Buffer.from(bytes);
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6)))
    return "image/gif";
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

function validateAttachmentName(name: string): string {
  if (typeof name !== "string" || name.trim().length === 0)
    throw conversationError(400, "Attachment name is required.");
  return name.trim().slice(0, 240);
}

function validateTitle(title: string): string {
  if (typeof title !== "string")
    throw conversationError(400, "title must be a string.");
  const normalized = title.trim();
  if (!normalized || normalized.length > 200)
    throw conversationError(400, "title must contain 1 to 200 characters.");
  return normalized;
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  return value;
}

function decodeCursor(cursor?: string | null): number {
  if (!cursor) return 0;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw conversationError(400, "Pagination cursor is invalid.");
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw conversationError(400, "Pagination cursor is invalid.");
  return value as number;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify(offset)).toString("base64url");
}

function decodePositionCursor(cursor: string): number {
  const value = decodeCursor(cursor);
  return value;
}

function encodePositionCursor(beforePosition: number): string {
  return encodeCursor(beforePosition);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function conversationError(
  status: number,
  message: string,
): Error & { status: number } {
  return Object.assign(new Error(message), { status });
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
