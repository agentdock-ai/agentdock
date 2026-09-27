import {
  AgentEventType,
  cloneJsonObject,
  cloneJsonValue,
  type AgentEvent,
  type AgentInterrupt,
  type AgentUsage,
  type ContentPart,
  type JsonObject,
  type JsonValue,
  type ToolCallRecord,
  type ToolErrorRecord,
  type ToolResultRecord,
} from "@agentdock-ai/contracts";
import type { EventContext } from "./event-context.js";

interface OpenMessage {
  messageId: string;
  content: ContentPart[];
}

interface ActiveTool extends ToolCallRecord {}

export class WireEventMapper {
  private readonly openMessages = new Map<string, OpenMessage>();
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly unnamedTools = new Map<string, string[]>();
  private messageCounter = 0;
  private toolCounter = 0;

  constructor(private readonly context: EventContext) {}

  map(mode: string, rawChunk: unknown): AgentEvent[] {
    switch (mode) {
      case "messages":
        return this.mapMessage(rawChunk);
      case "tools":
        return this.mapTool(rawChunk);
      case "updates":
        return this.mapUpdate(rawChunk);
      default:
        return [];
    }
  }

  completeMessages(): AgentEvent[] {
    return [...this.openMessages.values()].map((message) => {
      this.openMessages.delete(message.messageId);
      return this.context.emit({
        type: AgentEventType.MessageCompleted,
        messageId: message.messageId,
        role: "assistant",
        content: message.content,
      });
    });
  }

  private mapMessage(rawChunk: unknown): AgentEvent[] {
    if (!Array.isArray(rawChunk) || rawChunk.length < 1) return [];
    const [rawMessage] = rawChunk;
    if (!isRecord(rawMessage)) return [];

    const messageId =
      typeof rawMessage.id === "string" && rawMessage.id.length > 0
        ? rawMessage.id
        : `${this.context.runId}:message:${++this.messageCounter}`;
    const events: AgentEvent[] = [];
    const content = toContentParts(rawMessage.content);
    let openMessage = this.openMessages.get(messageId);

    if (!openMessage) {
      for (const previous of this.openMessages.values()) {
        events.push(
          this.context.emit({
            type: AgentEventType.MessageCompleted,
            messageId: previous.messageId,
            role: "assistant",
            content: previous.content,
          }),
        );
      }
      this.openMessages.clear();
      if (content.length === 0) {
        const usage = toUsage(rawMessage.usage_metadata);
        if (usage) events.push(this.context.emit({ type: AgentEventType.UsageUpdated, usage }));
        return events;
      }
      events.push(
        this.context.emit({
          type: AgentEventType.MessageStarted,
          messageId,
          role: "assistant",
        }),
      );
      openMessage = { messageId, content: [] };
      this.openMessages.set(messageId, openMessage);
    }

    for (const part of content) {
      openMessage.content.push(part);
      events.push(
        this.context.emit({
          type: AgentEventType.MessagePartDelta,
          messageId,
          part,
        }),
      );
    }

    const usage = toUsage(rawMessage.usage_metadata);
    if (usage) events.push(this.context.emit({ type: AgentEventType.UsageUpdated, usage }));
    return events;
  }

  private mapTool(rawChunk: unknown): AgentEvent[] {
    if (!isRecord(rawChunk) || typeof rawChunk.event !== "string") return [];
    const toolName = typeof rawChunk.name === "string" ? rawChunk.name : "tool";
    const suppliedId =
      typeof rawChunk.toolCallId === "string" && rawChunk.toolCallId.length > 0
        ? rawChunk.toolCallId
        : undefined;

    if (rawChunk.event === "on_tool_start") {
      const toolCallId = suppliedId ?? `${this.context.runId}:tool:${++this.toolCounter}`;
      const toolCall: ToolCallRecord = {
        toolCallId,
        name: toolName,
        input: toJsonObject(rawChunk.input),
      };
      this.activeTools.set(toolCallId, toolCall);
      if (!suppliedId) {
        const ids = this.unnamedTools.get(toolName) ?? [];
        ids.push(toolCallId);
        this.unnamedTools.set(toolName, ids);
      }
      return [this.context.emit({ type: AgentEventType.ToolCalled, toolCall })];
    }

    const toolCallId = suppliedId ?? this.findUnnamedTool(toolName);
    if (!toolCallId) return [];
    const toolCall = this.activeTools.get(toolCallId);
    if (!toolCall) return [];

    if (rawChunk.event === "on_tool_event") {
      return [
        this.context.emit({
          type: AgentEventType.ToolProgress,
          toolCallId,
          content: toProgressContent(rawChunk.data),
        }),
      ];
    }
    if (rawChunk.event === "on_tool_end") {
      this.activeTools.delete(toolCallId);
      return [
        this.context.emit({
          type: AgentEventType.ToolCompleted,
          result: {
            ...toolCall,
            output: toToolOutput(rawChunk.output),
          } satisfies ToolResultRecord,
        }),
      ];
    }
    if (rawChunk.event === "on_tool_error") {
      this.activeTools.delete(toolCallId);
      const error: ToolErrorRecord = {
        ...toolCall,
        error: "Tool execution failed.",
        code: "tool_error",
      };
      return [this.context.emit({ type: AgentEventType.ToolFailed, error })];
    }
    return [];
  }

