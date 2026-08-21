import type {
  GenerateTextOnStepFinishCallback,
  LanguageModel,
  ToolSet,
} from "ai";
import { stepCountIs } from "ai";
import { createOpenRouterModel } from "../../providers/openrouter.js";
import { defaultToolRegistry } from "../../tools/registry.js";
import type { AgentHooks } from "../hooks.js";
import type { Message } from "../memory.js";
import type { AgentContext, RunAgentOptions, ToolErrorRecord } from "../types.js";
import { normalizeToolCalls, toModelInput } from "./messages.js";
import { buildToolSet } from "./tools.js";

export interface PreparedAgentRun {
  abortSignal?: AbortSignal;
  history: Message[];
  maxSteps: number;
  model: LanguageModel;
  modelInput: ReturnType<typeof toModelInput>;
  onStepFinish: GenerateTextOnStepFinishCallback<ToolSet>;
  toolErrors: ToolErrorRecord[];
  tools: ToolSet;
}

function createDefaultModel(options: RunAgentOptions): LanguageModel {
  return createOpenRouterModel({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    modelId: options.modelId ?? "google/gemini-2.5-flash",
  });
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
  const toolErrors: ToolErrorRecord[] = [];
  const hooks = options.hooks;
  const history = buildHistory(userPrompt, options);
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
    maxSteps: options.maxSteps ?? 10,
    model: options.model ?? createDefaultModel(options),
    modelInput: toModelInput(history.filter((message) => message.active !== false)),
    onStepFinish: (step) => {
      hooks?.onStepFinish?.(
        step.stepNumber,
        step.text,
        normalizeToolCalls(step.toolCalls ?? []),
      );
    },
    toolErrors,
    tools,
  };
}

export function buildModelRequest(prepared: PreparedAgentRun) {
  return {
    model: prepared.model,
    ...prepared.modelInput,
    tools: prepared.tools,
    stopWhen: stepCountIs(prepared.maxSteps),
    ...(prepared.abortSignal ? { abortSignal: prepared.abortSignal } : {}),
    onStepFinish: prepared.onStepFinish,
  };
}
