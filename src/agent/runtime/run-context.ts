import type {
  GenerateTextOnStepFinishCallback,
  LanguageModel,
  ToolSet,
} from "ai";
import { stepCountIs } from "ai";
import { defaultToolRegistry } from "../../tools/registry.js";
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
  const hasSystemPrompt = history.some(
    (message) => message.role === "system" && message.compacted !== true,
  );

  if (options.systemPrompt && !hasSystemPrompt) {
    history.unshift({ role: "system", content: options.systemPrompt });
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
  if (!options.model) {
    throw new Error(
      "No model configured. Provide options.model, for example createOpenRouterModel({ modelId: \"your-model-id\" }).",
    );
  }
  const permissionMode = options.permissionMode ?? "normal";
  if (options.compression?.shouldCompress(history)) {
    await options.compression.compress(history);
  }
  const registry = options.registry ?? defaultToolRegistry;
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
    stepsCompleted,
    maxSteps: Math.max(1, (options.maxSteps ?? 10) - stepsCompleted),
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
    toolApproval: async ({ toolCall }: any): Promise<any> => {
      if (prepared.permissionMode === "approve_all") return "approved";

      const tool = prepared.registry.get(toolCall.toolName);
      if (!tool) {
        return {
          type: "denied",
          reason: `Unknown tool: ${toolCall.toolName}`,
        };
      }

      return tool.requiresApproval ? "user-approval" : "approved";
    },
    ...(prepared.abortSignal ? { abortSignal: prepared.abortSignal } : {}),
    onStepStart: ({ stepNumber }: { stepNumber: number }) =>
      prepared.onStepStart(stepNumber),
    onStepFinish: prepared.onStepFinish,
  };
}
