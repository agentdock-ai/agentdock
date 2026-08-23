import { generateText, streamText, type ModelMessage } from "ai";
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
  defaultAgentRunStore,
  type AgentRunRecord,
  type AgentRunStore,
  type AgentRunStatus,
} from "./runs/store.js";
import type { ToolApprovalResponse } from "./permissions/types.js";
import type {
  AgentContext,
  AgentRunResult,
  RunAgentOptions,
  StreamAgentResult,
} from "./types.js";

export async function runAgent(
  userPrompt: string,
  ctx: AgentContext,
  options: RunAgentOptions = {},
): Promise<AgentRunResult> {
  const runId = options.runId ?? crypto.randomUUID();
  const store = getStore(options);
  const abortSignal = createRunAbortSignal(runId, options.abortSignal);
  let prepared;
  try {
    prepared = await prepareAgentRun(userPrompt, ctx, {
      ...options,
      runId,
      abortSignal,
    });
  } catch (error) {
    clearRunController(runId);
    throw error;
  }

  await saveRunningRun(store, runId, ctx, prepared.history);

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
    await persistResult(store, ctx, output);
    return output;
  } catch (error) {
    await markRunFailed(store, runId, error);
    throw error;
  } finally {
    clearRunController(runId);
  }
}

export async function streamAgent(
  userPrompt: string,
  ctx: AgentContext,
  options: RunAgentOptions = {},
): Promise<StreamAgentResult> {
  const runId = options.runId ?? crypto.randomUUID();
  const store = getStore(options);
  const abortSignal = createRunAbortSignal(runId, options.abortSignal);
  let prepared;
  try {
    prepared = await prepareAgentRun(userPrompt, ctx, {
      ...options,
      runId,
      abortSignal,
    });
  } catch (error) {
    clearRunController(runId);
    throw error;
  }

  await saveRunningRun(store, runId, ctx, prepared.history);
  const stream = streamText(buildModelRequest(prepared));

  const result = Promise.all([
    stream.text,
    stream.responseMessages,
    stream.toolCalls,
    stream.toolResults,
    stream.content,
    stream.steps,
  ]).then(async ([text, responseMessages, toolCalls, toolResults, content, steps]) => {
    const output = createAgentRunResult(
      prepared,
      text,
      responseMessages as ModelMessage[],
      toolCalls,
      toolResults,
      content,
      steps.length,
    );
    await persistResult(store, ctx, output);
    clearRunController(runId);
    return output;
  }).catch(async (error) => {
    await markRunFailed(store, runId, error);
    clearRunController(runId);
    throw error;
  });

  return { stream: stream.fullStream, result };
}

export async function resumeAgent(
  input: {
    runId: string;
    approvalId: string;
    approved: boolean;
    reason?: string;
  },
  ctx: AgentContext,
  options: RunAgentOptions = {},
): Promise<AgentRunResult> {
  const store = getStore(options);
  const record = await requireOwnedRun(store, input.runId, ctx);
  validateApproval(record, input.approvalId);

  const approval = record.pendingApprovals.find(
    (request) => request.approvalId === input.approvalId,
  )!;
  const approvalResponse: ToolApprovalResponse = {
    approvalId: input.approvalId,
    toolCall: approval.toolCall,
    approved: input.approved,
    ...(input.reason ? { reason: input.reason } : {}),
  };
  const history = [
    ...record.messages,
    {
      role: "tool" as const,
      content: "",
      toolResults: [],
      approvalResponses: [approvalResponse],
    },
  ];

  const runAbortSignal = createRunAbortSignal(input.runId, options.abortSignal);
  const prepared = await prepareAgentRunFromHistory(
    history,
    ctx,
    { ...options, runId: input.runId, abortSignal: runAbortSignal },
    record.stepsCompleted,
  );
  await store.update(input.runId, {
    status: "running",
    pendingApprovals: [],
    messages: history,
  });

  try {
    const result = await generateText(buildModelRequest(prepared));
    const output = createAgentRunResult(
      prepared,
      result.text,
      result.responseMessages,
      result.toolCalls,
      result.toolResults,
      result.content,
      record.stepsCompleted + result.steps.length,
    );
    await persistResult(store, ctx, output);
    return output;
  } catch (error) {
    await markRunFailed(store, input.runId, error);
    throw error;
  } finally {
    clearRunController(input.runId);
  }
}

