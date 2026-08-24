import {
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
} from "ai";
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
  type AgentRunStore,
  InMemoryAgentRunStore,
} from "./runs/store.js";
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
  "model" | "registry" | "runId" | "messages" | "abortSignal"
>;

export type AgentDockRunOptions = Omit<
  RunAgentOptions,
  "model" | "registry"
>;

export interface AgentDockOptions {
  model: LanguageModel;
  registry?: ToolRegistry;
  runStore?: AgentRunStore;
  defaults?: AgentDockDefaults;
}

export class AgentDock {
  readonly model: LanguageModel;
  readonly registry: ToolRegistry;
  readonly runStore: AgentRunStore;

  private readonly defaults: AgentDockDefaults;

  constructor(options: AgentDockOptions) {
    this.model = options.model;
    this.registry = options.registry ?? new ToolRegistry();
    this.runStore = options.runStore ?? new InMemoryAgentRunStore();
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

  async run(
    userPrompt: string,
    ctx: AgentContext,
    options: AgentDockRunOptions = {},
  ): Promise<AgentRunResult> {
    const runId = options.runId ?? crypto.randomUUID();
    const abortSignal = this.createRunAbortSignal(runId, options.abortSignal);
    let prepared;

    try {
      prepared = await prepareAgentRun(userPrompt, ctx, {
        ...this.buildRunOptions(options),
        runId,
        abortSignal,
      });
      await this.saveRunningRun(runId, prepared.history);
    } catch (error) {
      clearRunController(runId);
      throw error;
    }

    try {
      const result = await generateText(buildModelRequest(prepared));
      const output = createAgentRunResult(
        prepared,
        result.text,
        result.responseMessages,
        result.toolCalls,
        result.toolResults,
        result.content,
        result.steps.length,
      );
      await this.persistResult(output);
      return output;
    } catch (error) {
      await this.markRunFailed(runId, error);
      throw error;
    } finally {
      clearRunController(runId);
    }
  }

  async stream(
    userPrompt: string,
    ctx: AgentContext,
    options: AgentDockRunOptions = {},
  ): Promise<StreamAgentResult> {
    const runId = options.runId ?? crypto.randomUUID();
    const abortSignal = this.createRunAbortSignal(runId, options.abortSignal);
    let prepared;

    try {
      prepared = await prepareAgentRun(userPrompt, ctx, {
        ...this.buildRunOptions(options),
        runId,
        abortSignal,
      });
      await this.saveRunningRun(runId, prepared.history);
    } catch (error) {
      clearRunController(runId);
      throw error;
    }

    const stream = streamText(buildModelRequest(prepared));
    const result = Promise.all([
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
          steps.length,
        );
        await this.persistResult(output);
        clearRunController(runId);
        return output;
      })
      .catch(async (error) => {
        await this.markRunFailed(runId, error);
        clearRunController(runId);
        throw error;
      });

    return { stream: stream.fullStream, result };
  }

  async resume(
    input: { runId: string; approvals: ToolApprovalDecision[] },
    ctx: AgentContext,
    options: AgentDockRunOptions = {},
  ): Promise<AgentRunResult> {
    const claim = await this.claimApprovalRun(input.runId, input.approvals);
    const history = buildApprovalHistory(claim, input.approvals);
    const abortSignal = this.createRunAbortSignal(input.runId, options.abortSignal);

    try {
      const prepared = await prepareAgentRunFromHistory(
        history,
        ctx,
        {
          ...this.buildRunOptions(options),
          runId: input.runId,
          abortSignal,
        },
        claim.record.stepsCompleted,
      );
      await this.runStore.update(input.runId, { messages: history });

      const result = await generateText(buildModelRequest(prepared));
      const output = createAgentRunResult(
        prepared,
        result.text,
        result.responseMessages,
        result.toolCalls,
        result.toolResults,
        result.content,
        claim.record.stepsCompleted + result.steps.length,
      );
      await this.persistResult(output);
      return output;
    } catch (error) {
      await this.markRunFailed(input.runId, error);
      throw error;
    } finally {
      clearRunController(input.runId);
    }
  }

  async resumeStream(
    input: { runId: string; approvals: ToolApprovalDecision[] },
    ctx: AgentContext,
    options: AgentDockRunOptions = {},
  ): Promise<StreamAgentResult> {
    const claim = await this.claimApprovalRun(input.runId, input.approvals);
    const history = buildApprovalHistory(claim, input.approvals);
    const abortSignal = this.createRunAbortSignal(input.runId, options.abortSignal);
    let prepared;

    try {
      prepared = await prepareAgentRunFromHistory(
        history,
        ctx,
        {
          ...this.buildRunOptions(options),
          runId: input.runId,
          abortSignal,
        },
        claim.record.stepsCompleted,
      );
      await this.runStore.update(input.runId, { messages: history });
    } catch (error) {
      await this.markRunFailed(input.runId, error);
      clearRunController(input.runId);
      throw error;
    }

    const stream = streamText(buildModelRequest(prepared));
    const result = Promise.all([
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
          claim.record.stepsCompleted + steps.length,
        );
        await this.persistResult(output);
        clearRunController(input.runId);
        return output;
      })
      .catch(async (error) => {
        await this.markRunFailed(input.runId, error);
        clearRunController(input.runId);
        throw error;
      });

    return { stream: stream.fullStream, result };
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
    await this.runStore.update(runId, {
      status: "cancelled",
      pendingApprovals: [],
    });
  }

  private buildRunOptions(options: AgentDockRunOptions): RunAgentOptions {
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
    messages: AgentRunRecord["messages"],
  ): Promise<void> {
    await this.runStore.save({
      runId,
      status: "running",
      messages,
      pendingApprovals: [],
      stepsCompleted: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  private async persistResult(result: AgentRunResult): Promise<void> {
    const current = await this.runStore.get(result.runId);
    if (current?.status === "cancelled") {
      result.status = "cancelled";
      return;
    }

    const waitingForApproval = result.approvalRequests.length > 0;
    await this.runStore.update(result.runId, {
      status: waitingForApproval ? "waiting_for_approval" : "completed",
      messages: result.messages,
      pendingApprovals: result.approvalRequests,
      stepsCompleted: result.stepsCompleted,
    });
    result.status = waitingForApproval ? "waiting_for_approval" : "completed";
  }

  private async markRunFailed(runId: string, error: unknown): Promise<void> {
    const current = await this.runStore.get(runId);
    if (!current || current.status === "cancelled") return;

    await this.runStore.update(runId, {
      status: "failed",
      error: error instanceof Error ? error.message : "Agent run failed",
    });
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
  const decisionsById = new Map(
    decisions.map((decision) => [decision.approvalId, decision]),
  );
  const approvalResponses: ToolApprovalResponse[] = claim.approvals.map(
    (approval) => {
      const decision = decisionsById.get(approval.approvalId)!;
      return {
        approvalId: approval.approvalId,
        toolCall: approval.toolCall,
        approved: decision.approved,
        ...(decision.reason ? { reason: decision.reason } : {}),
      };
    },
  );

  return [
    ...claim.record.messages,
    {
      role: "tool",
      content: "",
      toolResults: [],
      approvalResponses,
    },
  ];
}
