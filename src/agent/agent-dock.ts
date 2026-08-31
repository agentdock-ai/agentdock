import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolApprovalResponse,
} from "./permissions/types.js";
import type {
  AgentContext,
  AgentRunResult,
  AgentSessionRecord,
  RunAgentOptions,
  StreamAgentResult,
  Tool,
} from "./types.js";
import { ReActWorkflow } from "./workflows/react-workflow.js";
import type { AgentWorkflow } from "./workflows/types.js";
import { isRecord } from "./value.js";
import { ToolRegistry, type ToolSchema } from "../tools/registry.js";

const DEFAULT_WORKFLOW = "react";

export type AgentDockDefaults = Omit<
  RunAgentOptions,
  "runId" | "sessionId" | "abortSignal"
>;

export type AgentDockRunOptions = Omit<RunAgentOptions, "sessionId"> & {
  sessionId: string;
};

export type AgentDockResumeOptions = Omit<AgentDockRunOptions, "runId">;

export interface AgentDockOptions {
  model: BaseChatModel;
  registry?: ToolRegistry;
  checkpointer?: BaseCheckpointSaver;
  defaults?: AgentDockDefaults;
}

interface ActiveRun {
  sessionId: string;
  controller: AbortController;
}

export class AgentDock {
  readonly model: BaseChatModel;
  readonly registry: ToolRegistry;

  private readonly defaults: AgentDockDefaults;
  private readonly workflow: AgentWorkflow;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly activeSessions = new Map<string, string>();

  constructor(options: AgentDockOptions) {
    assertDockOptions(options);
    assertRunOptions(options.defaults ?? {}, false);

    this.model = options.model;
    this.registry = options.registry ?? new ToolRegistry();
    this.defaults = options.defaults ?? {};
    this.workflow = new ReActWorkflow({
      model: this.model,
      registry: this.registry,
      checkpointer: options.checkpointer ?? new MemorySaver(),
    });
  }

  registerTool(tool: Tool): this {
    this.registry.register(tool);
    return this;
  }

  registerTools(tools: readonly Tool[]): this {
    for (const tool of tools) this.registerTool(tool);
    return this;
  }

  getTool(name: string): Tool | undefined {
    return this.registry.get(name);
  }

  getTools(): Tool[] {
    return this.registry.list();
  }

  getToolSchemas(): ToolSchema[] {
    return this.registry.schemas();
  }

  async getSession(sessionId: string): Promise<AgentSessionRecord | null> {
    assertNonEmptyString(sessionId, "Agent session ID");
    const messages = await this.workflow.getMessages(sessionId, this.defaults);
    return messages.length > 0 ? { sessionId, messages } : null;
  }

  async run(
    userPrompt: string,
    ctx: AgentContext,
    options: AgentDockRunOptions,
  ): Promise<AgentRunResult> {
    const session = await this.stream(userPrompt, ctx, options);
    for await (const _event of session.stream) {
      // stream() is the canonical execution path.
    }
    return session.result;
  }

  async stream(
    userPrompt: string,
    ctx: AgentContext,
    options: AgentDockRunOptions,
  ): Promise<StreamAgentResult> {
    assertNonEmptyString(userPrompt, "Agent prompt");
    assertContext(ctx);
    assertRunOptions(options, true);
    const merged = this.mergeOptions(options);
    this.resolveWorkflow(merged);

    const runId = merged.runId ?? crypto.randomUUID();
    const sessionId = options.sessionId;
    const controller = new AbortController();
    this.claimRun(runId, sessionId, controller);

    try {
      const execution = this.workflow.start({
        runId,
        sessionId,
        userPrompt,
        ctx,
        options: merged,
        signal: createSignal(controller, merged.abortSignal),
      });
      return this.trackExecution(execution, runId, sessionId);
    } catch (error) {
      this.releaseRun(runId, sessionId);
      throw error;
    }
  }

