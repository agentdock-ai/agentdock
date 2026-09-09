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
  type InterruptOnConfig,
  type ToolCallRequest,
} from "langchain";
import { z } from "zod";
import { cloneJsonObject, cloneJsonValue } from "@agentdock/contracts";
import {
  AgentEventType,
  type AgentEventInput,
  type ContentPart,
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
import type { ToolRegistry } from "../../../tools/registry.js";
import { AgentEventStream } from "../event-stream.js";
import {
  findFinalContent,
  findLastAssistantWithToolCalls,
  isStreamChunk,
  normalizeMessages,
  collectToolCalls,
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
  authorizeToolCall,
  createToolCallingTools,
  type ToolOutcomes,
} from "./tools.js";
import { errorMessage, isRecord, messageText } from "../../value.js";
import { createThreadId } from "../../coordinator.js";
import type {
  AgentWorkflow,
  WorkflowResumeInput,
  WorkflowStartInput,
} from "../types.js";

const AGENT_STATE_SCHEMA = z.object({
  agentdockRunId: z.string().optional(),
  agentdockRunSnapshot: z.unknown().optional(),
  agentdockToolRecords: z.unknown().optional(),
});

export interface ToolCallingWorkflowOptions {
  model: BaseChatModel;
  registry: ToolRegistry;
  checkpointer: BaseCheckpointSaver;
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
  approvalRequests: ToolApprovalRequest[];
  textByMessageId: Map<string, string>;
  startedMessageIds: Set<string>;
  assistantMessageIds: string[];
  anonymousMessageIds: Map<string, string>;
}

type ApprovalInterrupts = Record<
  string,
  Pick<InterruptOnConfig, "allowedDecisions" | "when">
>;

export class ToolCallingWorkflow implements AgentWorkflow {
  private readonly model: BaseChatModel;
  private readonly registry: ToolRegistry;
  private readonly checkpointer: BaseCheckpointSaver;

  constructor(options: ToolCallingWorkflowOptions) {
    this.model = options.model;
    this.registry = options.registry;
    this.checkpointer = options.checkpointer;
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

  async getPendingApprovals(
    sessionId: string,
    options: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    > = {},
  ): Promise<ToolApprovalRequest[]> {
    const agent = this.createAgent(options, new Map());
    const state = await agent.getState(
      this.runConfig(sessionId, {}, undefined, options.sessionNamespace),
    );
    if (!stateHasInterrupt(state)) return [];

    const lastAssistant = findLastAssistantWithToolCalls(
      readStateMessages(state),
    );
    if (!lastAssistant || !isAIMessage(lastAssistant)) return [];
    return (lastAssistant.tool_calls ?? [])
      .map(toToolCallRecord)
      .filter(
        (toolCall) =>
          this.registry.get(toolCall.name)?.requiresApproval === true,
      )
      .map((toolCall) => ({ approvalId: toolCall.toolCallId, toolCall }));
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
    const result = this.execute(input, mode, emit).finally(() =>
      stream.close(),
    );

    return { stream, result };
  }

  private async execute(
    input: WorkflowStartInput | WorkflowResumeInput,
    mode: "start" | "resume",
    emit: (event: AgentEventInput) => void,
  ): Promise<AgentRunResult> {
    const state = createExecutionState();
    const agent = this.createAgent(
      input.options,
      state.toolOutcomes,
      input.ctx,
    );
    const config = this.runConfig(
      input.sessionId,
      input.ctx,
      input.signal,
      input.options.sessionNamespace,
    );

    emit({ type: AgentEventType.RunStarted });
    if (mode === "resume" && "approvals" in input) {
      state.resolvedToolCalls.push(
        ...input.approvals.map((approval) => approval.toolCall),
      );
      emit({
        type: AgentEventType.InterruptResolved,
        interruptId: createApprovalInterruptId(
          input.runId,
          input.approvals.map((approval) => approval.approvalId),
        ),
        decisions: input.approvals.map((approval) => ({
          approvalId: approval.approvalId,
          approved: approval.approved,
          ...(approval.reason ? { reason: approval.reason } : {}),
        })),
      });
    }

    try {
      const stream =
        "userPrompt" in input
          ? await agent.stream(
              {
                messages: [{ role: "user", content: input.userPrompt }],
                agentdockRunId: input.runId,
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
      const graphMessages = readStateMessages(graphState);
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
      emitCompletedMessages(messages, state, emit);
      if (state.approvalRequests.length > 0 || stateHasInterrupt(graphState)) {
        const approvalRequests =
          state.approvalRequests.length > 0
            ? state.approvalRequests
            : await this.getPendingApprovals(input.sessionId, input.options);
        emit({
          type: AgentEventType.InterruptRequired,
          interrupt: {
            kind: "tool-approval",
            interruptId: createApprovalInterruptId(
              input.runId,
              approvalRequests.map((approval) => approval.approvalId),
            ),
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
        );
      }

      emit({
        type: AgentEventType.RunCompleted,
        finishReason: "stop",
        content: [{ type: "text", text: content }],
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
        );
      }
      emit({
        type: AgentEventType.RunFailed,
        code: "agent_execution_failed",
        message,
      });
      return this.persistFailedResult(
        agent,
        config,
        input,
        state,
        "failed",
        message,
      );
    }
  }

  private async persistResult(
    agent: ReturnType<ToolCallingWorkflow["createAgent"]>,
    config: ReturnType<ToolCallingWorkflow["runConfig"]>,
    graphState: unknown,
    current: AgentRunResult,
    currentRecords: PersistedToolRecord[],
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
  ): Promise<AgentRunResult> {
    const current = failedResult(input, state, status, error);
    try {
      const graphState = await agent.getState(config);
      const result = mergeRunResults(readRunSnapshot(graphState), current);
      const records = mergeToolRecords(
        readStateToolRecords(graphState),
        createPersistedToolRecords(state),
      );
      await agent.updateState(config, {
        agentdockRunSnapshot: cloneJsonObject(result, "AgentDock run snapshot"),
        agentdockToolRecords: cloneJsonValue(records, "AgentDock tool records"),
      });
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
  ) {
    return createAgent({
      model: this.model,
      tools: createToolCallingTools(
        this.registry,
        options.toolTimeout,
        options.authorizationTimeout,
        outcomes,
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
    const middleware = [];
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
          exitBehavior: "end",
        }),
      );
    }

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
    message: { id?: string; content: unknown; tool_calls?: unknown[] },
    metadata: unknown,
    state: ExecutionState,
    emit: (event: AgentEventInput) => void,
    isChunk: boolean,
  ): void {
    const messageId = message.id ?? getAnonymousMessageId(state, metadata);
    if (!state.assistantMessageIds.includes(messageId))
      state.assistantMessageIds.push(messageId);
    const text = messageText(message.content);
    const delta = isChunk ? text : getMessageDelta(state, messageId, text);
    if (delta) {
      if (!state.startedMessageIds.has(messageId)) {
        state.startedMessageIds.add(messageId);
        emit({
          type: AgentEventType.MessageStarted,
          messageId,
          role: "assistant",
        });
      }
      emit({
        type: AgentEventType.MessagePartDelta,
        messageId,
        part: { type: "text", text: delta },
      });
    }
    if (!isChunk) {
      const toolCalls = (message.tool_calls ?? []).map(toToolCallRecord);
      if (toolCalls.length > 0) state.latestToolCalls = toolCalls;
      for (const toolCall of toolCalls) {
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
    const approvals = this.readCurrentApprovalRequests(payload, state);
    if (approvals.length === 0) return;
    state.approvalRequests = approvals;
  }

  private readCurrentApprovalRequests(
    payload: Record<string, unknown>,
    state: ExecutionState,
  ): ToolApprovalRequest[] {
    const interrupts = payload.__interrupt__;
    if (!Array.isArray(interrupts)) return [];

    const actionRequests = interrupts.flatMap((interrupt) => {
      if (!isRecord(interrupt) || !isRecord(interrupt.value)) return [];
      const actions = interrupt.value.actionRequests;
      return Array.isArray(actions) ? actions : [];
    });
    const currentCalls = [...state.latestToolCalls];
    const approvals: ToolApprovalRequest[] = [];

    for (const action of actionRequests) {
      if (!isRecord(action) || typeof action.name !== "string") continue;
      const index = currentCalls.findIndex(
        (toolCall) =>
          toolCall.name === action.name &&
          isEquivalentJson(toolCall.input, action.args),
      );
      if (index < 0) continue;
      const [toolCall] = currentCalls.splice(index, 1);
      if (this.registry.get(toolCall!.name)?.requiresApproval !== true) {
        continue;
      }
      approvals.push({ approvalId: toolCall!.toolCallId, toolCall: toolCall! });
    }

    return approvals;
  }

  private recordToolCall(
    toolCall: ToolCallRecord,
    state: ExecutionState,
  ): boolean {
    if (state.toolCallsById.has(toolCall.toolCallId)) return false;
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
    approvalRequests: [],
    textByMessageId: new Map(),
    startedMessageIds: new Set(),
    assistantMessageIds: [],
    anonymousMessageIds: new Map(),
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

function normalizeStateMessages(state: unknown): Message[] {
  const messages = readStateMessages(state);
  const toolCalls = new Map(
    collectToolCalls(messages).map((toolCall) => [
      toolCall.toolCallId,
      toolCall,
    ]),
  );
  const records = new Map(
    readStateToolRecords(state).map((record) => [
      record.toolCall.toolCallId,
      record,
    ]),
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

function getMessageDelta(
  state: ExecutionState,
  messageId: string,
  text: string,
): string {
  const previous = state.textByMessageId.get(messageId) ?? "";
  state.textByMessageId.set(messageId, text);
  if (text.startsWith(previous)) return text.slice(previous.length);
  if (text === previous) return "";
  return text;
}

function createApprovalInterruptId(
  runId: string,
  approvalIds: readonly string[],
): string {
  return `approval-${runId}-${approvalIds.join("-")}`;
}

function emitCompletedMessages(
  messages: Message[],
  state: ExecutionState,
  emit: (event: AgentEventInput) => void,
): void {
  let assistantIndex = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const content: ContentPart[] = [];
    if (message.content) content.push({ type: "text", text: message.content });
    for (const toolCall of message.toolCalls ?? [])
      content.push({ type: "tool-call", toolCall });
    emit({
      type: AgentEventType.MessageCompleted,
      messageId:
        message.id ??
        state.assistantMessageIds[assistantIndex] ??
        `assistant-${assistantIndex}`,
      role: "assistant",
      content,
    });
    assistantIndex += 1;
  }
}

function createResult(
  input: WorkflowStartInput | WorkflowResumeInput,
  state: ExecutionState,
  status: "completed" | "waiting_for_approval",
  content: string,
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
    stepsCompleted: state.stepNumbers.size,
  };
}

function failedResult(
  input: WorkflowStartInput | WorkflowResumeInput,
  state: ExecutionState,
  status: "cancelled" | "failed",
  error: string,
): AgentRunResult {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    status,
    content: "",
    messages: [],
    toolCalls: state.toolCalls,
    toolResults: state.toolResults,
    toolErrors: state.toolErrors,
    approvalRequests: [],
    stepsCompleted: state.stepNumbers.size,
    error,
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

function createPersistedToolRecordsFromMessages(
  messages: Message[],
): PersistedToolRecord[] {
  return messages.flatMap((message) => {
    if (message.role !== "tool") return [];
    return message.toolResults.map((result) => {
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
  const content = snapshot.content;
  const stepsCompleted = snapshot.stepsCompleted;
  if (
    typeof runId !== "string" ||
    typeof sessionId !== "string" ||
    !isRunStatus(status) ||
    typeof content !== "string" ||
    typeof stepsCompleted !== "number" ||
    !Number.isSafeInteger(stepsCompleted) ||
    !Array.isArray(snapshot.messages) ||
    !Array.isArray(snapshot.toolCalls) ||
    !Array.isArray(snapshot.toolResults) ||
    !Array.isArray(snapshot.toolErrors) ||
    !Array.isArray(snapshot.approvalRequests)
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
  };
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
  if (typeof value.content !== "string") return null;
  const id = typeof value.id === "string" ? { id: value.id } : {};
  if (value.role === "user" || value.role === "system") {
    return { role: value.role, content: value.content, ...id };
  }
  if (value.role === "assistant") {
    if (value.toolCalls === undefined) {
      return { role: "assistant", content: value.content, ...id };
    }
    if (!Array.isArray(value.toolCalls)) return null;
    const toolCalls = value.toolCalls.map(readToolCall);
    if (toolCalls.some((toolCall) => toolCall === null)) return null;
    return {
      role: "assistant",
      content: value.content,
      toolCalls: toolCalls.filter(
        (toolCall): toolCall is ToolCallRecord => toolCall !== null,
      ),
      ...id,
    };
  }
  if (value.role === "tool" && Array.isArray(value.toolResults)) {
    const toolResults = value.toolResults.map(readToolResult);
    if (toolResults.some((result) => result === null)) return null;
    return {
      role: "tool",
      content: value.content,
      toolResults: toolResults.filter(
        (result): result is ToolResultRecord => result !== null,
      ),
      ...id,
    };
  }
  return null;
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
    content: current.content || previous.content,
    messages:
      current.messages.length > 0 ? current.messages : previous.messages,
    toolCalls: mergeById(previous.toolCalls, current.toolCalls),
    toolResults: mergeById(previous.toolResults, current.toolResults),
    toolErrors: mergeById(previous.toolErrors, current.toolErrors),
    stepsCompleted: previous.stepsCompleted + current.stepsCompleted,
    approvalRequests:
      current.status === "waiting_for_approval" ? current.approvalRequests : [],
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
