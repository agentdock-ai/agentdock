import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  isAIMessage,
  isAIMessageChunk,
  isBaseMessage,
  isBaseMessageChunk,
  isToolMessage,
} from "@langchain/core/messages";
import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import {
  createAgent,
  humanInTheLoopMiddleware,
  modelCallLimitMiddleware,
  type AnyAgentMiddleware,
  type InterruptOnConfig,
  type ToolCallRequest,
} from "langchain";
import { z } from "zod";
import {
  cloneContentParts,
  cloneJsonObject,
  cloneJsonValue,
  type JsonObject,
  type JsonValue,
} from "@agentdock/contracts";
import {
  AgentEventType,
  type AgentEventInput,
  type ContentPart,
  type AgentUsage,
} from "../../events.js";
import type { Message } from "../../memory.js";
import type { AgentContext } from "../../types.js";
import type { AgentSessionHistory } from "@agentdock/contracts";
import type {
  ToolApprovalRequest,
  ToolApprovalResponse,
} from "../../permissions/types.js";
import type {
  AgentRunResult,
  AgentRunStatus,
  RunAgentOptions,
  StreamAgentResult,
  ToolCallRecord,
  ToolErrorRecord,
  ToolResultRecord,
} from "../../types.js";
import {
  validateToolInput,
  type ToolRegistry,
} from "../../../tools/registry.js";
import { AgentEventStream } from "../event-stream.js";
import {
  findFinalContent,
  isStreamChunk,
  normalizeMessages,
  collectToolCalls,
  collectLatestToolCalls,
  collectToolResults,
  readStateMessages,
  readStateRunId,
  readStateToolRecords,
  type PersistedToolRecord,
  readStepNumber,
  stateHasInterrupt,
  toToolCallRecord,
} from "./message-adapter.js";
import {
  readApprovalInterruptFromCheckpoint,
  readApprovalInterruptFromPayload,
  type PendingApprovalInterrupt,
} from "./interrupts.js";
import {
  authorizeToolCall,
  createToolCallingTools,
  type ToolOutcomes,
} from "./tools.js";
import {
  errorMessage,
  isRecord,
  messageContentParts,
  messageText,
} from "../../value.js";
import { createThreadId } from "../../coordinator.js";
import type {
  AgentWorkflow,
  WorkflowResumeInput,
  WorkflowStartInput,
} from "../types.js";

const AGENT_STATE_SCHEMA = z.object({
  agentdockRunId: z.string().optional(),
  agentdockRunStartIndex: z.number().int().nonnegative().optional(),
  agentdockRunSnapshot: strictJsonObjectSchema(
    "AgentDock run snapshot",
  ).optional(),
  agentdockToolRecords: strictJsonArraySchema(
    "AgentDock tool records",
  ).optional(),
  agentdockEventSequence: z.number().int().nonnegative().optional(),
});

function strictJsonObjectSchema(label: string) {
  return z.custom<JsonObject>((value) => {
    try {
      cloneJsonObject(value, label);
      return true;
    } catch {
      return false;
    }
  });
}

function strictJsonArraySchema(label: string) {
  return z.custom<JsonValue[]>((value) => {
    try {
      if (!Array.isArray(value)) return false;
      cloneJsonValue(value, label);
      return true;
    } catch {
      return false;
    }
  });
}

const EVENT_SEQUENCE_CHECKPOINT_STRIDE = 1_000_000;

export interface ToolCallingWorkflowOptions {
  model: BaseChatModel;
  registry: ToolRegistry;
  checkpointer: BaseCheckpointSaver;
  middleware?: readonly AnyAgentMiddleware[];
}

interface ExecutionState {
  toolCalls: ToolCallRecord[];
  resolvedToolCalls: ToolCallRecord[];
  latestToolCalls: ToolCallRecord[];
  toolCallsById: Map<string, ToolCallRecord>;
  toolOutcomes: ToolOutcomes;
  toolResults: ToolResultRecord[];
  toolErrors: ToolErrorRecord[];
  stepNumbers: Set<number>;
  approvalInterrupt: PendingApprovalInterrupt | null;
  textByMessagePart: Map<string, string>;
  emittedPartFingerprints: Set<string>;
  startedMessageIds: Set<string>;
  assistantMessageIds: string[];
  anonymousMessageIds: Map<string, string>;
  persistedAssistantMessageIds: Set<string>;
  usageMessageIds: Set<string>;
  usage?: AgentUsage;
}

type ApprovalInterrupts = Record<
  string,
  Pick<InterruptOnConfig, "allowedDecisions" | "when">
>;

export class ToolCallingWorkflow implements AgentWorkflow {
  private readonly model: BaseChatModel;
  private readonly registry: ToolRegistry;
  private readonly checkpointer: BaseCheckpointSaver;
  private readonly middleware: readonly AnyAgentMiddleware[];

  constructor(options: ToolCallingWorkflowOptions) {
    this.model = options.model;
    this.registry = options.registry;
    this.checkpointer = options.checkpointer;
    this.middleware = options.middleware ?? [];
  }

  start(input: WorkflowStartInput): StreamAgentResult {
    return this.startExecution(input, "start");
  }

  resume(input: WorkflowResumeInput): StreamAgentResult {
    return this.startExecution(input, "resume");
  }

  async getMessages(
    sessionId: string,
    options: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    > = {},
  ): Promise<Message[]> {
    const state = await this.createAgent(options, new Map()).getState(
      this.runConfig(sessionId, {}, undefined, options.sessionNamespace),
    );
    return normalizeStateMessages(state);
  }

  async getRunId(
    sessionId: string,
    options: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    > = {},
  ): Promise<string | null> {
    const state = await this.createAgent(options, new Map()).getState(
      this.runConfig(sessionId, {}, undefined, options.sessionNamespace),
    );
    return readStateRunId(state);
  }

