import { streamText, type LanguageModel, type ModelMessage } from "ai";
import { createAgentRunResult } from "./runtime/result.js";
import {
  buildModelRequest,
  prepareAgentRun,
  prepareAgentRunFromHistory,
} from "./runtime/run-context.js";
import {
  clearRunController,
  registerRunController,
  stopRunController,
} from "./runs/runtime.js";
import {
  type AgentRunApprovalClaim,
  type AgentRunRecord,
} from "./runs/store.js";
import {
  type AgentSessionRecord,
} from "./sessions/store.js";
import {
  type AgentStore,
  InMemoryAgentStore,
} from "./storage/store.js";
import { AgentEventType } from "./events.js";
import {
  AgentEventStream,
  serializeApprovalResponses,
} from "./runtime/events.js";
import type {
  ToolApprovalDecision,
  ToolApprovalResponse,
} from "./permissions/types.js";
import type {
  AgentContext,
  AgentRunResult,
  RunAgentOptions,
  StreamAgentResult,
  Tool,
} from "./types.js";
import { ToolRegistry, type ToolSchema } from "../tools/registry.js";

export type AgentDockDefaults = Omit<
  RunAgentOptions,
  "model" | "registry" | "runId" | "sessionId" | "messages" | "abortSignal"
>;

export type AgentDockRunOptions = Omit<
  RunAgentOptions,
  "model" | "registry" | "sessionId" | "messages"
> & { sessionId: string };

export type AgentDockResumeOptions = Omit<AgentDockRunOptions, "sessionId"> & {
  sessionId?: string;
};

export interface AgentDockOptions {
  model: LanguageModel;
  registry?: ToolRegistry;
  store?: AgentStore;
  defaults?: AgentDockDefaults;
}

export class AgentDock {
  readonly model: LanguageModel;
  readonly registry: ToolRegistry;

  private readonly runStore: AgentStore["runs"];
  private readonly sessionStore: AgentStore["sessions"];
  private readonly defaults: AgentDockDefaults;

  constructor(options: AgentDockOptions) {
    this.model = options.model;
    this.registry = options.registry ?? new ToolRegistry();
    const store = options.store ?? new InMemoryAgentStore();
    this.runStore = store.runs;
    this.sessionStore = store.sessions;
    this.defaults = options.defaults ?? {};
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

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    return this.runStore.get(runId);
  }

  async getSession(sessionId: string): Promise<AgentSessionRecord | null> {
    return this.sessionStore.get(sessionId);
  }

  async run(
    userPrompt: string,
    ctx: AgentContext,
    options: AgentDockRunOptions,
  ): Promise<AgentRunResult> {
    const session = await this.stream(userPrompt, ctx, options);
    for await (const _event of session.stream) {
      // Drain the live event stream so the underlying model stream completes.
    }
    return session.result;
  }

  async stream(
    userPrompt: string,
    ctx: AgentContext,
    options: AgentDockRunOptions,
  ): Promise<StreamAgentResult> {
    const runId = options.runId ?? crypto.randomUUID();
    const session = await this.sessionStore.get(options.sessionId);
    const abortSignal = this.createRunAbortSignal(runId, options.abortSignal);
    let prepared;

    try {
      prepared = await prepareAgentRun(userPrompt, ctx, {
        ...this.buildRunOptions(options),
        runId,
        abortSignal,
        messages: session?.messages ?? [],
      });
      await this.saveRunningRun(runId, prepared.sessionId, prepared.history);
    } catch (error) {
      clearRunController(runId);
      throw error;
    }

    try {
      const stream = streamText(buildModelRequest(prepared));
      const result = this.createStreamResult(stream, prepared, runId, 0);

      return {
        stream: new AgentEventStream({
          runId,
          rawStream: stream.fullStream,
          result,
          getRun: () => this.getRun(runId),
          initialEvents: [{ type: AgentEventType.RunStarted }],
        }),
        result,
      };
    } catch (error) {
      await this.markRunFailed(runId, error);
      clearRunController(runId);
      throw error;
    }
  }

