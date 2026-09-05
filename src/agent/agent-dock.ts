import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { ToolApprovalDecision } from "./permissions/types.js";
import type {
  AgentContext,
  AgentRunResult,
  AgentSessionRecord,
  RunAgentOptions,
  StreamAgentResult,
  Tool,
} from "./types.js";
import { ToolCallingWorkflow } from "./workflows/tool-calling/workflow.js";
import type { AgentWorkflow } from "./workflows/types.js";
import { ToolRegistry, type ToolSchema } from "../tools/registry.js";
import {
  assertContext,
  assertDockOptions,
  assertNonEmptyString,
  assertResumeInput,
  assertRunOptions,
  createSignal,
  validateApprovalDecisions,
} from "./validation.js";

export type AgentDockDefaults = Omit<
  RunAgentOptions,
  "runId" | "sessionId" | "abortSignal"
>;

export type AgentDockRunOptions = Omit<RunAgentOptions, "sessionId"> & {
  sessionId: string;
};

export type AgentDockResumeOptions = Omit<AgentDockRunOptions, "runId">;

export interface AgentDockWorkflowClient {
  stream(
    userPrompt: string,
    ctx: AgentContext,
    options: AgentDockRunOptions,
  ): Promise<StreamAgentResult>;
  run(
    userPrompt: string,
    ctx: AgentContext,
    options: AgentDockRunOptions,
  ): Promise<AgentRunResult>;
  resume(
    input: { runId: string; approvals: ToolApprovalDecision[] },
    ctx: AgentContext,
    options: AgentDockResumeOptions,
  ): Promise<AgentRunResult>;
  resumeStream(
    input: { runId: string; approvals: ToolApprovalDecision[] },
    ctx: AgentContext,
    options: AgentDockResumeOptions,
  ): Promise<StreamAgentResult>;
  getSession(
    sessionId: string,
    options?: Pick<RunAgentOptions, "systemPrompt" | "maxSteps">,
  ): Promise<AgentSessionRecord | null>;
}

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
  readonly toolCalling: AgentDockWorkflowClient;

  private readonly defaults: AgentDockDefaults;
  private readonly toolCallingWorkflow: AgentWorkflow;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly activeSessions = new Map<string, string>();

  constructor(options: AgentDockOptions) {
    assertDockOptions(options);
    assertRunOptions(options.defaults ?? {}, false);

    this.model = options.model;
    this.registry = options.registry ?? new ToolRegistry();
    this.defaults = options.defaults ?? {};
    this.toolCallingWorkflow = new ToolCallingWorkflow({
      model: this.model,
      registry: this.registry,
      checkpointer: options.checkpointer ?? new MemorySaver(),
    });
    this.toolCalling = this.createWorkflowClient(this.toolCallingWorkflow);
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

  getSession(
    sessionId: string,
    options: Pick<RunAgentOptions, "systemPrompt" | "maxSteps"> = {},
  ): Promise<AgentSessionRecord | null> {
    return this.toolCalling.getSession(sessionId, options);
  }

  run(
    userPrompt: string,
    ctx: AgentContext,
    options: AgentDockRunOptions,
  ): Promise<AgentRunResult> {
    return this.toolCalling.run(userPrompt, ctx, options);
  }

  stream(
    userPrompt: string,
    ctx: AgentContext,
    options: AgentDockRunOptions,
  ): Promise<StreamAgentResult> {
    return this.streamWithWorkflow(
      this.toolCallingWorkflow,
      userPrompt,
      ctx,
      options,
    );
  }

  private async streamWithWorkflow(
    workflow: AgentWorkflow,
    userPrompt: string,
    ctx: AgentContext,
    options: AgentDockRunOptions,
  ): Promise<StreamAgentResult> {
    assertNonEmptyString(userPrompt, "Agent prompt");
    assertContext(ctx);
    assertRunOptions(options, true);
    const merged = this.mergeOptions(options);

    const runId = merged.runId ?? crypto.randomUUID();
    const sessionId = options.sessionId;
    const controller = new AbortController();
    this.claimRun(runId, sessionId, controller);

    try {
      const execution = workflow.start({
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

  resume(
    input: { runId: string; approvals: ToolApprovalDecision[] },
    ctx: AgentContext,
    options: AgentDockResumeOptions,
  ): Promise<AgentRunResult> {
    return this.toolCalling.resume(input, ctx, options);
  }

  resumeStream(
    input: { runId: string; approvals: ToolApprovalDecision[] },
    ctx: AgentContext,
    options: AgentDockResumeOptions,
  ): Promise<StreamAgentResult> {
    return this.resumeStreamWithWorkflow(
      this.toolCallingWorkflow,
      input,
      ctx,
      options,
    );
  }

  private async resumeStreamWithWorkflow(
    workflow: AgentWorkflow,
    input: { runId: string; approvals: ToolApprovalDecision[] },
    ctx: AgentContext,
    options: AgentDockResumeOptions,
  ): Promise<StreamAgentResult> {
    assertResumeInput(input);
    assertContext(ctx);
    assertRunOptions(options, true);
    const merged = this.mergeOptions(options);

    const sessionId = options.sessionId;
    const controller = new AbortController();
    this.claimRun(input.runId, sessionId, controller);

    try {
      const checkpointRunId = await workflow.getRunId(sessionId, merged);
      if (checkpointRunId !== input.runId) {
        throw new Error(
          "Agent run ID does not match the checkpoint for this session.",
        );
      }
      const pending = await workflow.getPendingApprovals(sessionId, merged);
      const approvals = validateApprovalDecisions(input.approvals, pending);
      const execution = workflow.resume({
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

  private createWorkflowClient(
    workflow: AgentWorkflow,
  ): AgentDockWorkflowClient {
    return {
      stream: (userPrompt, ctx, options) =>
        this.streamWithWorkflow(workflow, userPrompt, ctx, options),
      run: (userPrompt, ctx, options) =>
        this.runWithWorkflow(workflow, userPrompt, ctx, options),
      resume: (input, ctx, options) =>
        this.resumeWithWorkflow(workflow, input, ctx, options),
      resumeStream: (input, ctx, options) =>
        this.resumeStreamWithWorkflow(workflow, input, ctx, options),
      getSession: (sessionId, options) =>
        this.getSessionWithWorkflow(workflow, sessionId, options),
    };
  }

  private async runWithWorkflow(
    workflow: AgentWorkflow,
    userPrompt: string,
    ctx: AgentContext,
    options: AgentDockRunOptions,
  ): Promise<AgentRunResult> {
    const session = await this.streamWithWorkflow(
      workflow,
      userPrompt,
      ctx,
      options,
    );
    for await (const _event of session.stream) {
      // stream() is the canonical execution path.
    }
    return session.result;
  }

  private async resumeWithWorkflow(
    workflow: AgentWorkflow,
    input: { runId: string; approvals: ToolApprovalDecision[] },
    ctx: AgentContext,
    options: AgentDockResumeOptions,
  ): Promise<AgentRunResult> {
    const session = await this.resumeStreamWithWorkflow(
      workflow,
      input,
      ctx,
      options,
    );
    for await (const _event of session.stream) {
      // resumeStream() is the canonical execution path.
    }
    return session.result;
  }

  private async getSessionWithWorkflow(
    workflow: AgentWorkflow,
    sessionId: string,
    options: Pick<RunAgentOptions, "systemPrompt" | "maxSteps"> = {},
  ): Promise<AgentSessionRecord | null> {
    assertNonEmptyString(sessionId, "Agent session ID");
    const merged = { ...this.defaults, ...options };
    const messages = await workflow.getMessages(sessionId, merged);
    return messages.length > 0 ? { sessionId, messages } : null;
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
}