  async getPendingApprovalInterrupt(
    sessionId: string,
    options: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    > = {},
  ): Promise<PendingApprovalInterrupt | null> {
    const agent = this.createAgent(options, new Map());
    const state = await agent.getState(
      this.runConfig(sessionId, {}, undefined, options.sessionNamespace),
    );
    const config = this.runConfig(
      sessionId,
      {},
      undefined,
      options.sessionNamespace,
    );
    const checkpoint = await this.checkpointer.getTuple(config);
    return readApprovalInterruptFromCheckpoint(
      checkpoint ? { pendingWrites: checkpoint.pendingWrites } : state,
      collectLatestToolCalls(readStateMessages(state)),
    );
  }

  async deleteSession(
    sessionId: string,
    options: Pick<RunAgentOptions, "sessionNamespace"> = {},
  ): Promise<void> {
    await this.checkpointer.deleteThread(
      createThreadId(sessionId, options.sessionNamespace),
    );
  }

  async getSessionHistory(
    sessionId: string,
    options: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    > = {},
  ): Promise<AgentSessionHistory> {
    const config = this.runConfig(
      sessionId,
      {},
      undefined,
      options.sessionNamespace,
    );
    const checkpoints: AgentSessionHistory["checkpoints"] = [];
    for await (const tuple of this.checkpointer.list(config)) {
      const state = { values: tuple.checkpoint.channel_values };
      const messages = normalizeStateMessages(state);
      const runId = readStateRunId(state);
      checkpoints.push({
        checkpointId: tuple.checkpoint.id,
        timestamp: tuple.checkpoint.ts,
        ...(runId ? { runId } : {}),
        messages,
      });
    }
    const current = checkpoints[0]?.messages ?? [];
    return {
      sessionId,
      current: current.length > 0 ? { sessionId, messages: current } : null,
      checkpoints,
    };
  }

  private startExecution(
    input: WorkflowStartInput | WorkflowResumeInput,
    mode: "start" | "resume",
  ): StreamAgentResult {
    const stream = new AgentEventStream(input.runId, input.sessionId);
    const emit = (event: AgentEventInput): void => stream.emit(event);
    const result = this.execute(input, mode, stream, emit).finally(() =>
      stream.close(),
    );

    return { stream, result };
  }

  private async execute(
    input: WorkflowStartInput | WorkflowResumeInput,
    mode: "start" | "resume",
    eventStream: AgentEventStream,
    emit: (event: AgentEventInput) => void,
  ): Promise<AgentRunResult> {
    const state = createExecutionState();
    const agent = this.createAgent(
      input.options,
      state.toolOutcomes,
      input.ctx,
      emit,
    );
    const config = this.runConfig(
      input.sessionId,
      input.ctx,
      input.signal,
      input.options.sessionNamespace,
    );

    try {
      const initialGraphState = await agent.getState(config);
      const initialMessages = readStateMessages(initialGraphState);
      const runStartIndex =
        mode === "start"
          ? initialMessages.length
          : readStateRunStartIndex(initialGraphState, input.runId);
      if (runStartIndex === null) {
        throw new Error(
          "Agent checkpoint is missing the logical-run message boundary.",
        );
      }
      const initialRunMessages = initialMessages.slice(runStartIndex);
      seedExecutionState(state, initialRunMessages);
      const initialAssistantCount =
        initialRunMessages.filter(isAIMessage).length;
      eventStream.setLogicalSequenceStart(
        readStateEventSequence(initialGraphState, input.runId),
      );
      emit({ type: AgentEventType.RunStarted });
      if (mode === "resume" && "approvals" in input) {
        state.resolvedToolCalls.push(
          ...input.approvals.map((approval) => approval.toolCall),
        );
        emit({
          type: AgentEventType.InterruptResolved,
          interruptId: input.interruptId,
          decisions: input.approvals.map((approval) => ({
            approvalId: approval.approvalId,
            approved: approval.approved,
            ...(approval.reason ? { reason: approval.reason } : {}),
          })),
        });
      }

      const stream =
        "userPrompt" in input
          ? await agent.stream(
              {
                messages: [{ role: "user", content: input.userPrompt }],
                agentdockRunId: input.runId,
                agentdockRunStartIndex: runStartIndex,
              },
              { ...config, streamMode: ["messages", "updates"] },
            )
          : await agent.stream(
              new Command({
                resume: { decisions: input.approvals.map(toLangChainDecision) },
              }),
              { ...config, streamMode: ["messages", "updates"] },
            );

      for await (const chunk of stream)
        this.consumeStreamChunk(chunk, state, emit);

      const graphState = await agent.getState(config);
      const graphMessages = readStateMessages(graphState).slice(runStartIndex);
      const currentToolCalls = mergeById(
        collectToolCalls(graphMessages),
        state.resolvedToolCalls,
      );
      const currentRecords = createPersistedToolRecords(state);
      const toolCallsById = new Map(
        currentToolCalls.map((toolCall) => [toolCall.toolCallId, toolCall]),
      );
      const messages = normalizeMessages(
        graphMessages,
        toolCallsById,
        new Map(
          currentRecords.map((record) => [record.toolCall.toolCallId, record]),
        ),
      );
      const messageToolResults = collectToolResults(messages);
      const persistedRecords = mergeToolRecords(
        currentRecords,
        createPersistedToolRecordsFromMessages(messages),
      );
      const content = findFinalContent(messages);
      emitCompletedMessages(messages, state, emit, initialAssistantCount);
      if (stateHasInterrupt(graphState)) {
        const approvalInterrupt =
          state.approvalInterrupt ??
          (await this.getPendingApprovalInterrupt(
            input.sessionId,
            input.options,
          ));
        if (!approvalInterrupt) {
          throw new Error(
            "Agent checkpoint has an unresolved interrupt without actions.",
          );
        }
        const approvalRequests = approvalInterrupt.requests;
        emit({
          type: AgentEventType.InterruptRequired,
          interrupt: {
            kind: "tool-approval",
            interruptId: approvalInterrupt.interruptId,
            prompt: "Tool execution requires approval.",
            actions: approvalRequests.map((approval) => ({
              id: approval.approvalId,
              name: approval.toolCall.name,
              input: approval.toolCall.input,
            })),
          },
        });
        const result = createResult(
          input,
          state,
          "waiting_for_approval",
          content,
          messages,
          approvalRequests,
          currentToolCalls,
          messageToolResults.results,
          mergeById(messageToolResults.errors, state.toolErrors),
        );
        return this.persistResult(
          agent,
          config,
          graphState,
          result,
          persistedRecords,
          eventStream.getLogicalSequence(),
        );
      }

      emit({
        type: AgentEventType.RunCompleted,
        finishReason: "stop",
        content,
        ...(state.usage ? { usage: state.usage } : {}),
      });
      const result = createResult(
        input,
        state,
        "completed",
        content,
        messages,
        [],
        currentToolCalls,
        messageToolResults.results,
        mergeById(messageToolResults.errors, state.toolErrors),
      );
      return this.persistResult(
        agent,
        config,
        graphState,
        result,
        persistedRecords,
        eventStream.getLogicalSequence(),
      );
    } catch (error) {
      const message = errorMessage(error);
      if (input.signal.aborted) {
        emit({ type: AgentEventType.RunCancelled, reason: message });
        return this.persistFailedResult(
          agent,
          config,
          input,
          state,
          "cancelled",
          message,
          eventStream.getLogicalSequence(),
        );
      }
      if (
        isModelCallLimitError(error) &&
        input.options.maxSteps !== undefined
      ) {
        const limit = {
          kind: "model_calls",
          limit: input.options.maxSteps,
          used: input.options.maxSteps,
        };
        emit({
          type: AgentEventType.RunFailed,
          code: "agent_step_limit",
          message,
          limit,
        });
        return this.persistFailedResult(
          agent,
          config,
          input,
          state,
          "failed",
          message,
          eventStream.getLogicalSequence(),
          { errorCode: "agent_step_limit", finishReason: "limit", limit },
        );
      }
      emit({
        type: AgentEventType.RunFailed,
        code: readErrorCode(error) ?? "agent_execution_failed",
        message,
      });
      return this.persistFailedResult(
        agent,
        config,
        input,
        state,
        "failed",
        message,
        eventStream.getLogicalSequence(),
        {
          errorCode: readErrorCode(error) ?? "agent_execution_failed",
          finishReason: "error",
        },
      );
    }
  }