export async function resumeStreamAgent(
  input: {
    runId: string;
    approvalId: string;
    approved: boolean;
    reason?: string;
  },
  ctx: AgentContext,
  options: RunAgentOptions = {},
): Promise<StreamAgentResult> {
  const store = getStore(options);
  const record = await requireOwnedRun(store, input.runId, ctx);
  validateApproval(record, input.approvalId);

  const approval = record.pendingApprovals.find(
    (request) => request.approvalId === input.approvalId,
  )!;
  const approvalResponse: ToolApprovalResponse = {
    approvalId: input.approvalId,
    toolCall: approval.toolCall,
    approved: input.approved,
    ...(input.reason ? { reason: input.reason } : {}),
  };
  const history = [
    ...record.messages,
    {
      role: "tool" as const,
      content: "",
      toolResults: [],
      approvalResponses: [approvalResponse],
    },
  ];

  const runAbortSignal = createRunAbortSignal(input.runId, options.abortSignal);
  const prepared = await prepareAgentRunFromHistory(
    history,
    ctx,
    { ...options, runId: input.runId, abortSignal: runAbortSignal },
    record.stepsCompleted,
  );
  await store.update(input.runId, {
    status: "running",
    pendingApprovals: [],
    messages: history,
  });

  const stream = streamText(buildModelRequest(prepared));
  const result = Promise.all([
    stream.text,
    stream.responseMessages,
    stream.toolCalls,
    stream.toolResults,
    stream.content,
    stream.steps,
  ]).then(async ([text, responseMessages, toolCalls, toolResults, content, steps]) => {
    const output = createAgentRunResult(
      prepared,
      text,
      responseMessages as ModelMessage[],
      toolCalls,
      toolResults,
      content,
      record.stepsCompleted + steps.length,
    );
    await persistResult(store, ctx, output);
    clearRunController(input.runId);
    return output;
  }).catch(async (error) => {
    await markRunFailed(store, input.runId, error);
    clearRunController(input.runId);
    throw error;
  });

  return { stream: stream.fullStream, result };
}

export async function stopAgent(
  runId: string,
  ctx: AgentContext,
  options: Pick<RunAgentOptions, "runStore"> = {},
): Promise<void> {
  const store = options.runStore ?? defaultAgentRunStore;
  const record = await requireOwnedRun(store, runId, ctx);
  if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
    return;
  }
  stopRunController(runId);
  await store.update(runId, { status: "cancelled", pendingApprovals: [] });
}

function getStore(options: RunAgentOptions): AgentRunStore {
  return options.runStore ?? defaultAgentRunStore;
}

function createRunAbortSignal(runId: string, callerSignal?: AbortSignal): AbortSignal {
  const runSignal = registerRunController(runId);
  return callerSignal
    ? AbortSignal.any([callerSignal, runSignal])
    : runSignal;
}

async function saveRunningRun(
  store: AgentRunStore,
  runId: string,
  ctx: AgentContext,
  messages: AgentRunRecord["messages"],
): Promise<void> {
  await store.save({
    runId,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    status: "running",
    messages,
    pendingApprovals: [],
    stepsCompleted: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function persistResult(
  store: AgentRunStore,
  ctx: AgentContext,
  result: AgentRunResult,
): Promise<void> {
  await store.update(result.runId, {
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    status: result.approvalRequests.length > 0
      ? "waiting_for_approval"
      : "completed",
    messages: result.messages,
    pendingApprovals: result.approvalRequests,
    stepsCompleted: result.stepsCompleted,
  });
  result.status = result.approvalRequests.length > 0
    ? "waiting_for_approval"
    : "completed";
}

async function markRunFailed(
  store: AgentRunStore,
  runId: string,
  error: unknown,
): Promise<void> {
  const current = await store.get(runId);
  if (current?.status === "cancelled") return;
  await store.update(runId, {
    status: "failed",
    error: error instanceof Error ? error.message : "Agent run failed",
  });
}

async function requireOwnedRun(
  store: AgentRunStore,
  runId: string,
  ctx: AgentContext,
): Promise<AgentRunRecord> {
  const record = await store.get(runId);
  if (!record) throw new Error(`Agent run not found: ${runId}`);
  if (record.userId !== ctx.userId || record.organizationId !== ctx.organizationId) {
    throw new Error("Agent run does not belong to this context");
  }
  return record;
}

function validateApproval(record: AgentRunRecord, approvalId: string): void {
  if (record.status !== "waiting_for_approval") {
    throw new Error(`Agent run is not waiting for approval: ${record.runId}`);
  }
  if (!record.pendingApprovals.some((request) => request.approvalId === approvalId)) {
    throw new Error(`Approval request not found: ${approvalId}`);
  }
}
