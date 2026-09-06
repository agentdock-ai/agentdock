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
} from "langchain";
import { z } from "zod";
import { AgentEventType, type AgentEventPayload } from "../../events.js";
import type { Message } from "../../memory.js";
import type {
  ToolApprovalRequest,
  ToolApprovalResponse,
} from "../../permissions/types.js";
import type {
  AgentRunResult,
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
  readStateMessages,
  readStateRunId,
  readStepNumber,
  stateHasInterrupt,
  toToolCallRecord,
} from "./message-adapter.js";
import { createToolCallingTools, type ToolOutcomes } from "./tools.js";
import { errorMessage, isRecord, messageText } from "../../value.js";
import type {
  AgentWorkflow,
  WorkflowResumeInput,
  WorkflowStartInput,
} from "../types.js";

const AGENT_STATE_SCHEMA = z.object({ agentdockRunId: z.string().optional() });

export interface ToolCallingWorkflowOptions {
  model: BaseChatModel;
  registry: ToolRegistry;
  checkpointer: BaseCheckpointSaver;
}

interface ExecutionState {
  toolCalls: ToolCallRecord[];
  toolCallsById: Map<string, ToolCallRecord>;
  toolOutcomes: ToolOutcomes;
  toolResults: ToolResultRecord[];
  toolErrors: ToolErrorRecord[];
  stepNumbers: Set<number>;
  approvalRequests: ToolApprovalRequest[];
  textByMessageId: Map<string, string>;
}

