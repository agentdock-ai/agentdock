import { ConversationAttachments } from "./attachments.js";
import {
  conversationError,
  requireThread,
  positiveInteger,
  validateTitle,
  validateDecisions,
  decodeCursor,
  encodeCursor,
  hashRequest,
} from "./service-utils.js";
import { randomUUID } from "node:crypto";
import { OperationPersistence, runOperation } from "./operation.js";
import { managedStream } from "./managed-stream.js";
import {
  createAgentReducerState,
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
import {
  ConversationRecords,
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
  private readonly attachments: ConversationAttachments;
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
    this.attachments = new ConversationAttachments(
      options.store,
      options.fileStorage,
      this.maxAttachmentBytes,
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
    const threads = page.slice(0, this.pageSize);
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
      const thread = await requireThread(records, threadId);
      thread.title = validateTitle(title);
      thread.updatedAt = new Date().toISOString();
      await records.putThread(thread);
      return publicThread(thread);
    } finally {
      this.renaming.delete(key);
    }
  }

  uploadAttachment(
    actorId: string,
    threadId: string,
    upload: ConversationUpload,
  ): Promise<ConversationAttachment> {
    return this.attachments.upload(actorId, threadId, upload);
  }
  readAttachment(
    actorId: string,
    threadId: string,
    attachmentId: string,
  ): Promise<{ attachment: ConversationAttachment; bytes: Uint8Array }> {
    return this.attachments.read(actorId, threadId, attachmentId);
  }
  deleteAttachment(
    actorId: string,
    threadId: string,
    attachmentId: string,
  ): Promise<void> {
    return this.attachments.delete(actorId, threadId, attachmentId);
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
    const thread = await requireThread(records, threadId);
    const beforePosition = cursor ? decodeCursor(cursor) : thread.nextPosition;
    const [page, nativeState] = await Promise.all([
      records.listMessages(threadId, this.pageSize + 1, beforePosition),
      this.options.runtime.getResumeState(threadId),
    ]);
    const latest = await requireThread(records, threadId);
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
          ? encodeCursor(page.slice(-this.pageSize)[0]!.position)
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
          await requireThread(this.records(actorId), request.threadId)
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
        const previous = (await requireThread(records, request.threadId))
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
          await requireThread(this.records(actorId), request.threadId)
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
    await requireThread(records, request.threadId);
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
    let admission:
      { thread: ThreadRecord; operation: OperationRecord } | undefined;
    try {
      if (controller.signal.aborted)
        throw conversationError(
          409,
          "Operation request was cancelled before admission.",
        );
      const thread = await requireThread(records, threadId);
      const requestHash = hashRequest(request);
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
          ? await this.attachments.load(
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
      admission = { thread, operation };
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
      const reducer =
        action === "start"
          ? createAgentReducerState()
          : ((await this.options.runtime.getResumeState(threadId)) ??
            createAgentReducerState());
      const writer = new OperationPersistence(
        records,
        thread,
        operation,
        reducer,
        displayUrls,
        promptMessage,
      );
      // Once the native runtime is invoked, a failure may involve real side effects.
      executionStarted = true;
      const iterator = this.options.runtime.stream(run)[Symbol.asyncIterator]();
      const result = await runOperation(
        iterator,
        writer,
        (event) =>
          publish({
            protocolVersion: 1,
            operationId,
            threadId,
            event,
          }),
        controller,
        this.settlementTimeoutMs,
      );
      if (result.durable) this.active.delete(activeKey);
      settle(result);
      if (!result.durable || result.error !== undefined)
        throw Object.assign(
          conversationError(
            503,
            "Conversation persistence or execution settlement failed.",
          ),
          { cause: result.error },
        );
    } catch (error) {
      if (!executionStarted && admission) {
        const { thread, operation } = admission;
        operation.status = "settled";
        operation.outcome = "error";
        operation.updatedAt = new Date().toISOString();
        // Publish only positions whose message writes were confirmed.
        thread.nextPosition = operation.publishedPosition;
        thread.lastOperation = operation;
        try {
          await records.putOperation(threadId, operation);
          await records.putThread(thread);
        } catch (recoveryError) {
          throw Object.assign(
            conversationError(
              503,
              "Admission recovery failed; reload history before retrying.",
            ),
            {
              cause: error,
              recoveryError,
            },
          );
        } finally {
          if (this.active.get(activeKey) === active)
            this.active.delete(activeKey);
          settle({ durable: false, error });
        }
      }
      if (!executionStarted && this.active.get(activeKey) === active)
        this.active.delete(activeKey);
      settle({ durable: false, error });
      throw error;
    }
  }

  private records(actorId: string) {
    return new ConversationRecords(this.options.store, actorId);
  }

  private activeKey(ownerHash: string, threadId: string): string {
    return `${ownerHash}:${threadId}`;
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
