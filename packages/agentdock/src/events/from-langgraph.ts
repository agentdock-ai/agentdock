import { isCommand } from "@langchain/langgraph";
import {
  isBaseMessage,
  isBaseMessageChunk,
  isToolMessage,
} from "@langchain/core/messages";
import {
  AgentEventType,
  cloneContentParts,
  cloneJsonObject,
  cloneJsonValue,
  sumUsage,
  type AgentEvent,
  type AgentEventInput,
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
  role: "assistant" | "user" | "tool";
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
  private readonly usages = new Map<string, AgentUsage>();
  private readonly fallbackMessageIds = new Map<string, string>();
  private readonly partialToolCalls = new Map<string, PartialToolCall>();

  constructor(
    private readonly context: EventContext,
    private readonly namespace: readonly string[] = [],
  ) {}

  private emit(input: AgentEventInput): AgentEvent {
    return this.context.emit(input, this.namespace);
  }
  private scopeId(id: string): string {
    return this.namespace.length
      ? `${JSON.stringify(this.namespace)}:${id}`
      : id;
  }

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
      return this.emit({
        type: AgentEventType.MessageCompleted,
        messageId: message.messageId,
        role: message.role,
        content: message.content,
      });
    });
  }

  private mapMessage(rawChunk: unknown): AgentEvent[] {
    if (!Array.isArray(rawChunk) || rawChunk.length !== 2) {
      throw new Error("LangGraph emitted an unsupported message chunk.");
    }
    const [rawMessage, metadata] = rawChunk;
    if (!isRecord(rawMessage)) {
      throw new Error("LangGraph emitted an invalid message chunk.");
    }

    const nativeRole = isBaseMessage(rawMessage)
      ? rawMessage.getType()
      : rawMessage.role;
    if (nativeRole === "system") return [];
    let role: OpenMessage["role"] = "assistant";
    if (nativeRole === "human" || nativeRole === "user") role = "user";
    else if (nativeRole === "tool") role = "tool";
    const fallbackKey = JSON.stringify(metadata ?? {});
    const fallbackId =
      this.fallbackMessageIds.get(fallbackKey) ??
      `${this.context.runId}:message:${crypto.randomUUID()}`;
    this.fallbackMessageIds.set(fallbackKey, fallbackId);
    const nativeMessageId =
      typeof rawMessage.id === "string" && rawMessage.id.length > 0
        ? rawMessage.id
        : fallbackId;
    const messageId = this.scopeId(nativeMessageId);
    this.collectToolCallChunks(messageId, rawMessage);
    const events: AgentEvent[] = [];
    const content = toContentParts(rawMessage.content);
    let openMessage = this.openMessages.get(messageId);

    if (!openMessage) {
      if (content.length === 0) {
        const usage = this.messageUsage(messageId, rawMessage);
        if (usage)
          events.push(
            this.emit({ type: AgentEventType.UsageUpdated, usage, messageId }),
          );
        return events;
      }
      events.push(
        this.emit({
          type: AgentEventType.MessageStarted,
          messageId,
          role,
        }),
      );
      openMessage = { messageId, role, content: [] };
      this.openMessages.set(messageId, openMessage);
    }

    for (const part of content) {
      appendContent(openMessage.content, part);
      events.push(
        this.emit({
          type: AgentEventType.MessagePartDelta,
          messageId,
          part,
        }),
      );
    }

    const usage = this.messageUsage(messageId, rawMessage);
    if (usage)
      events.push(
        this.emit({ type: AgentEventType.UsageUpdated, usage, messageId }),
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
        ? this.scopeId(rawChunk.toolCallId)
        : undefined;

    if (rawChunk.event === "on_tool_start") {
      const toolCallId =
        suppliedId ?? `${this.context.runId}:tool:${crypto.randomUUID()}`;
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
      return [this.emit({ type: AgentEventType.ToolCalled, toolCall })];
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
        this.emit({
          type: AgentEventType.ToolProgress,
          toolCallId,
          content: toProgressContent(rawChunk.data),
        }),
      ];
    }
    if (rawChunk.event === "on_tool_end") {
      this.activeTools.delete(toolCallId);
      return [
        this.emit({
          type: AgentEventType.ToolCompleted,
          result: {
            ...toolCall,
            ...toToolOutput(
              rawChunk.output,
              typeof rawChunk.toolCallId === "string"
                ? rawChunk.toolCallId
                : toolCallId,
            ),
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
      return [this.emit({ type: AgentEventType.ToolFailed, error })];
    }
    throw new Error("LangGraph emitted an unsupported tool event.");
  }

  private mapUpdate(rawChunk: unknown): AgentEvent[] {
    if (!isRecord(rawChunk)) {
      throw new Error("LangGraph emitted an unsupported update chunk.");
    }
    for (const update of Object.values(rawChunk)) {
      if (!isRecord(update) || !Array.isArray(update.messages)) continue;
      for (const message of update.messages) {
        if (!isRecord(message)) continue;
        const id = typeof message.id === "string" ? message.id : "checkpoint";
        this.collectToolCallChunks(id, message, true);
      }
    }
    const interrupts = rawChunk.__interrupt__;
    if (!Array.isArray(interrupts) || interrupts.length === 0) return [];
    return interrupts.flatMap((first) => this.mapInterrupt(first));
  }

  private mapInterrupt(first: unknown): AgentEvent[] {
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
          id: toolCallId
            ? this.scopeId(toolCallId)
            : `${interruptId}:action:${index}`,
          name: typeof rawAction.name === "string" ? rawAction.name : "action",
          input: cloneJsonValue(actionInput, "Interrupt action input"),
          ...(toolCallId ? { toolCallId: this.scopeId(toolCallId) } : {}),
        },
      ];
    });
    // The tool-approval path above rejects actions without a matching call ID;
    // this assertion records that discriminated guarantee for the union.
    let prompt = "Approval required.";
    if (typeof first.value === "string") prompt = first.value;
    else if (typeof value.prompt === "string") prompt = value.prompt;
    const interrupt: AgentInterrupt = {
      interruptId,
      kind: isToolApproval ? "tool-approval" : "custom",
      prompt,
      payload: cloneJsonValue(first.value, "Interrupt payload"),
      actions,
    } as AgentInterrupt;
    const completedMessages = this.completeMessages();
    completedMessages.push(
      this.emit({ type: AgentEventType.InterruptRequired, interrupt }),
    );
    return completedMessages;
  }

  seedMessages(values: unknown): void {
    if (!isRecord(values) || !Array.isArray(values.messages)) return;
    for (const message of [...values.messages].reverse()) {
      if (
        !isRecord(message) ||
        !Array.isArray(message.tool_calls) ||
        message.tool_calls.length === 0
      )
        continue;
      this.partialToolCalls.clear();
      this.collectToolCallChunks(
        typeof message.id === "string" ? message.id : "checkpoint",
        message,
        true,
      );
      break;
    }
  }

  get usage(): AgentUsage | undefined {
    if (this.usages.size === 0) return undefined;
    return sumUsage([...this.usages.values()]);
  }

  private messageUsage(
    messageId: string,
    message: Record<string, unknown>,
  ): AgentUsage | undefined {
    const usage = toUsage(message.usage_metadata);
    if (!usage) return undefined;
    const previous = this.usages.get(messageId);
    const total =
      isBaseMessageChunk(message) && previous
        ? sumUsage([previous, usage])
        : usage;
    this.usages.set(messageId, total);
    return total;
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
    snapshot = false,
  ): void {
    if (
      Array.isArray(message.tool_calls) &&
      (snapshot ||
        !Array.isArray(message.tool_call_chunks) ||
        message.tool_call_chunks.length === 0)
    ) {
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

function toToolOutput(
  value: unknown,
  toolCallId: string,
): { output: JsonValue; isError?: boolean } {
  if (isCommand(value)) {
    const update: unknown = value.update;
    let messages: unknown[] = [];
    if (isRecord(update) && Array.isArray(update.messages))
      messages = update.messages;
    else if (Array.isArray(update)) {
      for (const entry of update) {
        if (
          Array.isArray(entry) &&
          entry[0] === "messages" &&
          Array.isArray(entry[1])
        )
          messages.push(...entry[1]);
      }
    }
    value =
      messages.find(
        (message) =>
          isToolMessage(message) && message.tool_call_id === toolCallId,
      ) ?? null;
  }
  const output = isRecord(value) && "content" in value ? value.content : value;
  return {
    output: cloneJsonValue(output, "Tool output"),
    ...(isToolMessage(value) && value.status === "error"
      ? { isError: true }
      : {}),
  };
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
      (typeof item.text === "string" ||
        typeof item.reasoning === "string" ||
        typeof item.thinking === "string")
    ) {
      let text = String(item.thinking);
      if (typeof item.text === "string") text = item.text;
      else if (typeof item.reasoning === "string") text = item.reasoning;
      return [{ type: "reasoning", text }];
    }
    if (
      item.type === "image" ||
      item.type === "audio" ||
      item.type === "video" ||
      item.type === "file"
    ) {
      const media: Record<string, unknown> = { type: item.type };
      if (typeof item.url === "string") media.url = item.url;
      else if (typeof item.data === "string") media.data = item.data;
      else if (typeof item.base64 === "string") media.data = item.base64;
      else if (typeof item.fileId === "string") media.fileId = item.fileId;
      else if (typeof item.file_id === "string") media.fileId = item.file_id;
      else
        return [
          { type: "custom", name: "model-content", data: cloneJsonValue(item) },
        ];
      const mimeType = item.mimeType ?? item.mime_type;
      if (typeof mimeType === "string") media.mimeType = mimeType;
      const name = item.name ?? item.filename;
      if (item.type === "file" && typeof name === "string") media.name = name;
      return cloneContentParts([media], "Model content");
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
  if (
    isRecord(value.output_token_details) &&
    typeof value.output_token_details.reasoning === "number"
  )
    usage.reasoningTokens = value.output_token_details.reasoning;
  else if (typeof value.reasoning_tokens === "number")
    usage.reasoningTokens = value.reasoning_tokens;
  if (
    isRecord(value.input_token_details) &&
    typeof value.input_token_details.cache_read === "number"
  )
    usage.cachedInputTokens = value.input_token_details.cache_read;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function appendContent(content: ContentPart[], part: ContentPart): void {
  const last = content[content.length - 1];
  if (
    (part.type === "text" || part.type === "reasoning") &&
    last?.type === part.type
  )
    last.text += part.text;
  else content.push({ ...part });
}