  async resume(
    input: { runId: string; approvals: ToolApprovalDecision[] },
    ctx: AgentContext,
    options: AgentDockResumeOptions,
  ): Promise<AgentRunResult> {
    const session = await this.resumeStream(input, ctx, options);
    for await (const _event of session.stream) {
      // stream() is the canonical execution path.
    }
    return session.result;
  }

  async resumeStream(
    input: { runId: string; approvals: ToolApprovalDecision[] },
    ctx: AgentContext,
    options: AgentDockResumeOptions,
  ): Promise<StreamAgentResult> {
    assertResumeInput(input);
    assertContext(ctx);
    assertRunOptions(options, true);
    const merged = this.mergeOptions(options);
    this.resolveWorkflow(merged);

    const sessionId = options.sessionId;
    const controller = new AbortController();
    this.claimRun(input.runId, sessionId, controller);

    try {
      const checkpointRunId = await this.workflow.getRunId(sessionId, merged);
      if (checkpointRunId !== input.runId) {
        throw new Error(
          "Agent run ID does not match the checkpoint for this session.",
        );
      }
      const pending = await this.workflow.getPendingApprovals(
        sessionId,
        merged,
      );
      const approvals = validateApprovalDecisions(input.approvals, pending);
      const execution = this.workflow.resume({
        runId: input.runId,
        sessionId,
        ctx,
        options: merged,
        signal: createSignal(controller, merged.abortSignal),
        approvals,
      });
      return this.trackExecution(execution, input.runId, sessionId);
    } catch (error) {
      this.releaseRun(input.runId, sessionId);
      throw error;
    }
  }

  async stop(runId: string): Promise<boolean> {
    assertNonEmptyString(runId, "Agent run ID");
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) return false;
    activeRun.controller.abort(new Error("Agent run cancelled."));
    return true;
  }

  private trackExecution(
    execution: StreamAgentResult,
    runId: string,
    sessionId: string,
  ): StreamAgentResult {
    return {
      stream: execution.stream,
      result: execution.result.finally(() => this.releaseRun(runId, sessionId)),
    };
  }

  private claimRun(
    runId: string,
    sessionId: string,
    controller: AbortController,
  ): void {
    if (this.activeRuns.has(runId))
      throw new Error(`Agent run is already active: ${runId}`);
    const activeRunId = this.activeSessions.get(sessionId);
    if (activeRunId)
      throw new Error(`Agent session already has an active run: ${sessionId}`);
    this.activeRuns.set(runId, { sessionId, controller });
    this.activeSessions.set(sessionId, runId);
  }

  private releaseRun(runId: string, sessionId: string): void {
    this.activeRuns.delete(runId);
    if (this.activeSessions.get(sessionId) === runId)
      this.activeSessions.delete(sessionId);
  }

  private mergeOptions(
    options: AgentDockRunOptions | AgentDockResumeOptions,
  ): RunAgentOptions {
    return { ...this.defaults, ...options };
  }

  private resolveWorkflow(
    options: Pick<RunAgentOptions, "workflow">,
  ): typeof DEFAULT_WORKFLOW {
    const workflow =
      options.workflow ?? this.defaults.workflow ?? DEFAULT_WORKFLOW;
    if (workflow === DEFAULT_WORKFLOW) return workflow;
    throw new Error(
      `Unsupported AgentDock workflow: ${workflow}. Supported workflows: ${DEFAULT_WORKFLOW}`,
    );
  }
}

function assertDockOptions(
  options: unknown,
): asserts options is AgentDockOptions {
  if (!isRecord(options) || !isRecord(options.model)) {
    throw new Error("AgentDock requires a LangChain chat model.");
  }
  if (
    options.registry !== undefined &&
    !(options.registry instanceof ToolRegistry)
  ) {
    throw new Error("AgentDock registry must be a ToolRegistry instance.");
  }
  if (options.checkpointer !== undefined && !isRecord(options.checkpointer)) {
    throw new Error("AgentDock checkpointer must be a LangGraph checkpointer.");
  }
}

