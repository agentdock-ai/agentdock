import { generateText, type LanguageModel } from "ai";
import type { Message } from "../agent/memory.js";

const CJK_PATTERN = new RegExp(
  "[\\u3040-\\u309F\\u30A0-\\u30FF\\u4E00-\\u9FFF\\u3400-\\u4DBF\\uAC00-\\uD7AF\\uFF00-\\uFFEF]",
  "g",
);

const MIN_TAIL_MESSAGES = 3;

function estimateTokens(text: string): number {
  const cjkCount = (text.match(CJK_PATTERN)?.length ?? 0);
  const asciiLength = text.length - cjkCount;
  return cjkCount + Math.floor((asciiLength + 3) / 4);
}

function estimateTokensForMessages(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

function serializeForCompression(messages: Message[]): string {
  return messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
}

function truncateContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + "...";
}

function buildFallbackSummary(messages: Message[]): string {
  const userMessages = messages.filter(m => m.role === "user");
  const assistantMessages = messages.filter(m => m.role === "assistant");
  const toolCallCount = assistantMessages.reduce(
    (sum, m) => sum + (m.toolCalls?.length ?? 0),
    0,
  );

  const parts: string[] = [];
  parts.push(`${messages.length} messages were compressed.`);

  if (userMessages.length > 0) {
    const previews = userMessages
      .map(m => truncateContent(m.content, 120))
      .join(" | ");
    parts.push(`User messages: ${previews}`);
  }

  if (toolCallCount > 0) {
    parts.push(`${toolCallCount} tool calls were executed.`);
  }

  parts.push("Summary generation failed — this is a deterministic fallback.");

  return parts.join(" ");
}

export interface CompressionStrategy {
  shouldCompress(messages: Message[]): boolean;
  compress(messages: Message[]): Promise<Message[]>;
}

export class SummarizeCompression implements CompressionStrategy {
  private options: {
    model: LanguageModel;
    maxTokens: number;
    tailTokenBudget: number;
    headCount: number;
  };

  constructor(options: {
    model: LanguageModel;
    maxTokens: number;
    tailTokenBudget: number;
    headCount: number;
  }) {
    this.options = options;
  }

  shouldCompress(messages: Message[]): boolean {
    const active = messages.filter(m => m.active !== false);
    return estimateTokensForMessages(active) > this.options.maxTokens;
  }

  async compress(messages: Message[]): Promise<Message[]> {
    const summaryIndex = messages.findIndex(
      m => m.role === "system" && m.compacted === true,
    );

    const headEnd = summaryIndex >= 0 ? summaryIndex + 1 : this.options.headCount;

    let tailTokens = 0;
    let tailStart = messages.length;

    for (let i = messages.length - 1; i >= headEnd; i--) {
      tailTokens += estimateTokens(messages[i].content);
      tailStart = i;
      if (tailTokens >= this.options.tailTokenBudget) break;
    }

    tailStart = Math.min(tailStart, messages.length - MIN_TAIL_MESSAGES);

    const middleStart = headEnd;
    const middleEnd = tailStart;

    if (middleEnd <= middleStart) return messages;

    const toCompress: Message[] = [
      ...messages.slice(middleStart, middleEnd).filter(m => m.active !== false),
      ...messages.filter(m => m.active === false && m.compacted === true),
    ];

    if (toCompress.length === 0) return messages;

    let summaryText: string;

    try {
      const result = await generateText({
        model: this.options.model,
        messages: [
          {
            role: "user" as const,
            content: serializeForCompression(toCompress),
          },
        ],
      });
      summaryText = result.text;
    } catch {
      summaryText = buildFallbackSummary(toCompress);
    }

    for (let i = middleStart; i < middleEnd; i++) {
      messages[i] = { ...messages[i], active: false, compacted: true };
    }

    if (summaryIndex >= 0) messages.splice(summaryIndex, 1);

    messages.splice(headEnd, 0, {
      role: "system",
      content: `[Conversation summary]: ${summaryText}`,
      compacted: true,
    });

    return messages;
  }
}
