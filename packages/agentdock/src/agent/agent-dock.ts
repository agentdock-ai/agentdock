import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { AnyAgentMiddleware } from "langchain";
import {
  CheckpointManager,
  MemoryCheckpoint,
  type CheckpointAdapter,
  type CheckpointManagerOptions,
} from "@agentdock/checkpoint";
import type { ToolApprovalDecision } from "./permissions/types.js";
import type {
  AgentContext,
  AgentRunResult,
  AgentSessionHistory,
  AgentSessionRecord,
  RunAgentOptions,
  StreamAgentResult,
  Tool,
} from "./types.js";
import {
  createSessionKey,
  defaultRunCoordinator,
  type RunCoordinator,
} from "./coordinator.js";
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
    options?: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    >,
  ): Promise<AgentSessionRecord | null>;
  getSessionHistory(
    sessionId: string,
    options?: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    >,
  ): Promise<AgentSessionHistory>;
  deleteSession(
    sessionId: string,
    options?: Pick<RunAgentOptions, "sessionNamespace">,
  ): Promise<void>;
}

export interface AgentDockCloseOptions {
  gracePeriodMs?: number;
}

export interface AgentDockOptions {
  model: BaseChatModel;
  registry?: ToolRegistry;
  checkpoint?: CheckpointAdapter;
  checkpointer?: BaseCheckpointSaver;
  defaults?: AgentDockDefaults;
  coordinator?: RunCoordinator;
  middleware?: readonly AnyAgentMiddleware[];
}

interface ActiveRun {
  sessionId: string;
  controller: AbortController;
  release: () => Promise<void> | void;
}

export class AgentDock {
  readonly model: BaseChatModel;
  readonly registry: ToolRegistry;
  readonly toolCalling: AgentDockWorkflowClient;

  private readonly defaults: AgentDockDefaults;
  private readonly checkpointManager: CheckpointManager;
  private readonly toolCallingWorkflow: AgentWorkflow;
  private readonly coordinator: RunCoordinator;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly activeExecutions = new Map<
    string,
    Promise<AgentRunResult>
  >();
  private lifecycle: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | undefined;
  private unfinishedRunIds: string[] = [];

  constructor(options: AgentDockOptions) {
    assertDockOptions(options);
    assertRunOptions(options.defaults ?? {}, false);

    this.model = options.model;
    this.registry = options.registry ?? new ToolRegistry();
    this.defaults = options.defaults ?? {};
    this.coordinator = options.coordinator ?? defaultRunCoordinator;
    const checkpointOptions: CheckpointManagerOptions = options.checkpointer
      ? { checkpointer: options.checkpointer }
      : { checkpoint: options.checkpoint ?? new MemoryCheckpoint() };
    this.checkpointManager = new CheckpointManager(checkpointOptions);
    this.toolCallingWorkflow = new ToolCallingWorkflow({
      model: this.model,
      registry: this.registry,
      checkpointer: this.checkpointManager.saver,
      middleware: options.middleware,
    });
    this.toolCalling = this.createWorkflowClient(this.toolCallingWorkflow);
  }

  async initialize(): Promise<void> {
    this.assertOpen();
    await this.checkpointManager.initialize();
  }

  close(options: AgentDockCloseOptions = {}): Promise<void> {
    if (this.lifecycle === "closed")
      return this.closePromise ?? Promise.resolve();
    if (this.closePromise) return this.closePromise;

    if (
      options.gracePeriodMs !== undefined &&
      (!Number.isFinite(options.gracePeriodMs) || options.gracePeriodMs < 0)
    ) {
      return Promise.reject(
        new Error(
          "AgentDock close gracePeriodMs must be a non-negative number.",
        ),
      );
    }

    this.lifecycle = "closing";
    for (const activeRun of this.activeRuns.values()) {
      activeRun.controller.abort(new Error("AgentDock is closing."));
    }

    const executions = [...this.activeExecutions.entries()];
    const gracePeriodMs = options.gracePeriodMs ?? 5_000;
    const allSettled = Promise.allSettled(
      executions.map(([, execution]) => execution),
    );
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const boundedWait = new Promise<void>((resolve) => {
      graceTimer = setTimeout(resolve, gracePeriodMs);
      void allSettled.then(() => {
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        resolve();
      });
    });
    this.closePromise = boundedWait
      .then(() => {
        this.unfinishedRunIds = executions
          .filter(([runId]) => this.activeExecutions.has(runId))
          .map(([runId]) => runId);
        return waitForClose(this.checkpointManager.close(), gracePeriodMs);
      })
      .finally(() => {
        this.lifecycle = "closed";
      });
    return this.closePromise;
  }

  getUnfinishedRunIds(): readonly string[] {
    return [...this.unfinishedRunIds];
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
    options: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    > = {},
  ): Promise<AgentSessionRecord | null> {
    return this.toolCalling.getSession(sessionId, options);
  }

  getSessionHistory(
    sessionId: string,
    options: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    > = {},
  ): Promise<AgentSessionHistory> {
    return this.toolCalling.getSessionHistory(sessionId, options);
  }