function assertResumeInput(
  input: unknown,
): asserts input is { runId: string; approvals: ToolApprovalDecision[] } {
  if (!isRecord(input))
    throw new Error("Agent resume input must be an object.");
  assertNonEmptyString(input.runId, "Agent run ID");
  if (!Array.isArray(input.approvals))
    throw new Error("Approval decisions must be an array.");
}

function assertContext(ctx: unknown): asserts ctx is AgentContext {
  if (!isRecord(ctx)) throw new Error("Agent context must be an object.");
}

function assertRunOptions(
  options: unknown,
  requireSessionId: boolean,
): asserts options is RunAgentOptions {
  if (!isRecord(options))
    throw new Error("Agent run options must be an object.");
  assertOptionalString(options.runId, "Agent run ID");
  assertOptionalString(options.sessionId, "Agent session ID");
  assertOptionalString(options.workflow, "Agent workflow");
  assertOptionalString(options.systemPrompt, "Agent system prompt", false);
  if (requireSessionId)
    assertNonEmptyString(options.sessionId, "Agent session ID");
  if (
    options.maxSteps !== undefined &&
    (typeof options.maxSteps !== "number" ||
      !Number.isSafeInteger(options.maxSteps) ||
      options.maxSteps <= 0)
  ) {
    throw new Error("Agent maxSteps must be a positive integer.");
  }
  if (
    options.toolTimeout !== undefined &&
    (typeof options.toolTimeout !== "number" ||
      !Number.isFinite(options.toolTimeout) ||
      options.toolTimeout <= 0)
  ) {
    throw new Error("Agent toolTimeout must be a positive number.");
  }
  if (
    options.abortSignal !== undefined &&
    !isAbortSignal(options.abortSignal)
  ) {
    throw new Error("Agent abortSignal must be an AbortSignal.");
  }
}

function validateApprovalDecisions(
  decisions: unknown,
  pending: ToolApprovalRequest[],
): ToolApprovalResponse[] {
  if (!Array.isArray(decisions))
    throw new Error("Approval decisions must be an array.");
  if (pending.length === 0 || decisions.length !== pending.length) {
    throw new Error("Approval decisions do not match a pending AgentDock run.");
  }

  const byId = new Map<string, ToolApprovalDecision>();
  for (const decision of decisions) {
    if (!isRecord(decision))
      throw new Error("Each approval decision must be an object.");
    assertNonEmptyString(decision.approvalId, "Approval ID");
    if (typeof decision.approved !== "boolean") {
      throw new Error("Approval decision approved must be a boolean.");
    }
    if (decision.reason !== undefined && typeof decision.reason !== "string") {
      throw new Error("Approval decision reason must be a string.");
    }
    if (byId.has(decision.approvalId)) {
      throw new Error("Approval decisions must use unique approval IDs.");
    }
    byId.set(decision.approvalId, {
      approvalId: decision.approvalId,
      approved: decision.approved,
      ...(typeof decision.reason === "string"
        ? { reason: decision.reason }
        : {}),
    });
  }

  return pending.map((request) => {
    const decision = byId.get(request.approvalId);
    if (!decision)
      throw new Error(
        "Approval decisions do not match a pending AgentDock run.",
      );
    return { ...decision, toolCall: request.toolCall };
  });
}

function createSignal(
  controller: AbortController,
  signal: AbortSignal | undefined,
): AbortSignal {
  return signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;
}

function assertOptionalString(
  value: unknown,
  label: string,
  nonEmpty = true,
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || (nonEmpty && !value.trim())) {
    throw new Error(
      `${label} must be a${nonEmpty ? " non-empty" : ""} string.`,
    );
  }
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  assertOptionalString(value, label);
  if (value === undefined) throw new Error(`${label} is required.`);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function"
  );
}
