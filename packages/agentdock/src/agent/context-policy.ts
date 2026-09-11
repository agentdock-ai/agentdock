import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export interface ModelContextProfile {
  maxInputTokens: number;
}

export interface ContextBudget {
  fraction?: number;
  tokens?: number;
  messages?: number;
}

export interface ContextSummarizationOptions {
  summaryModel?: BaseChatModel;
  trigger?: "auto" | ContextBudget;
  keep?: ContextBudget;
  primaryModelProfile?: ModelContextProfile;
  summaryModelProfile?: ModelContextProfile;
}

export interface ContextManagementOptions {
  summarization: ContextSummarizationOptions;
}

export type ContextBudgetLimit =
  { kind: "tokens"; value: number } | { kind: "messages"; value: number };

export class ContextCapacityError extends Error {
  readonly code = "agent_context_capacity";

  constructor(
    message = "The retained conversation context cannot fit the model input capacity.",
  ) {
    super(message);
    this.name = "ContextCapacityError";
  }
}

export class ContextSummarizationPolicy {
  readonly summaryInputTokens: number;

  private constructor(
    readonly summaryModel: BaseChatModel,
    readonly trigger: ContextBudgetLimit,
    readonly keep: ContextBudgetLimit,
    readonly primaryMaxInputTokens: number | undefined,
    summaryMaxInputTokens: number | undefined,
  ) {
    this.summaryInputTokens = summaryMaxInputTokens
      ? Math.max(1, Math.floor(summaryMaxInputTokens / 2))
      : 4_000;
  }

  static create(
    primaryModel: BaseChatModel,
    options: ContextManagementOptions,
  ): ContextSummarizationPolicy {
    const summarization = readSummarizationOptions(options);
    const summaryModel = summarization.summaryModel ?? primaryModel;
    if (!isChatModel(summaryModel)) {
      throw new Error(
        "AgentDock contextManagement summaryModel must be a LangChain chat model.",
      );
    }

    const primaryMaxInputTokens = readProfile(
      primaryModel,
      summarization.primaryModelProfile,
      "primary",
    );
    const summaryMaxInputTokens =
      summaryModel === primaryModel
        ? primaryMaxInputTokens
        : readProfile(
            summaryModel,
            summarization.summaryModelProfile,
            "summary",
          );
    if (summaryModel !== primaryModel && summaryMaxInputTokens === undefined) {
      requireProfile(summaryMaxInputTokens, "summary");
    }

    const trigger = readTrigger(
      summarization.trigger ?? "auto",
      primaryMaxInputTokens,
    );
    const keep = readKeep(summarization.keep, primaryMaxInputTokens);
    validateLimits(trigger, keep, primaryMaxInputTokens);
    return new ContextSummarizationPolicy(
      summaryModel,
      trigger,
      keep,
      primaryMaxInputTokens,
      summaryMaxInputTokens,
    );
  }

  shouldCompact(messageCount: number, tokenCount: number): boolean {
    return this.trigger.kind === "tokens"
      ? tokenCount >= this.trigger.value
      : messageCount >= this.trigger.value;
  }
}

function readSummarizationOptions(
  options: ContextManagementOptions,
): ContextSummarizationOptions {
  if (!isObject(options) || !isObject(options.summarization)) {
    throw new Error(
      "AgentDock contextManagement requires a summarization configuration.",
    );
  }
  return options.summarization as ContextSummarizationOptions;
}

function readProfile(
  model: BaseChatModel,
  override: ModelContextProfile | undefined,
  label: "primary" | "summary",
): number | undefined {
  const value = override?.maxInputTokens ?? model.profile?.maxInputTokens;
  if (value === undefined) return undefined;
  if (!isInteger(value, false)) {
    throw new Error(
      `AgentDock ${label} model profile maxInputTokens must be a positive integer.`,
    );
  }
  return value;
}

function readTrigger(
  trigger: "auto" | ContextBudget,
  primaryMaxInputTokens: number | undefined,
): ContextBudgetLimit {
  if (trigger === "auto") {
    return {
      kind: "tokens",
      value: Math.floor(
        requireProfile(primaryMaxInputTokens, "primary") * 0.75,
      ),
    };
  }
  return readBudget(trigger, primaryMaxInputTokens, "trigger", false);
}

function readKeep(
  keep: ContextBudget | undefined,
  primaryMaxInputTokens: number | undefined,
): ContextBudgetLimit {
  if (keep === undefined) {
    return {
      kind: "tokens",
      value: Math.floor(
        requireProfile(primaryMaxInputTokens, "primary") * 0.25,
      ),
    };
  }
  return readBudget(keep, primaryMaxInputTokens, "keep", true);
}

function readBudget(
  budget: ContextBudget,
  primaryMaxInputTokens: number | undefined,
  label: "trigger" | "keep",
  allowZero: boolean,
): ContextBudgetLimit {
  if (!isObject(budget)) {
    throw new Error(`AgentDock contextManagement ${label} must be an object.`);
  }
  const values = [budget.fraction, budget.tokens, budget.messages].filter(
    (value) => value !== undefined,
  );
  if (values.length !== 1) {
    throw new Error(
      `AgentDock contextManagement ${label} must specify exactly one of fraction, tokens, or messages.`,
    );
  }
  if (budget.fraction !== undefined) {
    if (
      typeof budget.fraction !== "number" ||
      budget.fraction < (allowZero ? 0 : Number.EPSILON) ||
      budget.fraction > 1
    ) {
      throw new Error(
        `AgentDock contextManagement ${label} fraction must be ${allowZero ? "between 0 and 1" : "greater than 0 and at most 1"}.`,
      );
    }
    return {
      kind: "tokens",
      value: Math.floor(
        requireProfile(primaryMaxInputTokens, "primary") * budget.fraction,
      ),
    };
  }
  if (budget.tokens !== undefined) {
    if (!isInteger(budget.tokens, allowZero)) {
      throw new Error(
        `AgentDock contextManagement ${label} tokens must be a ${allowZero ? "non-negative" : "positive"} integer.`,
      );
    }
    return { kind: "tokens", value: budget.tokens };
  }
  if (!isInteger(budget.messages, allowZero)) {
    throw new Error(
      `AgentDock contextManagement ${label} messages must be a ${allowZero ? "non-negative" : "positive"} integer.`,
    );
  }
  return { kind: "messages", value: budget.messages };
}

function validateLimits(
  trigger: ContextBudgetLimit,
  keep: ContextBudgetLimit,
  primaryMaxInputTokens: number | undefined,
): void {
  if (primaryMaxInputTokens === undefined) return;
  if (keep.kind === "tokens" && keep.value >= primaryMaxInputTokens) {
    throw new Error(
      "AgentDock contextManagement keep token budget must be smaller than the primary model input capacity.",
    );
  }
  if (trigger.kind === "tokens" && trigger.value > primaryMaxInputTokens) {
    throw new Error(
      "AgentDock contextManagement trigger token budget cannot exceed the primary model input capacity.",
    );
  }
}

function requireProfile(
  profile: number | undefined,
  label: "primary" | "summary",
): number {
  if (profile !== undefined) return profile;
  const option =
    label === "primary" ? "primaryModelProfile" : "summaryModelProfile";
  throw new Error(
    `AgentDock contextManagement requires a verified ${label} model profile with maxInputTokens. Provide an explicit ${option} override for an unknown model.`,
  );
}

function isChatModel(value: unknown): value is BaseChatModel {
  return isObject(value) && typeof value.invoke === "function";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInteger(value: unknown, allowZero: boolean): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    (allowZero ? value >= 0 : value > 0)
  );
}