  private async persistResult(
    agent: ReturnType<ToolCallingWorkflow["createAgent"]>,
    config: ReturnType<ToolCallingWorkflow["runConfig"]>,
    graphState: unknown,
    current: AgentRunResult,
    currentRecords: PersistedToolRecord[],
    eventSequence: number,
  ): Promise<AgentRunResult> {
    if (current.status === "waiting_for_approval") return current;
    const previous = readRunSnapshot(graphState);
    const result = mergeRunResults(previous, current);
    const records = mergeToolRecords(
      readStateToolRecords(graphState),
      currentRecords,
    );
    await agent.updateState(config, {
      agentdockRunSnapshot: cloneJsonObject(result, "AgentDock run snapshot"),
      agentdockToolRecords: cloneJsonValue(records, "AgentDock tool records"),
      agentdockEventSequence: eventSequence,
    });
    return result;
  }

  private async persistFailedResult(
    agent: ReturnType<ToolCallingWorkflow["createAgent"]>,
    config: ReturnType<ToolCallingWorkflow["runConfig"]>,
    input: WorkflowStartInput | WorkflowResumeInput,
    state: ExecutionState,
    status: "cancelled" | "failed",
    error: string,
    eventSequence: number,
    terminal: Pick<AgentRunResult, "errorCode" | "finishReason" | "limit"> = {},
  ): Promise<AgentRunResult> {
    const current = failedResult(input, state, status, error, terminal);
    try {
      const graphState = await agent.getState(config);
      const result = mergeRunResults(
        readRunSnapshot(graphState),
        failedResultFromGraphState(
          input,
          state,
          graphState,
          status,
          error,
          terminal,
        ),
      );
      const records = mergeToolRecords(
        readStateToolRecords(graphState),
        createPersistedToolRecords(state),
      );
      try {
        await agent.updateState(config, {
          agentdockRunSnapshot: cloneJsonObject(
            result,
            "AgentDock run snapshot",
          ),
          agentdockToolRecords: cloneJsonValue(
            records,
            "AgentDock tool records",
          ),
          agentdockEventSequence: eventSequence,
        });
      } catch {
        // An aborted graph signal can reject checkpoint mutation. The reconstructed
        // logical result remains valid and is returned to the caller.
      }
      return result;
    } catch {
      return current;
    }
  }

  private createAgent(
    options: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "toolTimeout" | "authorizationTimeout"
    >,
    outcomes: ToolOutcomes,
    ctx: AgentContext = {},
    emit?: (event: AgentEventInput) => void,
  ) {
    return createAgent({
      model: this.model,
      tools: createToolCallingTools(
        this.registry,
        options.toolTimeout,
        options.authorizationTimeout,
        outcomes,
        emit
          ? ({ toolCallId, text }) =>
              emit({
                type: AgentEventType.ToolProgress,
                toolCallId,
                content: [{ type: "text", text }],
              })
          : undefined,
      ),
      checkpointer: this.checkpointer,
      stateSchema: AGENT_STATE_SCHEMA,
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      middleware: this.createMiddleware(options, ctx),
    });
  }

  private createMiddleware(
    options: Pick<RunAgentOptions, "maxSteps" | "authorizationTimeout">,
    ctx: AgentContext,
  ) {
    const middleware: AnyAgentMiddleware[] = [];
    const interruptOn = this.createApprovalInterrupts(
      options.authorizationTimeout,
      ctx,
    );

    if (Object.keys(interruptOn).length > 0) {
      middleware.push(humanInTheLoopMiddleware({ interruptOn }));
    }

    if (options.maxSteps !== undefined) {
      middleware.push(
        modelCallLimitMiddleware({
          runLimit: options.maxSteps,
          exitBehavior: "error",
        }),
      );
    }

    middleware.push(...this.middleware);
    return middleware;
  }

