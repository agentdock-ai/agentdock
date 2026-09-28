import {
  AgentEventType,
  cloneContentParts,
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
import { isRecord } from "../utils/is-record.js";

interface OpenMessage {
  messageId: string;
  content: ContentPart[];
}

interface ActiveTool extends ToolCallRecord {}
interface PartialToolCall {
  id?: string;
  name: string;
  args: string;
}

export class WireEventMapper {
  private readonly openMessages = new Map<string, OpenMessage>();
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly unnamedTools = new Map<string, string[]>();
  private readonly partialToolCalls = new Map<string, PartialToolCall>();
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
    if (!Array.isArray(rawChunk) || rawChunk.length !== 2) {
      throw new Error("LangGraph emitted an unsupported message chunk.");
    }
    const [rawMessage] = rawChunk;
    if (!isRecord(rawMessage)) {
      throw new Error("LangGraph emitted an invalid message chunk.");
    }

    const messageId =
      typeof rawMessage.id === "string" && rawMessage.id.length > 0
        ? rawMessage.id
        : `${this.context.runId}:message:${++this.messageCounter}`;
    this.collectToolCallChunks(messageId, rawMessage);
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
        if (usage)
          events.push(
            this.context.emit({ type: AgentEventType.UsageUpdated, usage }),
          );
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
    if (usage)
      events.push(
        this.context.emit({ type: AgentEventType.UsageUpdated, usage }),
      );
    return events;
  }

  private mapTool(rawChunk: unknown): AgentEvent[] {
    if (!isRecord(rawChunk) || typeof rawChunk.event !== "string") {
      throw new Error("LangGraph emitted an unsupported tool chunk.");
    }
    const toolName = typeof rawChunk.name === "string" ? rawChunk.name : "tool";
    const suppliedId =
      typeof rawChunk.toolCallId === "string" && rawChunk.toolCallId.length > 0
        ? rawChunk.toolCallId
        : undefined;

    if (rawChunk.event === "on_tool_start") {
      const toolCallId =
        suppliedId ?? `${this.context.runId}:tool:${++this.toolCounter}`;
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

    const isTerminalToolEvent =
      rawChunk.event === "on_tool_end" || rawChunk.event === "on_tool_error";
    const toolCallId =
      suppliedId ?? this.findUnnamedTool(toolName, isTerminalToolEvent);
    if (!toolCallId) {
      throw new Error(
        "LangGraph emitted a tool event without a matching call.",
      );
    }
    const toolCall = this.activeTools.get(toolCallId);
    if (!toolCall) {
      throw new Error("LangGraph emitted a tool event for an unknown call.");
    }

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
    throw new Error("LangGraph emitted an unsupported tool event.");
  }

  private mapUpdate(rawChunk: unknown): AgentEvent[] {
    if (!isRecord(rawChunk)) {
      throw new Error("LangGraph emitted an unsupported update chunk.");
    }
    const interrupts = rawChunk.__interrupt__;
    if (!Array.isArray(interrupts) || interrupts.length === 0) return [];
    if (interrupts.length > 1) {
      throw new Error("LangGraph emitted multiple interrupts in one update.");
    }
    const first = interrupts[0];
    if (!isRecord(first) || typeof first.id !== "string") {
      throw new Error("LangGraph emitted an interrupt without an ID.");
    }
    const interruptId = first.id;
    const value = isRecord(first.value) ? first.value : {};
    const rawActions = Array.isArray(value.actionRequests)
      ? value.actionRequests
      : [];
    const isToolApproval = Array.isArray(value.reviewConfigs);
    const actions = rawActions.flatMap((rawAction, index) => {
      if (!isRecord(rawAction)) return [];
      const explicitToolCallId =
        typeof rawAction.toolCallId === "string"
          ? rawAction.toolCallId
          : undefined;
      const actionInput = rawAction.args ?? rawAction.input ?? {};
      const toolCallId =
        explicitToolCallId ??
        (isToolApproval
          ? this.findInterruptedToolCall(
              typeof rawAction.name === "string" ? rawAction.name : "action",
              actionInput,
            )?.id
          : undefined);
      if (isToolApproval && !toolCallId) {
        throw new Error(
          "LangGraph interrupt could not be matched to a streamed tool call.",
        );
      }
      return [
        {
          id: toolCallId ?? `${interruptId}:action:${index}`,
          name: typeof rawAction.name === "string" ? rawAction.name : "action",
          input: cloneJsonValue(actionInput, "Interrupt action input"),
          ...(toolCallId ? { toolCallId } : {}),
        },
      ];
    });
    // The tool-approval path above rejects actions without a matching call ID;
    // this assertion records that discriminated guarantee for the union.
    const interrupt: AgentInterrupt = {
      interruptId,
      kind: isToolApproval ? "tool-approval" : "custom",
      prompt:
        typeof value.prompt === "string" ? value.prompt : "Approval required.",
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

  private findUnnamedTool(name: string, consume: boolean): string | undefined {
    const ids = this.unnamedTools.get(name);
    const id = consume ? ids?.shift() : ids?.[0];
    if (consume && ids?.length === 0) this.unnamedTools.delete(name);
    return id;
  }

  private collectToolCallChunks(
    messageId: string,
    message: Record<string, unknown>,
  ): void {
    if (Array.isArray(message.tool_calls)) {
      for (const [index, call] of message.tool_calls.entries()) {
        if (
          !isRecord(call) ||
          typeof call.id !== "string" ||
          typeof call.name !== "string"
        )
          continue;
        this.partialToolCalls.set(`${messageId}:${index}`, {
          id: call.id,
          name: call.name,
          args: JSON.stringify(call.args ?? {}),
        });
      }
      if (message.tool_calls.length > 0) return;
    }
    if (!Array.isArray(message.tool_call_chunks)) return;
    for (const [index, chunk] of message.tool_call_chunks.entries()) {
      if (!isRecord(chunk)) continue;
      const key = `${messageId}:${typeof chunk.index === "number" ? chunk.index : index}`;
      const current = this.partialToolCalls.get(key) ?? { name: "", args: "" };
      if (typeof chunk.id === "string") current.id = chunk.id;
      if (typeof chunk.name === "string") current.name += chunk.name;
      if (typeof chunk.args === "string") current.args += chunk.args;
      else if (isRecord(chunk.args)) current.args += JSON.stringify(chunk.args);
      this.partialToolCalls.set(key, current);
    }
  }

  private findInterruptedToolCall(
    name: string,
    args: unknown,
  ): PartialToolCall | undefined {
    const expectedArgs = stableJson(args);
    for (const [key, call] of this.partialToolCalls) {
      if (!call.id || call.name !== name) continue;
      let input: unknown;
      try {
        input = JSON.parse(call.args || "{}");
      } catch {
        continue;
      }
      if (stableJson(input) !== expectedArgs) continue;
      this.partialToolCalls.delete(key);
      return call;
    }
    return undefined;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function toProgressContent(value: unknown): ContentPart[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return [
    { type: "custom", name: "tool-progress", data: cloneJsonValue(value) },
  ];
}

function toToolOutput(value: unknown): JsonValue {
  if (isRecord(value) && "content" in value) {
    return cloneJsonValue(value.content, "Tool output content");
  }
  return cloneJsonValue(value, "Tool output");
}

function toContentParts(value: unknown): ContentPart[] {
  if (typeof value === "string")
    return value ? [{ type: "text", text: value }] : [];
  if (!Array.isArray(value)) {
    return value == null
      ? []
      : [
          {
            type: "custom",
            name: "model-content",
            data: cloneJsonValue(value),
          },
        ];
  }
  return value.flatMap((item): ContentPart[] => {
    if (!isRecord(item)) {
      return [
        { type: "custom", name: "model-content", data: cloneJsonValue(item) },
      ];
    }
    if (item.type === "text" && typeof item.text === "string") {
      return [{ type: "text", text: item.text }];
    }
    if (
      (item.type === "reasoning" || item.type === "thinking") &&
      typeof item.text === "string"
    ) {
      return [{ type: "reasoning", text: item.text }];
    }
    if (
      item.type === "image" ||
      item.type === "audio" ||
      item.type === "video" ||
      item.type === "file"
    ) {
      return cloneContentParts([item], "Model content");
    }
    return [
      { type: "custom", name: "model-content", data: cloneJsonValue(item) },
    ];
  });
}

function toJsonObject(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (typeof value === "string") {
    try {
      return cloneJsonObject(JSON.parse(value), "Tool input");
    } catch {
      throw new Error(
        "LangGraph emitted tool input that is not a JSON object.",
      );
    }
  }
  return cloneJsonObject(value, "Tool input");
}

function toUsage(value: unknown): AgentUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: AgentUsage = {};
  if (typeof value.input_tokens === "number")
    usage.inputTokens = value.input_tokens;
  if (typeof value.output_tokens === "number")
    usage.outputTokens = value.output_tokens;
  if (typeof value.total_tokens === "number")
    usage.totalTokens = value.total_tokens;
  if (typeof value.reasoning_tokens === "number")
    usage.reasoningTokens = value.reasoning_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