  private mapUpdate(rawChunk: unknown): AgentEvent[] {
    if (!isRecord(rawChunk)) return [];
    const interrupts = rawChunk.__interrupt__;
    if (!Array.isArray(interrupts) || interrupts.length === 0) return [];
    const first = interrupts[0];
    if (!isRecord(first)) return [];
    const interruptId =
      typeof first.id === "string" ? first.id : `${this.context.runId}:interrupt`;
    const value = isRecord(first.value) ? first.value : {};
    const rawActions = Array.isArray(value.actionRequests)
      ? value.actionRequests
      : [];
    const actions = rawActions.flatMap((rawAction, index) => {
      if (!isRecord(rawAction)) return [];
      const toolCallId =
        typeof rawAction.toolCallId === "string"
          ? rawAction.toolCallId
          : typeof rawAction.id === "string"
            ? rawAction.id
            : undefined;
      return [
        {
          id: toolCallId ?? `${interruptId}:action:${index}`,
          name: typeof rawAction.name === "string" ? rawAction.name : "action",
          input: cloneJsonValue(rawAction.args ?? {}, "Interrupt action input"),
          ...(toolCallId ? { toolCallId } : {}),
        },
      ];
    });
    const interrupt: AgentInterrupt = {
      interruptId,
      kind: actions.length > 0 && actions.every((action) => action.toolCallId)
        ? "tool-approval"
        : "custom",
      prompt: typeof value.prompt === "string" ? value.prompt : "Approval required.",
      ...(value.payload === undefined
        ? {}
        : { payload: cloneJsonValue(value.payload, "Interrupt payload") }),
      actions,
    } as AgentInterrupt;
    const completedMessages = this.completeMessages();
    completedMessages.push(
      this.context.emit({ type: AgentEventType.InterruptRequired, interrupt }),
    );
    return completedMessages;
  }

  private findUnnamedTool(name: string): string | undefined {
    const ids = this.unnamedTools.get(name);
    const id = ids?.shift();
    if (ids?.length === 0) this.unnamedTools.delete(name);
    return id;
  }
}

function toProgressContent(value: unknown): ContentPart[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return [{ type: "custom", name: "tool-progress", data: cloneJsonValue(value) }];
}

function toToolOutput(value: unknown): JsonValue {
  if (isRecord(value) && "content" in value) {
    return cloneJsonValue(value.content, "Tool output content");
  }
  return cloneJsonValue(value, "Tool output");
}

function toContentParts(value: unknown): ContentPart[] {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
  if (!Array.isArray(value)) {
    return value == null
      ? []
      : [{ type: "custom", name: "model-content", data: cloneJsonValue(value) }];
  }
  return value.flatMap((item): ContentPart[] => {
    if (!isRecord(item)) {
      return [{ type: "custom", name: "model-content", data: cloneJsonValue(item) }];
    }
    if (item.type === "text" && typeof item.text === "string") {
      return [{ type: "text", text: item.text }];
    }
    if ((item.type === "reasoning" || item.type === "thinking") && typeof item.text === "string") {
      return [{ type: "reasoning", text: item.text }];
    }
    if (item.type === "image" || item.type === "audio" || item.type === "video" || item.type === "file") {
      return [cloneJsonValue(item, "Model content") as ContentPart];
    }
    return [{ type: "custom", name: "model-content", data: cloneJsonValue(item) }];
  });
}

function toJsonObject(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (typeof value === "string") {
    try {
      return cloneJsonObject(JSON.parse(value), "Tool input");
    } catch {
      throw new Error("LangGraph emitted tool input that is not a JSON object.");
    }
  }
  return cloneJsonObject(value, "Tool input");
}

function toUsage(value: unknown): AgentUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: AgentUsage = {};
  if (typeof value.input_tokens === "number") usage.inputTokens = value.input_tokens;
  if (typeof value.output_tokens === "number") usage.outputTokens = value.output_tokens;
  if (typeof value.total_tokens === "number") usage.totalTokens = value.total_tokens;
  if (typeof value.reasoning_tokens === "number") usage.reasoningTokens = value.reasoning_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