  private createApprovalInterrupts(
    authorizationTimeout: number | undefined,
    ctx: AgentContext,
  ): ApprovalInterrupts {
    const interruptOn: ApprovalInterrupts = {};

    for (const tool of this.registry.list()) {
      if (tool.requiresApproval !== true) continue;

      interruptOn[tool.name] = {
        allowedDecisions: ["approve", "reject"],
        when: async (request: ToolCallRequest) => {
          const toolCall = toToolCallRecord(request.toolCall);
          try {
            validateToolInput(tool.parameters, toolCall.input, tool.name);
          } catch {
            return false;
          }
          const authorization = await authorizeToolCall(
            tool,
            toolCall,
            ctx,
            undefined,
            authorizationTimeout,
          );
          return authorization.allowed;
        },
      };
    }

    return interruptOn;
  }

  private runConfig(
    sessionId: string,
    ctx: Record<string, unknown>,
    signal: AbortSignal | undefined,
    sessionNamespace: string | undefined,
  ) {
    return {
      configurable: {
        thread_id: createThreadId(sessionId, sessionNamespace),
      },
      context: ctx,
      ...(signal ? { signal } : {}),
    };
  }

  private consumeStreamChunk(
    chunk: unknown,
    state: ExecutionState,
    emit: (event: AgentEventInput) => void,
  ): void {
    if (!isStreamChunk(chunk)) return;
    const [mode, payload] = chunk;
    if (mode === "messages") this.consumeMessagePayload(payload, state, emit);
    if (mode === "updates") this.consumeUpdatePayload(payload, state, emit);
  }

  private consumeMessagePayload(
    payload: unknown,
    state: ExecutionState,
    emit: (event: AgentEventInput) => void,
  ): void {
    if (!Array.isArray(payload) || payload.length !== 2) return;
    const [message, metadata] = payload;
    if (isBaseMessageChunk(message) && isAIMessageChunk(message)) {
      this.consumeAssistantMessage(message, metadata, state, emit, true);
      return;
    }
    if (isBaseMessage(message) && isAIMessage(message)) {
      this.consumeAssistantMessage(message, metadata, state, emit, false);
      return;
    }
    if (isBaseMessage(message) && isToolMessage(message)) {
      const outcome = state.toolOutcomes.get(message.tool_call_id);
      if (outcome?.error) {
        state.toolErrors.push(outcome.error);
        state.toolResults.push({
          ...outcome.error,
          output: messageText(message.content),
          isError: true,
        });
        emit({ type: AgentEventType.ToolFailed, error: outcome.error });
        return;
      }
      const toolCall =
        outcome?.result ?? state.toolCallsById.get(message.tool_call_id);
      if (!toolCall) return;
      const result = outcome?.result ?? {
        ...toolCall,
        output: messageText(message.content),
      };
      state.toolResults.push(result);
      emit({ type: AgentEventType.ToolCompleted, result });
    }
  }

  private consumeAssistantMessage(
    message: {
      id?: string;
      content: unknown;
      tool_calls?: unknown[];
      usage_metadata?: unknown;
      response_metadata?: unknown;
    },
    metadata: unknown,
    state: ExecutionState,
    emit: (event: AgentEventInput) => void,
    isChunk: boolean,
  ): void {
    const finalizedToolCalls = isChunk
      ? []
      : (message.tool_calls ?? []).map(toToolCallRecord);
    if (
      message.id &&
      state.persistedAssistantMessageIds.has(message.id) &&
      finalizedToolCalls.length > 0 &&
      finalizedToolCalls.every((toolCall) =>
        state.toolCallsById.has(toolCall.toolCallId),
      )
    ) {
      return;
    }
    const messageId = message.id ?? getAnonymousMessageId(state, metadata);
    if (!state.assistantMessageIds.includes(messageId))
      state.assistantMessageIds.push(messageId);
    const usage = readAgentUsage(
      message.usage_metadata,
      message.response_metadata,
    );
    if (usage && !state.usageMessageIds.has(messageId)) {
      state.usageMessageIds.add(messageId);
      state.usage = mergeUsage(state.usage, usage);
      emit({ type: AgentEventType.UsageUpdated, usage: state.usage });
    }
    const partIndexes = new Map<string, number>();
    for (const part of messageContentParts(message.content)) {
      const partIndex = partIndexes.get(part.type) ?? 0;
      partIndexes.set(part.type, partIndex + 1);
      if (part.type === "text" || part.type === "reasoning") {
        const key = `${messageId}:${part.type}:${partIndex}`;
        const delta = isChunk
          ? getChunkDelta(state, key, part.text)
          : getMessageDelta(state, key, part.text);
        if (!delta) continue;
        ensureMessageStarted(state, messageId, emit);
        emit({
          type: AgentEventType.MessagePartDelta,
          messageId,
          part: { type: part.type, text: delta },
        });
        continue;
      }
      const fingerprint = `${messageId}:${JSON.stringify(part)}`;
      if (!isChunk && state.emittedPartFingerprints.has(fingerprint)) continue;
      state.emittedPartFingerprints.add(fingerprint);
      ensureMessageStarted(state, messageId, emit);
      emit({
        type: AgentEventType.MessagePartDelta,
        messageId,
        part,
      });
    }
    if (!isChunk) {
      if (finalizedToolCalls.length > 0)
        state.latestToolCalls = finalizedToolCalls;
      for (const toolCall of finalizedToolCalls) {
        if (this.recordToolCall(toolCall, state))
          emit({ type: AgentEventType.ToolCalled, toolCall });
      }
    }
    const step = readStepNumber(metadata);
    if (step !== null) state.stepNumbers.add(step);
  }