  async deleteSession(
    sessionId: string,
    options: Pick<RunAgentOptions, "sessionNamespace"> = {},
  ): Promise<void> {
    this.assertOpen();
    assertNonEmptyString(sessionId, "Agent session ID");
    const sessionKey = createSessionKey(sessionId, options.sessionNamespace);
    if (
      [...this.activeRuns.values()].some((run) => run.sessionId === sessionKey)
    ) {
      throw new Error(`Agent session has an active run: ${sessionId}`);
    }
    const lease = await this.coordinator.acquire({
      sessionKey,
      runId: `delete-${crypto.randomUUID()}`,
    });
    try {
      await this.checkpointManager.initialize();
      await this.toolCalling.deleteSession(sessionId, options);
    } finally {
      await lease.release();
    }
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
    this.assertOpen();
    assertNonEmptyString(userPrompt, "Agent prompt");
    assertContext(ctx);
    assertRunOptions(options, true);
    const merged = this.mergeOptions(options);

    const runId = merged.runId ?? crypto.randomUUID();
    const sessionId = options.sessionId;
    const controller = new AbortController();
    await this.claimRun(runId, sessionId, controller, merged.sessionNamespace);

    try {
      await this.prepareOperation();
      const execution = workflow.start({
        runId,
        sessionId,
        userPrompt,
        ctx,
        options: merged,
        signal: createSignal(controller, merged.abortSignal),
      });
      return this.trackExecution(execution, runId);
    } catch (error) {
      await this.releaseRun(runId, sessionId, merged.sessionNamespace);
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
    this.assertOpen();

    const sessionId = options.sessionId;
    const controller = new AbortController();
    await this.claimRun(
      input.runId,
      sessionId,
      controller,
      merged.sessionNamespace,
    );

    try {
      await this.prepareOperation();
      const checkpointRunId = await workflow.getRunId(sessionId, merged);
      if (checkpointRunId !== input.runId) {
        throw new Error(
          "Agent run ID does not match the checkpoint for this session.",
        );
      }
      const pending = await workflow.getPendingApprovalInterrupt(
        sessionId,
        merged,
      );
      const approvals = validateApprovalDecisions(
        input.approvals,
        pending?.requests ?? [],
      );
      const execution = workflow.resume({
        runId: input.runId,
        sessionId,
        ctx,
        options: merged,
        signal: createSignal(controller, merged.abortSignal),
        approvals,
        interruptId: pending!.interruptId,
      });
      return this.trackExecution(execution, input.runId);
    } catch (error) {
      await this.releaseRun(input.runId, sessionId, merged.sessionNamespace);
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
      getSessionHistory: (sessionId, options) =>
        this.getSessionHistoryWithWorkflow(workflow, sessionId, options),
      deleteSession: (sessionId, options) =>
        this.deleteSessionWithWorkflow(workflow, sessionId, options),
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
    options: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    > = {},
  ): Promise<AgentSessionRecord | null> {
    await this.prepareOperation();
    assertNonEmptyString(sessionId, "Agent session ID");
    const merged = { ...this.defaults, ...options };
    const messages = await workflow.getMessages(sessionId, merged);
    return messages.length > 0 ? { sessionId, messages } : null;
  }

  private async deleteSessionWithWorkflow(
    workflow: AgentWorkflow,
    sessionId: string,
    options: Pick<RunAgentOptions, "sessionNamespace"> = {},
  ): Promise<void> {
    await workflow.deleteSession(sessionId, options);
  }

  private async getSessionHistoryWithWorkflow(
    workflow: AgentWorkflow,
    sessionId: string,
    options: Pick<
      RunAgentOptions,
      "systemPrompt" | "maxSteps" | "sessionNamespace"
    > = {},
  ): Promise<AgentSessionHistory> {
    await this.prepareOperation();
    assertNonEmptyString(sessionId, "Agent session ID");
    const merged = { ...this.defaults, ...options };
    return workflow.getSessionHistory(sessionId, merged);
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
  ): StreamAgentResult {
    const release = () =>
      this.releaseRunByKey(runId, this.activeRuns.get(runId)?.sessionId);
    const result = execution.result
      .then(
        async (value) => {
          await release();
          return value;
        },
        async (error: unknown) => {
          try {
            await release();
          } catch (releaseError) {
            const executionMessage =
              error instanceof Error ? error.message : String(error);
            const releaseMessage =
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError);
            throw new Error(
              `Agent run failed: ${executionMessage}; coordinator release failed: ${releaseMessage}`,
            );
          }
          throw error;
        },
      )
      .finally(() => {
        this.activeExecutions.delete(runId);
      });
    this.activeExecutions.set(runId, result);
    return {
      stream: execution.stream,
      result,
    };
  }

  private async prepareOperation(): Promise<void> {
    this.assertOpen();
    await this.checkpointManager.initialize();
    this.assertOpen();
  }

  private assertOpen(): void {
    if (this.lifecycle !== "open") {
      throw new Error("AgentDock is closed or closing.");
    }
  }

  private async claimRun(
    runId: string,
    sessionId: string,
    controller: AbortController,
    sessionNamespace: string | undefined,
  ): Promise<void> {
    const lease = await this.coordinator.acquire({
      sessionKey: createSessionKey(sessionId, sessionNamespace),
      runId,
    });
    this.activeRuns.set(runId, {
      sessionId: createSessionKey(sessionId, sessionNamespace),
      controller,
      release: lease.release,
    });
  }

  private async releaseRun(
    runId: string,
    sessionId: string,
    sessionNamespace: string | undefined,
  ): Promise<void> {
    await this.releaseRunByKey(
      runId,
      createSessionKey(sessionId, sessionNamespace),
    );
  }

  private async releaseRunByKey(
    runId: string,
    sessionKey: string | undefined,
  ): Promise<void> {
    if (sessionKey === undefined) return;
    const active = this.activeRuns.get(runId);
    if (!active || active.sessionId !== sessionKey) return;
    try {
      await active.release();
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  private mergeOptions(
    options: AgentDockRunOptions | AgentDockResumeOptions,
  ): RunAgentOptions {
    return { ...this.defaults, ...options };
  }
}

function waitForClose(
  closing: Promise<void>,
  gracePeriodMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolve, reject) => {
    timer = setTimeout(resolve, gracePeriodMs);
    void closing.then(
      () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        if (timer !== undefined) clearTimeout(timer);
        reject(error);
      },
    );
  });
}
