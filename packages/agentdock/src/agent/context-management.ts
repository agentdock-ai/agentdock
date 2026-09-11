import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getBufferString, type BaseMessage } from "@langchain/core/messages";
import { v4 } from "@langchain/core/utils/uuid";
import { countTokensApproximately, createMiddleware } from "langchain";
import { ContextMessageWindow } from "./context-message-window.js";
import {
  ContextCapacityError,
  ContextSummarizationPolicy,
  type ContextManagementOptions,
} from "./context-policy.js";

export type {
  ContextBudget,
  ContextManagementOptions,
  ContextSummarizationOptions,
  ModelContextProfile,
} from "./context-policy.js";
export { ContextCapacityError } from "./context-policy.js";

const SUMMARY_PROMPT = `You are compacting a conversation before its next model call. Preserve facts, user intent, constraints, decisions, completed work, unresolved work, and tool outcomes. Do not invent information. Return only a concise durable summary.\n\nConversation to compact:\n{messages}`;

/** Owns one resolved context-compaction policy and its LangChain middleware. */
export class ContextManagement {
  readonly summaryModel: BaseChatModel;
  readonly trigger: ContextSummarizationPolicy["trigger"];
  readonly keep: ContextSummarizationPolicy["keep"];
  readonly primaryMaxInputTokens: number | undefined;
  readonly summaryInputTokens: number;

  private constructor(private readonly policy: ContextSummarizationPolicy) {
    this.summaryModel = policy.summaryModel;
    this.trigger = policy.trigger;
    this.keep = policy.keep;
    this.primaryMaxInputTokens = policy.primaryMaxInputTokens;
    this.summaryInputTokens = policy.summaryInputTokens;
  }

  static create(
    primaryModel: BaseChatModel,
    options: ContextManagementOptions | undefined,
  ): ContextManagement | undefined {
    if (options === undefined) return undefined;
    return new ContextManagement(
      ContextSummarizationPolicy.create(primaryModel, options),
    );
  }

  asMiddleware() {
    return createMiddleware({
      name: "AgentDockContextManagementMiddleware",
      beforeModel: async (state, runtime) =>
        this.compact(state.messages, runtime.signal),
    });
  }

  private async compact(
    messages: BaseMessage[],
    signal: AbortSignal | undefined,
  ) {
    ContextMessageWindow.prepare(messages);
    const tokenCount = countTokensApproximately(messages);
    if (!this.policy.shouldCompact(messages.length, tokenCount)) return;

    const { systemMessage, conversation } =
      ContextMessageWindow.split(messages);
    const cutoff = ContextMessageWindow.findCutoff(
      conversation,
      this.policy.keep,
    );
    const retained = conversation.slice(cutoff);
    ContextMessageWindow.requireFit(
      systemMessage,
      retained,
      this.policy.primaryMaxInputTokens,
    );
    if (cutoff === 0) {
      if (
        this.policy.primaryMaxInputTokens !== undefined &&
        tokenCount > this.policy.primaryMaxInputTokens
      ) {
        throw new ContextCapacityError();
      }
      return;
    }

    try {
      const summary = await this.createSummary(
        conversation.slice(0, cutoff),
        signal,
      );
      const fittedSummary = ContextMessageWindow.fitSummary(
        summary,
        systemMessage,
        retained,
        this.policy.primaryMaxInputTokens,
      );
      if (!fittedSummary)
        throw new Error("Summary cannot fit the primary model budget.");
      const summaryMessage = ContextMessageWindow.summaryMessage(
        fittedSummary,
        conversation[0]?.id ?? v4(),
      );
      return ContextMessageWindow.replacement(
        systemMessage,
        summaryMessage,
        retained,
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      return ContextMessageWindow.replacement(
        systemMessage,
        undefined,
        retained,
      );
    }
  }

  private async createSummary(
    messages: BaseMessage[],
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const input = ContextMessageWindow.trimForSummary(
      messages,
      this.policy.summaryInputTokens,
    );
    if (input.length === 0) {
      throw new Error("No compactable messages remain for summarization.");
    }
    const config: {
      metadata: Record<string, string>;
      tags: string[];
      signal?: AbortSignal;
    } = {
      metadata: { lc_source: "agentdock_context_management" },
      tags: ["agentdock:context-summary"],
    };
    if (signal) config.signal = signal;
    const response = await this.policy.summaryModel.invoke(
      SUMMARY_PROMPT.replace("{messages}", getBufferString(input)),
      config,
    );
    const summary = toText(response.content).trim();
    if (!summary) throw new Error("Summary model returned empty content.");
    return summary;
  }
}

function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join("");
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
