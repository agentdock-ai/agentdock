import type {
  GenerateTextOnStepFinishCallback,
  LanguageModel,
  ToolApprovalStatus,
  ToolSet,
} from "ai";
import { stepCountIs } from "ai";
import type { ToolRegistry } from "../../tools/registry.js";
import type { AgentHooks } from "../hooks.js";
import type { Message } from "../memory.js";
import type { AgentContext, RunAgentOptions, ToolErrorRecord } from "../types.js";
import { normalizeToolCalls, toModelInput } from "./messages.js";
import { buildToolSet } from "./tools.js";

export interface PreparedAgentRun {
  abortSignal?: AbortSignal;
  history: Message[];
  runId: string;
  sessionId: string;
  stepsCompleted: number;
  maxSteps: number;
  model: LanguageModel;
  modelInput: ReturnType<typeof toModelInput>;
  onStepStart: (step: number) => void;
  onStepFinish: GenerateTextOnStepFinishCallback<ToolSet>;
  toolErrors: ToolErrorRecord[];
  tools: ToolSet;
  permissionMode: NonNullable<RunAgentOptions["permissionMode"]>;
  registry: ToolRegistry;
  ctx: AgentContext;
}

export function buildHistory(userPrompt: string, options: RunAgentOptions): Message[] {
  const history = [...(options.messages ?? []), { role: "user" as const, content: userPrompt }];

  if (options.systemPrompt) {
    const systemIndex = history.findIndex(
      (message) => message.role === "system" && message.compacted !== true,
    );
    if (systemIndex >= 0) {
      history[systemIndex] = {
        ...history[systemIndex],
        content: options.systemPrompt,
      };
    } else {
      history.unshift({ role: "system", content: options.systemPrompt });
    }
  }

  return history;
}

export async function prepareAgentRun(
  userPrompt: string,
  ctx: AgentContext,
  options: RunAgentOptions,
): Promise<PreparedAgentRun> {
  const history = buildHistory(userPrompt, options);
  return prepareAgentRunFromHistory(history, ctx, options, 0);
}

export async function prepareAgentRunFromHistory(
  history: Message[],
  ctx: AgentContext,
  options: RunAgentOptions,
  stepsCompleted: number,
): Promise<PreparedAgentRun> {
  const toolErrors: ToolErrorRecord[] = [];
  const hooks = options.hooks;
  if (!options.sessionId?.trim()) {
    throw new Error(
      "No sessionId configured. Every agent run must belong to a session.",
    );
  }
  if (!options.model) {
    throw new Error(
      "No model configured. Provide options.model, for example new AgentModelFactory().create({ provider: \"openrouter\", modelId: \"your-model-id\" }).",
    );
  }
  const permissionMode = options.permissionMode ?? "normal";
  if (options.compression?.shouldCompress(history)) {
    await options.compression.compress(history);
  }
  if (!options.registry) {
    throw new Error("No tool registry configured.");
  }
  const maxSteps = options.maxSteps ?? 10;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error("maxSteps must be a positive integer.");
  }
  if (!Number.isInteger(stepsCompleted) || stepsCompleted < 0) {
    throw new Error("stepsCompleted must be a non-negative integer.");
  }
  if (stepsCompleted >= maxSteps) {
    throw new Error("stepsCompleted must be less than maxSteps.");
  }
  const registry = options.registry;
  const tools = buildToolSet(
    registry,
    ctx,
    options.abortSignal,
    options.toolTimeout,
    hooks,
    toolErrors,
  );

  return {
    abortSignal: options.abortSignal,
    history,
    runId: options.runId ?? crypto.randomUUID(),
    sessionId: options.sessionId,
    stepsCompleted,
    maxSteps: maxSteps - stepsCompleted,
    model: options.model,
    modelInput: toModelInput(history.filter((message) => message.active !== false)),
    onStepStart: (step) => hooks?.onStepStart?.(stepsCompleted + step),
    onStepFinish: (step) => {
      hooks?.onStepFinish?.(
        stepsCompleted + step.stepNumber,
        step.text,
        normalizeToolCalls(step.toolCalls ?? []),
      );
    },
    toolErrors,
    tools,
    permissionMode,
    registry,
    ctx,
  };
}

export function buildModelRequest(prepared: PreparedAgentRun) {
  return {
    model: prepared.model,
    ...prepared.modelInput,
    tools: prepared.tools,
    stopWhen: stepCountIs(prepared.maxSteps),
    toolApproval: async ({
      toolCall,
    }: {
      toolCall: { toolCallId: string; toolName: string; input: unknown };
    }): Promise<ToolApprovalStatus> => {
      const tool = prepared.registry.get(toolCall.toolName);
      if (!tool) {
        return {
          type: "denied",
          reason: `Unknown tool: ${toolCall.toolName}`,
        };
      }

      if (tool.authorize) {
        let authorization;
        try {
          authorization = await tool.authorize({
            toolCall: {
              toolCallId: toolCall.toolCallId,
              name: toolCall.toolName,
              input: toolCall.input,
            },
            ctx: prepared.ctx,
          });
        } catch {
          return {
            type: "denied",
            reason: "Tool authorization check failed",
          };
        }

        if (!authorization.allowed) {
          return {
            type: "denied",
            reason: authorization.reason,
          };
        }
      }

      if (prepared.permissionMode === "approve_all") return "approved";
      return tool.requiresApproval ? "user-approval" : "approved";
    },
    ...(prepared.abortSignal ? { abortSignal: prepared.abortSignal } : {}),
    onStepStart: ({ stepNumber }: { stepNumber: number }) =>
      prepared.onStepStart(stepNumber),
    onStepFinish: prepared.onStepFinish,
  };
}
