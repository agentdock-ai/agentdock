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
  type AgentRunApprovalClaim,
  type AgentRunRecord,
  type AgentRunStore,
  type AgentRunStatus,
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

  await saveRunningRun(store, runId, prepared.history);

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
    await persistResult(store, output);
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

  await saveRunningRun(store, runId, prepared.history);
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
    await persistResult(store, output);
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
    approvals: ToolApprovalDecision[];
  },
  ctx: AgentContext,
  options: RunAgentOptions = {},
): Promise<AgentRunResult> {
  const store = getStore(options);
  const claim = await claimApprovalRun(store, input.runId, input.approvals);
  const history = buildApprovalHistory(claim, input.approvals);
  const runAbortSignal = createRunAbortSignal(input.runId, options.abortSignal);

  try {
    const prepared = await prepareAgentRunFromHistory(
      history,
      ctx,
      { ...options, runId: input.runId, abortSignal: runAbortSignal },
      claim.record.stepsCompleted,
    );
    await store.update(input.runId, { messages: history });
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
    await persistResult(store, output);
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
    approvals: ToolApprovalDecision[];
  },
  ctx: AgentContext,
  options: RunAgentOptions = {},
): Promise<StreamAgentResult> {
  const store = getStore(options);
  const claim = await claimApprovalRun(store, input.runId, input.approvals);
  const history = buildApprovalHistory(claim, input.approvals);
  const runAbortSignal = createRunAbortSignal(input.runId, options.abortSignal);

  let prepared;
  try {
    prepared = await prepareAgentRunFromHistory(
      history,
      ctx,
      { ...options, runId: input.runId, abortSignal: runAbortSignal },
      claim.record.stepsCompleted,
    );
    await store.update(input.runId, { messages: history });
  } catch (error) {
    await markRunFailed(store, input.runId, error);
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
  ]).then(async ([text, responseMessages, toolCalls, toolResults, content, steps]) => {
    const output = createAgentRunResult(
      prepared,
      text,
      responseMessages as ModelMessage[],
      toolCalls,
      toolResults,
      content,
      claim.record.stepsCompleted + steps.length,
    );
    await persistResult(store, output);
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
  _ctx: AgentContext,
  options: Pick<RunAgentOptions, "runStore"> = {},
): Promise<void> {
  const store = options.runStore ?? defaultAgentRunStore;
  const record = await store.get(runId);
  if (!record) throw new Error(`Agent run not found: ${runId}`);
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
  messages: AgentRunRecord["messages"],
): Promise<void> {
  await store.save({
    runId,
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
  result: AgentRunResult,
): Promise<void> {
  await store.update(result.runId, {
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

async function claimApprovalRun(
  store: AgentRunStore,
  runId: string,
  decisions: ToolApprovalDecision[],
): Promise<AgentRunApprovalClaim> {
  const claim = await store.claimApprovals(runId, decisions);
  if (!claim) {
    throw new Error(
      `Agent run approval claim failed: ${runId} is no longer waiting for the supplied approvals`,
    );
  }

  return claim;
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
      role: "tool" as const,
      content: "",
      toolResults: [],
      approvalResponses,
    },
  ];
}
