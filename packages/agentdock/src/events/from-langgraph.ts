import { isBaseMessage, isBaseMessageChunk } from "@langchain/core/messages";
import {
  AgentEventType,
  assertAgentInterrupt,
  cloneContentParts,
  cloneJsonObject,
  cloneJsonValue,
  sumUsage,
  type AgentEvent,
  type AgentEventInput,
  type AgentInterrupt,
  type AgentUsage,
  type ContentPart,
  type ToolCallRecord,
  type ToolErrorRecord,
  type ToolResultRecord,
} from "@agentdock-ai/contracts";
import {
  toProgressContent,
  toToolOutput,
  toContentParts,
  toJsonObject,
  toUsage,
} from "./native-payload.js";
import type { EventContext } from "./event-context.js";
import type { InterruptFormat } from "../agentdock.js";
import { isRecord } from "../utils/is-record.js";

interface OpenMessage {
  messageId: string;
  role: "assistant" | "user" | "tool";
  content: ContentPart[];
  namespace: readonly string[];
}

interface PartialToolCall {
  id?: string;
  name: string;
  args: string;
}

export class WireEventMapper {
  private readonly openMessages = new Map<string, OpenMessage>();
  private readonly activeTools = new Map<string, ToolCallRecord>();
  private readonly seenMessages = new Set<string>();
  private currentNamespace: readonly string[];
  private lastContent: ContentPart[] = [];
  private readonly usages = new Map<string, AgentUsage>();
  private readonly partialToolCalls = new Map<string, PartialToolCall>();

  constructor(
    private readonly context: EventContext,
    private readonly namespace: readonly string[] = [],
    private readonly interruptFormat: InterruptFormat = "opaque",
  ) {
    this.currentNamespace = namespace;
  }

  private emit(input: AgentEventInput): AgentEvent {
    return this.context.emit(input, this.currentNamespace);
  }
  private scopeId(id: string): string {
    return this.namespace.length
      ? `${JSON.stringify(this.namespace)}:${id}`
      : id;
  }

  map(
    mode: string,
    rawChunk: unknown,
    eventNamespace = this.namespace,
  ): AgentEvent[] {
    this.currentNamespace = eventNamespace;
    switch (mode) {
      case "messages":
        return this.mapMessage(rawChunk);
      case "tools":
        return this.mapTool(rawChunk);
      case "updates":
        return this.mapUpdate(rawChunk);
      default:
        throw new Error("Unsupported event mapping mode.");
    }
  }

  completeMessages(): AgentEvent[] {
    return [...this.openMessages.values()].map((message) =>
      this.completeMessage(message),
    );
  }

  private completeMessage(message: OpenMessage): AgentEvent {
    this.openMessages.delete(message.messageId);
    this.seenMessages.add(message.messageId);
    if (message.role === "assistant") this.lastContent = message.content;
    return this.context.emit(
      {
        type: AgentEventType.MessageCompleted,
        messageId: message.messageId,
        role: message.role,
        content: message.content,
      },
      message.namespace,
    );
  }