  private consumeUpdatePayload(
    payload: unknown,
    state: ExecutionState,
    emit: (event: AgentEventInput) => void,
  ): void {
    if (!isRecord(payload)) return;

    for (const update of Object.values(payload)) {
      if (!isRecord(update) || !Array.isArray(update.messages)) continue;
      for (const message of update.messages) {
        if (isBaseMessage(message) && isAIMessage(message)) {
          this.consumeAssistantMessage(message, undefined, state, emit, false);
        }
      }
    }

    if (!("__interrupt__" in payload)) return;
    const approvalInterrupt = readApprovalInterruptFromPayload(
      payload,
      state.latestToolCalls,
    );
    if (!approvalInterrupt) return;
    state.approvalInterrupt = approvalInterrupt;
  }

  private recordToolCall(
    toolCall: ToolCallRecord,
    state: ExecutionState,
  ): boolean {
    const existing = state.toolCallsById.get(toolCall.toolCallId);
    if (existing) {
      if (!isEquivalentToolCall(existing, toolCall)) {
        throw new Error(
          `Model returned conflicting finalized tool calls for ID: ${toolCall.toolCallId}`,
        );
      }
      return false;
    }
    state.toolCallsById.set(toolCall.toolCallId, toolCall);
    state.toolCalls.push(toolCall);
    return true;
  }
}

function createExecutionState(): ExecutionState {
  return {
    toolCalls: [],
    resolvedToolCalls: [],
    latestToolCalls: [],
    toolCallsById: new Map(),
    toolOutcomes: new Map(),
    toolResults: [],
    toolErrors: [],
    stepNumbers: new Set(),
    approvalInterrupt: null,
    textByMessagePart: new Map(),
    emittedPartFingerprints: new Set(),
    startedMessageIds: new Set(),
    assistantMessageIds: [],
    anonymousMessageIds: new Map(),
    persistedAssistantMessageIds: new Set(),
    usageMessageIds: new Set(),
    usage: undefined,
  };
}

function getAnonymousMessageId(
  state: ExecutionState,
  metadata: unknown,
): string {
  const step = readStepNumber(metadata);
  const key = step === null ? "assistant" : `assistant-step-${step}`;
  const existing = state.anonymousMessageIds.get(key);
  if (existing) return existing;
  const id = `agentdock-assistant-${state.anonymousMessageIds.size + 1}`;
  state.anonymousMessageIds.set(key, id);
  return id;
}

function ensureMessageStarted(
  state: ExecutionState,
  messageId: string,
  emit: (event: AgentEventInput) => void,
): void {
  if (state.startedMessageIds.has(messageId)) return;
  state.startedMessageIds.add(messageId);
  emit({
    type: AgentEventType.MessageStarted,
    messageId,
    role: "assistant",
  });
}

function seedExecutionState(
  state: ExecutionState,
  messages: ReturnType<typeof readStateMessages>,
): void {
  for (const toolCall of collectToolCalls(messages)) {
    state.toolCallsById.set(toolCall.toolCallId, toolCall);
  }
  for (const message of messages) {
    if (!isAIMessage(message)) continue;
    if (message.id) state.persistedAssistantMessageIds.add(message.id);
    const usage = readAgentUsage(
      message.usage_metadata,
      message.response_metadata,
    );
    if (usage) state.usage = mergeUsage(state.usage, usage);
  }
}

function readStateRunStartIndex(state: unknown, runId: string): number | null {
  if (readStateRunId(state) !== runId) return null;
  if (!isRecord(state) || !isRecord(state.values)) return null;
  const value = state.values.agentdockRunStartIndex;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function normalizeStateMessages(state: unknown): Message[] {
  const messages = readStateMessages(state);
  const records = new Map(
    readStateToolRecords(state).map((record) => [
      record.toolCall.toolCallId,
      record,
    ]),
  );
  const toolCalls = new Map(
    mergeById(
      collectToolCalls(messages),
      [...records.values()].map((record) => record.toolCall),
    ).map((toolCall) => [toolCall.toolCallId, toolCall]),
  );
  return normalizeMessages(messages, toolCalls, records);
}

function isEquivalentJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isEquivalentToolCall(
  left: ToolCallRecord,
  right: ToolCallRecord,
): boolean {
  return left.name === right.name && isEquivalentJson(left.input, right.input);
}

function getMessageDelta(
  state: ExecutionState,
  messageId: string,
  text: string,
): string {
  const previous = state.textByMessagePart.get(messageId) ?? "";
  state.textByMessagePart.set(messageId, text);
  if (text.startsWith(previous)) return text.slice(previous.length);
  if (text === previous) return "";
  return text;
}

function getChunkDelta(
  state: ExecutionState,
  messageId: string,
  text: string,
): string {
  if (text) {
    const previous = state.textByMessagePart.get(messageId) ?? "";
    state.textByMessagePart.set(messageId, previous + text);
  }
  return text;
}

function readAgentUsage(
  usageMetadata: unknown,
  responseMetadata: unknown,
): AgentUsage | null {
  const source =
    findUsageRecord(usageMetadata) ?? findUsageRecord(responseMetadata);
  const response = isRecord(responseMetadata) ? responseMetadata : null;
  if (!source && !response) return null;

  const inputTokens = readUsageNumber(
    source?.input_tokens ?? source?.inputTokens ?? source?.prompt_tokens,
  );
  const inputDetails = isRecord(source?.input_token_details)
    ? source.input_token_details
    : isRecord(source?.inputTokenDetails)
      ? source.inputTokenDetails
      : null;
  const cachedInputTokens = readUsageNumber(
    source?.cached_input_tokens ??
      source?.cachedInputTokens ??
      inputDetails?.cache_read ??
      inputDetails?.cached_tokens,
  );
  const outputTokens = readUsageNumber(
    source?.output_tokens ?? source?.outputTokens ?? source?.completion_tokens,
  );
  const outputDetails = isRecord(source?.output_token_details)
    ? source.output_token_details
    : isRecord(source?.outputTokenDetails)
      ? source.outputTokenDetails
      : null;
  const reasoningTokens = readUsageNumber(
    source?.reasoning_tokens ??
      source?.reasoningTokens ??
      outputDetails?.reasoning ??
      outputDetails?.reasoning_tokens,
  );
  const totalTokens = readUsageNumber(
    source?.total_tokens ?? source?.totalTokens,
  );
  const costUsd = readUsageNumber(
    source?.cost_usd ?? source?.costUsd ?? response?.cost_usd,
  );
  const model = readUsageString(
    response?.model_name ?? response?.model ?? source?.model,
  );
  const provider = readUsageString(
    response?.model_provider ?? response?.provider ?? source?.provider,
  );
  if (
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined &&
    totalTokens === undefined &&
    costUsd === undefined &&
    model === undefined &&
    provider === undefined
  ) {
    return null;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(model === undefined ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
  };
}

function findUsageRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.usage_metadata)) return value.usage_metadata;
  if (isRecord(value.tokenUsage)) return value.tokenUsage;
  if (isRecord(value.usage)) return value.usage;
  return value;
}

function readUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readUsageString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mergeUsage(
  previous: AgentUsage | undefined,
  current: AgentUsage,
): AgentUsage {
  const inputTokens = addUsageNumber(
    previous?.inputTokens,
    current.inputTokens,
  );
  const outputTokens = addUsageNumber(
    previous?.outputTokens,
    current.outputTokens,
  );
  const cachedInputTokens = addUsageNumber(
    previous?.cachedInputTokens,
    current.cachedInputTokens,
  );
  const reasoningTokens = addUsageNumber(
    previous?.reasoningTokens,
    current.reasoningTokens,
  );
  const totalTokens = addUsageNumber(
    previous?.totalTokens,
    current.totalTokens,
  );
  const costUsd = addUsageNumber(previous?.costUsd, current.costUsd);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...((current.model ?? previous?.model)
      ? { model: current.model ?? previous?.model }
      : {}),
    ...((current.provider ?? previous?.provider)
      ? { provider: current.provider ?? previous?.provider }
      : {}),
  };
}

function addUsageNumber(
  previous: number | undefined,
  current: number | undefined,
): number | undefined {
  if (previous === undefined) return current;
  if (current === undefined) return previous;
  return previous + current;
}

function isModelCallLimitError(value: unknown): value is Error {
  return (
    value instanceof Error && value.name === "ModelCallLimitMiddlewareError"
  );
}

function readErrorCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === "string"
    ? value.code
    : undefined;
}

function emitCompletedMessages(
  messages: Message[],
  state: ExecutionState,
  emit: (event: AgentEventInput) => void,
  skipAssistantCount: number,
): void {
  let assistantIndex = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (assistantIndex < skipAssistantCount) {
      assistantIndex += 1;
      continue;
    }
    emit({
      type: AgentEventType.MessageCompleted,
      messageId:
        message.id ??
        state.assistantMessageIds[assistantIndex] ??
        `assistant-${assistantIndex}`,
      role: "assistant",
      content: message.content,
    });
    assistantIndex += 1;
  }
}

function createResult(
  input: WorkflowStartInput | WorkflowResumeInput,
  state: ExecutionState,
  status: "completed" | "waiting_for_approval",
  content: ContentPart[],
  messages: Message[],
  approvalRequests: ToolApprovalRequest[],
  currentToolCalls: ToolCallRecord[],
  currentToolResults: ToolResultRecord[],
  currentToolErrors: ToolErrorRecord[],
): AgentRunResult {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    status,
    content,
    messages,
    toolCalls: currentToolCalls,
    toolResults: currentToolResults,
    toolErrors: currentToolErrors,
    approvalRequests,
    stepsCompleted: Math.max(
      state.stepNumbers.size,
      countLogicalSteps(messages),
    ),
    ...(status === "completed" ? { finishReason: "stop" } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
  };
}

function failedResult(
  input: WorkflowStartInput | WorkflowResumeInput,
  state: ExecutionState,
  status: "cancelled" | "failed",
  error: string,
  terminal: Pick<AgentRunResult, "errorCode" | "finishReason" | "limit"> = {},
): AgentRunResult {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    status,
    content: [],
    messages: [],
    toolCalls: state.toolCalls,
    toolResults: state.toolResults,
    toolErrors: state.toolErrors,
    approvalRequests: [],
    stepsCompleted: state.stepNumbers.size,
    error,
    errorCode:
      terminal.errorCode ??
      (status === "cancelled" ? "agent_cancelled" : "agent_execution_failed"),
    ...(status === "cancelled" ? { cancellationReason: error } : {}),
    finishReason:
      terminal.finishReason ?? (status === "cancelled" ? "cancelled" : "error"),
    ...(terminal.limit ? { limit: terminal.limit } : {}),
  };
}

function failedResultFromGraphState(
  input: WorkflowStartInput | WorkflowResumeInput,
  state: ExecutionState,
  graphState: unknown,
  status: "cancelled" | "failed",
  error: string,
  terminal: Pick<AgentRunResult, "errorCode" | "finishReason" | "limit"> = {},
): AgentRunResult {
  const runStartIndex = readStateRunStartIndex(graphState, input.runId) ?? 0;
  const graphMessages = readStateMessages(graphState).slice(runStartIndex);
  const toolCalls = mergeById(
    collectToolCalls(graphMessages),
    mergeById(state.resolvedToolCalls, state.toolCalls),
  );
  const persistedRecords = mergeToolRecords(
    readStateToolRecords(graphState),
    createPersistedToolRecords(state),
  );
  const messages = normalizeMessages(
    graphMessages,
    new Map(toolCalls.map((toolCall) => [toolCall.toolCallId, toolCall])),
    new Map(
      persistedRecords.map((record) => [record.toolCall.toolCallId, record]),
    ),
  );
  const messageResults = collectToolResults(messages);
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    status,
    content: findFinalContent(messages),
    messages,
    toolCalls,
    toolResults: mergeById(messageResults.results, state.toolResults),
    toolErrors: mergeById(messageResults.errors, state.toolErrors),
    approvalRequests: [],
    stepsCompleted: Math.max(
      state.stepNumbers.size,
      countLogicalSteps(messages),
    ),
    error,
    errorCode:
      terminal.errorCode ??
      (status === "cancelled" ? "agent_cancelled" : "agent_execution_failed"),
    ...(status === "cancelled" ? { cancellationReason: error } : {}),
    finishReason:
      terminal.finishReason ?? (status === "cancelled" ? "cancelled" : "error"),
    ...(terminal.limit ? { limit: terminal.limit } : {}),
  };
}