  async resume(
    input: { runId: string; approvals: ToolApprovalDecision[] },
    ctx: AgentContext,
    options: AgentDockResumeOptions = {},
  ): Promise<AgentRunResult> {
    const session = await this.resumeStream(input, ctx, options);
    for await (const _event of session.stream) {
      // Drain the live event stream so the underlying model stream completes.
    }
    return session.result;
  }

  async resumeStream(
    input: { runId: string; approvals: ToolApprovalDecision[] },
    ctx: AgentContext,
    options: AgentDockResumeOptions = {},
  ): Promise<StreamAgentResult> {
    const claim = await this.claimApprovalRun(input.runId, input.approvals);
    if (options.sessionId && options.sessionId !== claim.record.sessionId) {
      throw new Error(`Agent run does not belong to session: ${options.sessionId}`);
    }
    const history = buildApprovalHistory(claim, input.approvals);
    const abortSignal = this.createRunAbortSignal(input.runId, options.abortSignal);
    let prepared;
    const approvalResponses = buildApprovalResponses(claim, input.approvals);

    try {
      prepared = await prepareAgentRunFromHistory(
        history,
        ctx,
        {
          ...this.buildRunOptions(options),
          runId: input.runId,
          sessionId: claim.record.sessionId,
          abortSignal,
        },
        claim.record.stepsCompleted,
      );
      await this.runStore.update(input.runId, { messages: history });
      await this.persistSessionMessages(
        claim.record.sessionId,
        history,
        claim.record.runId,
      );
      const stream = streamText(buildModelRequest(prepared));
      const result = this.createStreamResult(
        stream,
        prepared,
        input.runId,
        claim.record.stepsCompleted,
      );

      return {
        stream: new AgentEventStream({
          runId: input.runId,
          rawStream: stream.fullStream,
          result,
          getRun: () => this.getRun(input.runId),
          initialEvents: [{
            type: AgentEventType.ApprovalResolved,
            approvals: serializeApprovalResponses(approvalResponses),
          }],
          stepOffset: claim.record.stepsCompleted,
        }),
        result,
      };
    } catch (error) {
      await this.markRunFailed(input.runId, error);
      clearRunController(input.runId);
      throw error;
    }
  }

  async stop(runId: string): Promise<void> {
    const record = await this.runStore.get(runId);
    if (!record) throw new Error(`Agent run not found: ${runId}`);
    if (
      record.status === "completed" ||
      record.status === "failed" ||
      record.status === "cancelled"
    ) {
      return;
    }

    stopRunController(runId);
    await this.runStore.transition(
      runId,
      ["running", "waiting_for_approval"],
      {
        status: "cancelled",
        pendingApprovals: [],
      },
    );
  }

  private buildRunOptions(
    options: AgentDockRunOptions | AgentDockResumeOptions,
  ): RunAgentOptions {
    return {
      ...this.defaults,
      ...options,
      model: this.model,
      registry: this.registry,
    };
  }

  private createRunAbortSignal(
    runId: string,
    callerSignal?: AbortSignal,
  ): AbortSignal {
    const runSignal = registerRunController(runId);
    return callerSignal
      ? AbortSignal.any([callerSignal, runSignal])
      : runSignal;
  }