  private mapMessage(rawChunk: unknown, collectUsage = true): AgentEvent[] {
    if (!Array.isArray(rawChunk) || rawChunk.length !== 2) {
      throw new Error("LangGraph emitted an unsupported message chunk.");
    }
    const [rawMessage] = rawChunk;
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
    if (typeof rawMessage.id !== "string" || !rawMessage.id)
      throw new Error("Message events require a native message ID.");
    const messageId = this.scopeId(rawMessage.id);
    if (this.seenMessages.has(messageId)) return [];
    this.collectToolCallChunks(messageId, rawMessage);
    const events: AgentEvent[] = [];
    const content = toContentParts(rawMessage.content);
    let openMessage = this.openMessages.get(messageId);

    if (!openMessage) {
      if (content.length === 0) {
        const usage = collectUsage
          ? this.messageUsage(messageId, rawMessage)
          : undefined;
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
      openMessage = {
        messageId,
        role,
        content: [],
        namespace: [...this.currentNamespace],
      };
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

    const usage = collectUsage
      ? this.messageUsage(messageId, rawMessage)
      : undefined;
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
    if (typeof rawChunk.toolCallId !== "string" || !rawChunk.toolCallId)
      throw new Error("Tool events require a native execution ID.");
    const toolCallId = this.scopeId(rawChunk.toolCallId);

    if (rawChunk.event === "on_tool_start") {
      const toolCall: ToolCallRecord = {
        toolCallId,
        name: toolName,
        input: toJsonObject(rawChunk.input),
      };
      this.activeTools.set(toolCallId, toolCall);
      return [this.emit({ type: AgentEventType.ToolCalled, toolCall })];
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
            ...toToolOutput(rawChunk.output, rawChunk.toolCallId),
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
    const events: AgentEvent[] = [];
    const cached =
      isRecord(rawChunk.__metadata__) && rawChunk.__metadata__.cached === true;
    for (const update of Object.values(rawChunk)) {
      if (!isRecord(update) || !Array.isArray(update.messages)) continue;
      for (const message of update.messages) {
        if (!isRecord(message)) continue;
        const id = typeof message.id === "string" ? message.id : "checkpoint";
        this.collectToolCallChunks(id, message, true);
        if (!cached) continue;
        const messageId = this.scopeId(id);
        if (this.seenMessages.has(messageId)) continue;
        const open = this.openMessages.get(messageId);
        if (!open) events.push(...this.mapMessage([message, {}], false));
        const current = this.openMessages.get(messageId);
        if (current) {
          current.content = toContentParts(message.content);
          events.push(this.completeMessage(current));
        }
      }
    }
    const interrupts = rawChunk.__interrupt__;
    if (!Array.isArray(interrupts) || interrupts.length === 0) return events;
    for (const raw of interrupts) {
      const interrupt = this.projectInterrupt(raw);
      events.push(
        ...this.completeMessages(),
        this.emit({ type: AgentEventType.InterruptRequired, interrupt }),
      );
    }
    return events;
  }

  projectInterrupt(first: unknown): AgentInterrupt {
    if (!isRecord(first) || typeof first.id !== "string") {
      throw new Error("LangGraph emitted an interrupt without an ID.");
    }
    const interruptId = first.id;
    const value = isRecord(first.value) ? first.value : {};
    let prompt = "Approval required.";
    if (typeof first.value === "string") prompt = first.value;
    else if (typeof value.prompt === "string") prompt = value.prompt;
    const payload = cloneJsonValue(first.value, "Interrupt payload");
    let interrupt: AgentInterrupt = {
      interruptId,
      kind: "custom",
      prompt,
      payload,
      actions: [],
    };
    if (this.interruptFormat === "langchain-hitl" && "reviewConfigs" in value) {
      if (
        !Array.isArray(value.reviewConfigs) ||
        !Array.isArray(value.actionRequests)
      )
        throw new Error(
          "LangChain approval requires actionRequests and reviewConfigs arrays.",
        );
      const actions = value.actionRequests.map((action) => {
        if (!isRecord(action) || typeof action.name !== "string")
          throw new Error("LangChain approval contains an invalid action.");
        const input = cloneJsonObject(action.args, "Interrupt action args");
        const call = this.findInterruptedToolCall(action.name, input);
        if (!call?.id)
          throw new Error(
            "LangGraph interrupt could not be matched to a streamed tool call.",
          );
        const toolCallId = this.scopeId(call.id);
        return { id: toolCallId, name: action.name, input, toolCallId };
      });
      interrupt = {
        interruptId,
        kind: "tool-approval",
        prompt,
        payload,
        actions,
      };
    }
    if (first.response_schema !== undefined)
      interrupt.responseSchema = cloneJsonValue(
        first.response_schema,
        "Interrupt response schema",
      );
    assertAgentInterrupt(interrupt);
    return interrupt;
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

  seedHistory(values: unknown): void {
    if (!isRecord(values) || !Array.isArray(values.messages)) return;
    for (const message of values.messages)
      if (isRecord(message) && typeof message.id === "string")
        this.seenMessages.add(this.scopeId(message.id));
  }

  get content(): ContentPart[] {
    return cloneContentParts(this.lastContent);
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

function appendContent(content: ContentPart[], part: ContentPart): void {
  const last = content[content.length - 1];
  if (
    (part.type === "text" || part.type === "reasoning") &&
    last?.type === part.type
  )
    last.text += part.text;
  else content.push({ ...part });
}