function createPersistedToolRecords(
  state: ExecutionState,
): PersistedToolRecord[] {
  return mergeById(state.resolvedToolCalls, state.toolCalls).map((toolCall) => {
    const outcome = state.toolOutcomes.get(toolCall.toolCallId);
    return {
      toolCall,
      ...(outcome?.result ? { result: outcome.result } : {}),
      ...(outcome?.error ? { error: outcome.error } : {}),
    };
  });
}

function countLogicalSteps(messages: Message[]): number {
  let lastUserMessage = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserMessage = index;
      break;
    }
  }
  return messages
    .slice(lastUserMessage + 1)
    .filter((message) => message.role === "assistant").length;
}

function createPersistedToolRecordsFromMessages(
  messages: Message[],
): PersistedToolRecord[] {
  return messages.flatMap((message) => {
    if (message.role !== "tool") return [];
    return message.content
      .flatMap((part) => (part.type === "tool-result" ? [part.result] : []))
      .map((result) => {
        const validationFailure =
          typeof result.output === "string" &&
          result.output.includes(
            "Received tool input did not match expected schema",
          );
        return {
          toolCall: {
            toolCallId: result.toolCallId,
            name: result.name,
            input: result.input,
          },
          result,
          ...(result.isError
            ? {
                error: {
                  toolCallId: result.toolCallId,
                  name: result.name,
                  input: result.input,
                  error: validationFailure
                    ? "Tool input failed validation."
                    : typeof result.output === "string"
                      ? result.output
                      : "Tool execution failed.",
                  code: validationFailure
                    ? "tool_input_invalid"
                    : "tool_execution_failed",
                },
              }
            : {}),
        };
      });
  });
}

function readRunSnapshot(state: unknown): AgentRunResult | null {
  if (!isRecord(state) || !isRecord(state.values)) return null;
  const snapshot = state.values.agentdockRunSnapshot;
  if (!isRecord(snapshot)) return null;
  const runId = snapshot.runId;
  const sessionId = snapshot.sessionId;
  const status = snapshot.status;
  const content = readContentParts(
    snapshot.content,
    "AgentDock result content",
  );
  const stepsCompleted = snapshot.stepsCompleted;
  const usage =
    snapshot.usage === undefined
      ? undefined
      : readAgentUsage(snapshot.usage, undefined);
  const limit =
    snapshot.limit === undefined ? undefined : readLimitInfo(snapshot.limit);
  if (
    typeof runId !== "string" ||
    typeof sessionId !== "string" ||
    !isRunStatus(status) ||
    content === null ||
    typeof stepsCompleted !== "number" ||
    !Number.isSafeInteger(stepsCompleted) ||
    !Array.isArray(snapshot.messages) ||
    !Array.isArray(snapshot.toolCalls) ||
    !Array.isArray(snapshot.toolResults) ||
    !Array.isArray(snapshot.toolErrors) ||
    !Array.isArray(snapshot.approvalRequests) ||
    (snapshot.usage !== undefined && usage === null) ||
    (snapshot.limit !== undefined && limit === null) ||
    (snapshot.finishReason !== undefined &&
      typeof snapshot.finishReason !== "string") ||
    (snapshot.errorCode !== undefined &&
      typeof snapshot.errorCode !== "string") ||
    (snapshot.cancellationReason !== undefined &&
      typeof snapshot.cancellationReason !== "string")
  ) {
    return null;
  }

  const messages = snapshot.messages.map(readMessage);
  const toolCalls = snapshot.toolCalls.map(readToolCall);
  const toolResults = snapshot.toolResults.map(readToolResult);
  const toolErrors = snapshot.toolErrors.map(readToolError);
  const approvalRequests = snapshot.approvalRequests.map(readApprovalRequest);
  if (
    messages.some((value) => value === null) ||
    toolCalls.some((value) => value === null) ||
    toolResults.some((value) => value === null) ||
    toolErrors.some((value) => value === null) ||
    approvalRequests.some((value) => value === null)
  ) {
    return null;
  }

  return {
    runId,
    sessionId,
    status,
    content,
    messages: messages.filter((value): value is Message => value !== null),
    toolCalls: toolCalls.filter(
      (value): value is ToolCallRecord => value !== null,
    ),
    toolResults: toolResults.filter(
      (value): value is ToolResultRecord => value !== null,
    ),
    toolErrors: toolErrors.filter(
      (value): value is ToolErrorRecord => value !== null,
    ),
    approvalRequests: approvalRequests.filter(
      (value): value is ToolApprovalRequest => value !== null,
    ),
    stepsCompleted,
    ...(typeof snapshot.error === "string" ? { error: snapshot.error } : {}),
    ...(typeof snapshot.errorCode === "string"
      ? { errorCode: snapshot.errorCode }
      : {}),
    ...(typeof snapshot.cancellationReason === "string"
      ? { cancellationReason: snapshot.cancellationReason }
      : {}),
    ...(typeof snapshot.finishReason === "string"
      ? { finishReason: snapshot.finishReason }
      : {}),
    ...(usage ? { usage } : {}),
    ...(limit ? { limit } : {}),
  };
}