  private async saveRunningRun(
    runId: string,
    sessionId: string,
    messages: AgentRunRecord["messages"],
  ): Promise<void> {
    await this.runStore.save({
      runId,
      sessionId,
      status: "running",
      messages,
      pendingApprovals: [],
      stepsCompleted: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await this.persistSessionMessages(sessionId, messages, runId);
  }

  private createStreamResult(
    stream: ReturnType<typeof streamText>,
    prepared: Awaited<ReturnType<typeof prepareAgentRunFromHistory>>,
    runId: string,
    stepsCompleted: number,
  ): Promise<AgentRunResult> {
    return Promise.all([
      stream.text,
      stream.responseMessages,
      stream.toolCalls,
      stream.toolResults,
      stream.content,
      stream.steps,
    ])
      .then(async ([text, responseMessages, toolCalls, toolResults, content, steps]) => {
        const output = createAgentRunResult(
          prepared,
          text,
          responseMessages as ModelMessage[],
          toolCalls,
          toolResults,
          content,
          stepsCompleted + steps.length,
        );
        await this.persistResult(output);
        clearRunController(runId);
        return output;
      })
      .catch(async (error) => {
        const current = await this.runStore.get(runId);
        if (current?.status === "cancelled") {
          clearRunController(runId);
          return this.createCancelledResult(prepared, stepsCompleted);
        }

        await this.markRunFailed(runId, error);
        clearRunController(runId);
        throw error;
      });
  }

  private createCancelledResult(
    prepared: Awaited<ReturnType<typeof prepareAgentRunFromHistory>>,
    stepsCompleted: number,
  ): AgentRunResult {
    return createAgentRunResult(
      prepared,
      "",
      [],
      [],
      [],
      [],
      stepsCompleted,
      "cancelled",
    );
  }

  private async persistResult(result: AgentRunResult): Promise<void> {
    const waitingForApproval = result.approvalRequests.length > 0;
    const persisted = await this.runStore.transition(result.runId, "running", {
      status: waitingForApproval ? "waiting_for_approval" : "completed",
      messages: result.messages,
      pendingApprovals: result.approvalRequests,
      stepsCompleted: result.stepsCompleted,
    });

    if (!persisted) {
      const current = await this.runStore.get(result.runId);
      if (current?.status === "cancelled") {
        result.status = "cancelled";
        return;
      }
      throw new Error(`Agent run is no longer active: ${result.runId}`);
    }

    await this.persistSessionMessages(result.sessionId, result.messages, result.runId);
    result.status = waitingForApproval ? "waiting_for_approval" : "completed";
  }

  private async persistSessionMessages(
    sessionId: string,
    messages: AgentSessionRecord["messages"],
    latestRunId?: string,
  ): Promise<void> {
    const current = await this.sessionStore.get(sessionId);
    if (!current) {
      await this.sessionStore.save({
        sessionId,
        messages,
        ...(latestRunId ? { latestRunId } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return;
    }

    await this.sessionStore.update(sessionId, {
      messages,
      ...(latestRunId ? { latestRunId } : {}),
    });
  }

  private async markRunFailed(runId: string, error: unknown): Promise<void> {
    const failed = await this.runStore.transition(runId, "running", {
      status: "failed",
      error: error instanceof Error ? error.message : "Agent run failed",
    });

    if (!failed) {
      const current = await this.runStore.get(runId);
      if (current?.status === "cancelled") return;
      if (!current) return;
      if (current.status === "failed") return;
      throw new Error(`Agent run is no longer active: ${runId}`);
    }
  }

  private async claimApprovalRun(
    runId: string,
    decisions: ToolApprovalDecision[],
  ): Promise<AgentRunApprovalClaim> {
    const claim = await this.runStore.claimApprovals(runId, decisions);
    if (!claim) {
      throw new Error(
        `Agent run approval claim failed: ${runId} is no longer waiting for the supplied approvals`,
      );
    }
    return claim;
  }
}

function buildApprovalHistory(
  claim: AgentRunApprovalClaim,
  decisions: ToolApprovalDecision[],
): AgentRunRecord["messages"] {
  return [
    ...claim.record.messages,
    {
      role: "tool",
      content: "",
      toolResults: [],
      approvalResponses: buildApprovalResponses(claim, decisions),
    },
  ];
}

function buildApprovalResponses(
  claim: AgentRunApprovalClaim,
  decisions: ToolApprovalDecision[],
): ToolApprovalResponse[] {
  const decisionsById = new Map(
    decisions.map((decision) => [decision.approvalId, decision]),
  );

  return claim.approvals.map((approval) => {
    const decision = decisionsById.get(approval.approvalId)!;
    return {
      approvalId: approval.approvalId,
      toolCall: approval.toolCall,
      approved: decision.approved,
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
  });
}
