import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { v4 } from "@langchain/core/utils/uuid";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import { countTokensApproximately } from "langchain";
import {
  ContextCapacityError,
  type ContextBudgetLimit,
} from "./context-policy.js";

export class ContextMessageWindow {
  static prepare(messages: BaseMessage[]): void {
    for (const message of messages) if (!message.id) message.id = v4();
  }

  static split(messages: BaseMessage[]): {
    systemMessage?: SystemMessage;
    conversation: BaseMessage[];
  } {
    if (messages[0] instanceof SystemMessage) {
      return { systemMessage: messages[0], conversation: messages.slice(1) };
    }
    return { conversation: messages };
  }

  static findCutoff(messages: BaseMessage[], keep: ContextBudgetLimit): number {
    if (messages.length === 0) return 0;
    const candidate = this.findCandidate(messages, keep);
    for (let index = candidate; index >= 0; index -= 1) {
      if (this.isSafeCutoff(messages, index)) return index;
    }
    return 0;
  }

  static requireFit(
    systemMessage: SystemMessage | undefined,
    retained: BaseMessage[],
    maxInputTokens: number | undefined,
  ): void {
    if (maxInputTokens === undefined) return;
    const messages = systemMessage ? [systemMessage, ...retained] : retained;
    if (countTokensApproximately(messages) > maxInputTokens) {
      throw new ContextCapacityError();
    }
  }

  static summaryMessage(content: string, id: string): HumanMessage {
    return new HumanMessage({
      content: `Conversation summary:\n\n${content}`,
      id,
      additional_kwargs: { agentdock_context_summary: true },
    });
  }

  static fitSummary(
    summary: string,
    systemMessage: SystemMessage | undefined,
    retained: BaseMessage[],
    maxInputTokens: number | undefined,
  ): string | undefined {
    if (maxInputTokens === undefined) return summary;
    let candidate = summary;
    while (candidate.length > 0) {
      const message = this.summaryMessage(candidate, v4());
      const messages = systemMessage
        ? [systemMessage, message, ...retained]
        : [message, ...retained];
      if (countTokensApproximately(messages) <= maxInputTokens) {
        return candidate;
      }
      candidate = candidate.slice(0, Math.floor(candidate.length * 0.75));
    }
    return undefined;
  }

  static replacement(
    systemMessage: SystemMessage | undefined,
    summary: BaseMessage | undefined,
    retained: BaseMessage[],
  ): { messages: BaseMessage[] } {
    const messages: BaseMessage[] = [
      new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
    ];
    if (systemMessage) messages.push(systemMessage);
    if (summary) messages.push(summary);
    messages.push(...retained);
    return { messages };
  }

  static trimForSummary(
    messages: BaseMessage[],
    maxTokens: number,
  ): BaseMessage[] {
    if (countTokensApproximately(messages) <= maxTokens) return messages;
    for (let index = 0; index < messages.length; index += 1) {
      const suffix = messages.slice(index);
      if (countTokensApproximately(suffix) <= maxTokens) return suffix;
    }
    return messages.slice(-1);
  }

  private static findCandidate(
    messages: BaseMessage[],
    keep: ContextBudgetLimit,
  ): number {
    if (keep.kind === "messages") {
      return Math.max(0, messages.length - keep.value);
    }
    if (countTokensApproximately(messages) <= keep.value) return 0;
    for (let index = 0; index < messages.length; index += 1) {
      if (countTokensApproximately(messages.slice(index)) <= keep.value) {
        return index;
      }
    }
    return messages.length - 1;
  }

  private static isSafeCutoff(
    messages: BaseMessage[],
    cutoff: number,
  ): boolean {
    if (cutoff >= messages.length) return true;
    const first = messages[cutoff];
    if (first instanceof AIMessage && (first.tool_calls?.length ?? 0) > 0) {
      return false;
    }
    for (let index = 0; index < messages.length; index += 1) {
      const ids = this.toolCallIds(messages[index]);
      if (ids.size === 0) continue;
      const resolved = this.toolResultsStayOnOneSide(
        messages,
        index,
        cutoff,
        ids,
      );
      if (!resolved && index < cutoff) return false;
    }
    return true;
  }

  private static toolCallIds(message: BaseMessage): Set<string> {
    if (!(message instanceof AIMessage)) return new Set();
    return new Set(
      (message.tool_calls ?? []).flatMap((call) =>
        typeof call.id === "string" ? [call.id] : [],
      ),
    );
  }

  private static toolResultsStayOnOneSide(
    messages: BaseMessage[],
    toolCallIndex: number,
    cutoff: number,
    ids: Set<string>,
  ): boolean {
    let resolved = false;
    for (let index = toolCallIndex + 1; index < messages.length; index += 1) {
      const message = messages[index];
      if (!(message instanceof ToolMessage) || !ids.has(message.tool_call_id)) {
        continue;
      }
      resolved = true;
      if (toolCallIndex < cutoff !== index < cutoff) return false;
    }
    return resolved;
  }
}