type ApprovalInterrupts = Record<
  string,
  { allowedDecisions: ("approve" | "reject")[] }
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
    options: Pick<RunAgentOptions, "systemPrompt" | "maxSteps"> = {},
  ): Promise<Message[]> {
    const state = await this.createAgent(options, new Map()).getState(
      this.runConfig(sessionId, {}, undefined),
    );
    return normalizeMessages(readStateMessages(state), new Map());
  }

  async getRunId(
    sessionId: string,
    options: Pick<RunAgentOptions, "systemPrompt" | "maxSteps"> = {},
  ): Promise<string | null> {
    const state = await this.createAgent(options, new Map()).getState(
      this.runConfig(sessionId, {}, undefined),
    );
    return readStateRunId(state);
  }

  async getPendingApprovals(
    sessionId: string,
    options: Pick<RunAgentOptions, "systemPrompt" | "maxSteps"> = {},
  ): Promise<ToolApprovalRequest[]> {
    const agent = this.createAgent(options, new Map());
    const state = await agent.getState(
      this.runConfig(sessionId, {}, undefined),
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

  private startExecution(
    input: WorkflowStartInput | WorkflowResumeInput,
    mode: "start" | "resume",
  ): StreamAgentResult {
    const stream = new AgentEventStream(input.runId);
    const emit = (payload: AgentEventPayload): void => stream.emit(payload);
    const result = this.execute(input, mode, emit).finally(() =>
      stream.close(),
    );

    return { stream, result };
  }

  private async execute(
    input: WorkflowStartInput | WorkflowResumeInput,
    mode: "start" | "resume",
    emit: (payload: AgentEventPayload) => void,
  ): Promise<AgentRunResult> {
    const state = createExecutionState();
    const agent = this.createAgent(input.options, state.toolOutcomes);
    const config = this.runConfig(input.sessionId, input.ctx, input.signal);

    emit({ type: AgentEventType.RunStarted, sessionId: input.sessionId });
    emit({ type: AgentEventType.StreamStarted });
    if (mode === "resume" && "approvals" in input) {
      for (const approval of input.approvals)
        this.recordToolCall(approval.toolCall, state);
      emit({
        type: AgentEventType.ApprovalResolved,
        approvals: input.approvals,
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
      const messages = normalizeMessages(
        readStateMessages(graphState),
        state.toolCallsById,
      );
      const content = findFinalContent(messages);
      if (state.approvalRequests.length > 0 || stateHasInterrupt(graphState)) {
        const approvalRequests =
          state.approvalRequests.length > 0
            ? state.approvalRequests
            : await this.getPendingApprovals(input.sessionId, input.options);
        emit({
          type: AgentEventType.RunWaitingForApproval,
          approvals: approvalRequests,
        });
        return createResult(
          input,
          state,
          "waiting_for_approval",
          content,
          messages,
          approvalRequests,
        );
      }

      emit({
        type: AgentEventType.RunCompleted,
        content,
        stepsCompleted: state.stepNumbers.size,
      });
      return createResult(input, state, "completed", content, messages, []);
    } catch (error) {
      const message = errorMessage(error);
      if (input.signal.aborted) {
        emit({ type: AgentEventType.RunCancelled, reason: message });
        return failedResult(input, state, "cancelled", message);
      }
      emit({
        type: AgentEventType.RunFailed,
        error: { code: "agent_execution_failed", message },
      });
      return failedResult(input, state, "failed", message);
    }
  }

  private createAgent(
    options: Pick<RunAgentOptions, "systemPrompt" | "maxSteps" | "toolTimeout">,
    outcomes: ToolOutcomes,
  ) {
    return createAgent({
      model: this.model,
      tools: createToolCallingTools(
        this.registry,
        options.toolTimeout,
        outcomes,
      ),
      checkpointer: this.checkpointer,
      stateSchema: AGENT_STATE_SCHEMA,
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      middleware: this.createMiddleware(options),
    });
  }

  private createMiddleware(options: Pick<RunAgentOptions, "maxSteps">) {
    const middleware = [];
    const interruptOn = this.createApprovalInterrupts();

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

  private createApprovalInterrupts(): ApprovalInterrupts {
    const interruptOn: ApprovalInterrupts = {};

    for (const tool of this.registry.list()) {
      if (tool.requiresApproval !== true) continue;

      interruptOn[tool.name] = {
        allowedDecisions: ["approve", "reject"],
      };
    }

    return interruptOn;
  }

  private runConfig(
    sessionId: string,
    ctx: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) {
    return {
      configurable: { thread_id: sessionId },
      context: ctx,
      ...(signal ? { signal } : {}),
    };
  }

  private consumeStreamChunk(
    chunk: unknown,
    state: ExecutionState,
    emit: (payload: AgentEventPayload) => void,
  ): void {
    if (!isStreamChunk(chunk)) return;
    const [mode, payload] = chunk;
    if (mode === "messages") this.consumeMessagePayload(payload, state, emit);
    if (mode === "updates") this.consumeUpdatePayload(payload, state, emit);
  }

  private consumeMessagePayload(
    payload: unknown,
    state: ExecutionState,
    emit: (payload: AgentEventPayload) => void,
  ): void {
    if (!Array.isArray(payload) || payload.length !== 2) return;
    const [message, metadata] = payload;
    if (isBaseMessage(message) && isAIMessage(message)) {
      this.consumeAssistantMessage(message, metadata, state, emit, false);
      return;
    }
    if (isBaseMessageChunk(message) && isAIMessageChunk(message)) {
      this.consumeAssistantMessage(message, metadata, state, emit, true);
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
        emit({ type: AgentEventType.ToolError, error: outcome.error });
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
      emit({ type: AgentEventType.ToolResult, result });
    }
  }

  private consumeAssistantMessage(
    message: { id?: string; content: unknown; tool_calls?: unknown[] },
    metadata: unknown,
    state: ExecutionState,
    emit: (payload: AgentEventPayload) => void,
    isChunk: boolean,
  ): void {
    const messageId = message.id ?? crypto.randomUUID();
    const text = messageText(message.content);
    const delta = isChunk ? text : getMessageDelta(state, messageId, text);
    if (delta)
      emit({ type: AgentEventType.TextDelta, id: messageId, text: delta });
    for (const rawToolCall of message.tool_calls ?? []) {
      const toolCall = toToolCallRecord(rawToolCall);
      if (this.recordToolCall(toolCall, state))
        emit({ type: AgentEventType.ToolCalled, toolCall });
    }
    const step = readStepNumber(metadata);
    if (step !== null) state.stepNumbers.add(step);
  }

  private consumeUpdatePayload(
    payload: unknown,
    state: ExecutionState,
    emit: (payload: AgentEventPayload) => void,
  ): void {
    if (!isRecord(payload) || !("__interrupt__" in payload)) return;
    const approvals = state.toolCalls
      .filter(
        (toolCall) =>
          this.registry.get(toolCall.name)?.requiresApproval === true,
      )
      .map((toolCall) => ({ approvalId: toolCall.toolCallId, toolCall }));
    if (approvals.length === 0) return;
    state.approvalRequests = approvals;
    emit({ type: AgentEventType.ApprovalRequired, approvals });
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
    toolCallsById: new Map(),
    toolOutcomes: new Map(),
    toolResults: [],
    toolErrors: [],
    stepNumbers: new Set(),
    approvalRequests: [],
    textByMessageId: new Map(),
  };
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

function createResult(
  input: WorkflowStartInput | WorkflowResumeInput,
  state: ExecutionState,
  status: "completed" | "waiting_for_approval",
  content: string,
  messages: Message[],
  approvalRequests: ToolApprovalRequest[],
): AgentRunResult {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    status,
    content,
    messages,
    toolCalls: state.toolCalls,
    toolResults: state.toolResults,
    toolErrors: state.toolErrors,
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