function readLimitInfo(value: unknown): AgentRunResult["limit"] | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  const limit = readUsageNumber(value.limit);
  const used = readUsageNumber(value.used);
  if (value.limit !== undefined && limit === undefined) return null;
  if (value.used !== undefined && used === undefined) return null;
  return {
    kind: value.kind,
    ...(limit === undefined ? {} : { limit }),
    ...(used === undefined ? {} : { used }),
  };
}

function readStateEventSequence(state: unknown, runId: string): number {
  if (readStateRunId(state) !== runId) return 0;
  if (!isRecord(state) || !isRecord(state.values)) return 0;
  const sequence = state.values.agentdockEventSequence;
  const persistedSequence =
    typeof sequence === "number" &&
    Number.isSafeInteger(sequence) &&
    sequence >= 0
      ? sequence
      : 0;
  const checkpointStep =
    isRecord(state.metadata) &&
    typeof state.metadata.step === "number" &&
    Number.isSafeInteger(state.metadata.step) &&
    state.metadata.step >= 0
      ? state.metadata.step
      : -1;
  const checkpointSequence =
    checkpointStep < 0
      ? 0
      : (checkpointStep + 1) * EVENT_SEQUENCE_CHECKPOINT_STRIDE;
  return Math.max(persistedSequence, checkpointSequence);
}

function isRunStatus(value: unknown): value is AgentRunStatus {
  return (
    value === "waiting_for_approval" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function readToolCall(value: unknown): ToolCallRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.toolCallId !== "string" ||
    typeof value.name !== "string" ||
    !isRecord(value.input)
  ) {
    return null;
  }
  try {
    return {
      toolCallId: value.toolCallId,
      name: value.name,
      input: cloneJsonObject(value.input, "AgentDock tool call input"),
    };
  } catch {
    return null;
  }
}

function readToolResult(value: unknown): ToolResultRecord | null {
  if (!isRecord(value)) return null;
  const toolCall = readToolCall(value);
  if (!toolCall) return null;
  try {
    return {
      ...toolCall,
      output: cloneJsonValue(value.output, "AgentDock tool output"),
      ...(value.isError === true ? { isError: true } : {}),
    };
  } catch {
    return null;
  }
}

function readToolError(value: unknown): ToolErrorRecord | null {
  if (!isRecord(value) || typeof value.error !== "string") return null;
  const toolCall = readToolCall(value);
  if (!toolCall) return null;
  return {
    ...toolCall,
    error: value.error,
    ...(typeof value.code === "string" ? { code: value.code } : {}),
  };
}

function readMessage(value: unknown): Message | null {
  if (!isRecord(value) || typeof value.role !== "string") return null;
  const content = readContentParts(value.content, "AgentDock message content");
  if (content === null) return null;
  const id = typeof value.id === "string" ? { id: value.id } : {};
  if (
    value.role === "user" ||
    value.role === "system" ||
    value.role === "assistant" ||
    value.role === "tool"
  )
    return { role: value.role, content, ...id };
  return null;
}

function readContentParts(value: unknown, label: string): ContentPart[] | null {
  try {
    return cloneContentParts(value, label);
  } catch {
    return null;
  }
}

function readApprovalRequest(value: unknown): ToolApprovalRequest | null {
  if (!isRecord(value) || typeof value.approvalId !== "string") return null;
  const toolCall = readToolCall(value.toolCall);
  return toolCall ? { approvalId: value.approvalId, toolCall } : null;
}

function mergeToolRecords(
  previous: PersistedToolRecord[],
  current: PersistedToolRecord[],
): PersistedToolRecord[] {
  const records = new Map<string, PersistedToolRecord>();
  for (const record of previous)
    records.set(record.toolCall.toolCallId, record);
  for (const record of current) {
    const existing = records.get(record.toolCall.toolCallId);
    records.set(record.toolCall.toolCallId, {
      toolCall: record.toolCall,
      ...(existing?.result || record.result
        ? { result: record.result ?? existing?.result }
        : {}),
      ...(existing?.error || record.error
        ? { error: record.error ?? existing?.error }
        : {}),
    });
  }
  return [...records.values()];
}

function mergeRunResults(
  previous: AgentRunResult | null,
  current: AgentRunResult,
): AgentRunResult {
  if (!previous || previous.runId !== current.runId) return current;

  return {
    ...current,
    content: current.content.length > 0 ? current.content : previous.content,
    messages:
      current.messages.length > 0 ? current.messages : previous.messages,
    toolCalls: mergeById(previous.toolCalls, current.toolCalls),
    toolResults: mergeById(previous.toolResults, current.toolResults),
    toolErrors: mergeById(previous.toolErrors, current.toolErrors),
    stepsCompleted: Math.max(previous.stepsCompleted, current.stepsCompleted),
    approvalRequests:
      current.status === "waiting_for_approval" ? current.approvalRequests : [],
    ...(current.finishReason || previous.finishReason
      ? { finishReason: current.finishReason ?? previous.finishReason }
      : {}),
    ...(current.usage || previous.usage
      ? { usage: mergeUsage(previous.usage, current.usage ?? {}) }
      : {}),
    ...(current.limit || previous.limit
      ? { limit: current.limit ?? previous.limit }
      : {}),
  };
}

function mergeById<T extends { toolCallId: string }>(
  previous: T[],
  current: T[],
): T[] {
  const records = new Map<string, T>();
  for (const record of previous) records.set(record.toolCallId, record);
  for (const record of current) records.set(record.toolCallId, record);
  return [...records.values()];
}

function toLangChainDecision(
  approval: ToolApprovalResponse,
): { type: "approve" } | { type: "reject"; message?: string } {
  return approval.approved
    ? { type: "approve" }
    : {
        type: "reject",
        ...(approval.reason ? { message: approval.reason } : {}),
      };
}
