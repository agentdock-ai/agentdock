import {
  AgentEventType,
  cloneContentParts,
  type AgentEvent,
  type AgentReducerState,
  type ConversationMessage,
  type ContentPart,
} from "@agentdock-ai/contracts";
import type { ThreadRecord, OperationRecord } from "./store.js";

export function messagesForEvent(
  event: AgentEvent,
  state: AgentReducerState,
  messages: Map<string, ConversationMessage>,
  thread: ThreadRecord,
  operation: OperationRecord,
): ConversationMessage[] {
  const changed: ConversationMessage[] = [];
  const activityMessage = toolActivityMessage(
    event,
    messages,
    thread,
    operation,
  );
  if (activityMessage) changed.push(activityMessage);
  for (const item of state.messages) {
    const previous = messages.get(item.messageId);
    if (
      event.type !== AgentEventType.MessageStarted &&
      event.type !== AgentEventType.MessagePartDelta &&
      event.type !== AgentEventType.MessageCompleted
    )
      continue;
    if ("messageId" in event && event.messageId !== item.messageId) continue;
    if (item.role === "user") {
      const userId = `user:${operation.id}`;
      const saved = messages.get(userId);
      if (!saved) continue;
      const userMessage: ConversationMessage = {
        ...saved,
        id: item.messageId,
        content: cloneContent(item.content),
      };
      messages.delete(userId);
      messages.set(item.messageId, userMessage);
      changed.push(userMessage);
      continue;
    }
    if (!previous && item.content.length === 0) continue;
    const status: ConversationMessage["outcome"] =
      event.type === AgentEventType.MessageCompleted ? "complete" : "streaming";
    const message: ConversationMessage = {
      id: item.messageId,
      turnId: operation.turnId,
      operationId: operation.id,
      position: previous?.position ?? thread.nextPosition++,
      role: item.role,
      content: cloneContent(item.content),
      outcome: status,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    };
    messages.set(item.messageId, message);
    changed.push(message);
  }
  if (isTerminal(event)) {
    const outcome: ConversationMessage["outcome"] =
      event.type === AgentEventType.RunCompleted
        ? "complete"
        : event.type === AgentEventType.RunFailed
          ? "error"
          : "stopped";
    for (const [id, message] of messages) {
      if (message.outcome !== "streaming") continue;
      const updated = { ...message, outcome };
      messages.set(id, updated);
      changed.push(updated);
    }
  }
  if (event.type === AgentEventType.RunPaused) {
    for (const [id, message] of messages) {
      if (message.outcome !== "streaming") continue;
      const updated = { ...message, outcome: "stopped" as const };
      messages.set(id, updated);
      changed.push(updated);
    }
  }
  return changed;
}

function toolActivityMessage(
  event: AgentEvent,
  messages: Map<string, ConversationMessage>,
  thread: ThreadRecord,
  operation: OperationRecord,
): ConversationMessage | undefined {
  if (
    event.type !== AgentEventType.ToolCalled &&
    event.type !== AgentEventType.ToolCompleted &&
    event.type !== AgentEventType.ToolFailed
  )
    return undefined;

  const toolCall =
    event.type === AgentEventType.ToolCalled
      ? event.toolCall
      : event.type === AgentEventType.ToolCompleted
        ? event.result
        : event.error;
  const id = `tool:${thread.id}:${toolCall.toolCallId}`;
  const previous = messages.get(id);
  const callPart: ContentPart = { type: "tool-call", toolCall };
  const content = previous?.content.some(
    (part) =>
      part.type === "tool-call" &&
      part.toolCall.toolCallId === toolCall.toolCallId,
  )
    ? [...previous.content]
    : [...(previous?.content ?? []), callPart];

  if (event.type === AgentEventType.ToolCompleted) {
    content.push({ type: "tool-result", result: event.result });
  } else if (event.type === AgentEventType.ToolFailed) {
    content.push({
      type: "tool-result",
      result: {
        toolCallId: event.error.toolCallId,
        name: event.error.name,
        input: event.error.input,
        output: event.error.error,
        isError: true,
      },
    });
  }

  const message: ConversationMessage = {
    id,
    turnId: operation.turnId,
    operationId: operation.id,
    position: previous?.position ?? thread.nextPosition++,
    role: "assistant",
    content,
    outcome:
      event.type === AgentEventType.ToolCalled ? "streaming" : "complete",
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
  messages.set(id, message);
  return message;
}

function cloneContent(parts: ContentPart[]): ContentPart[] {
  return structuredClone(parts);
}

export function isTerminal(event: AgentEvent): boolean {
  return (
    event.type === AgentEventType.RunCompleted ||
    event.type === AgentEventType.RunFailed ||
    event.type === AgentEventType.RunCancelled
  );
}

export function mapDisplayEvent(
  event: AgentEvent,
  urls: Map<string, string>,
): AgentEvent {
  if (urls.size === 0) return event;
  if (event.type === AgentEventType.MessagePartDelta)
    return { ...event, part: mapMediaPart(event.part, urls) };
  if (
    event.type === AgentEventType.MessageCompleted ||
    event.type === AgentEventType.RunCompleted
  )
    return {
      ...event,
      content: event.content.map((part) => mapMediaPart(part, urls)),
    };
  return event;
}

function mapMediaPart(
  part: ContentPart,
  urls: Map<string, string>,
): ContentPart {
  if (!(
    part.type === "image" ||
    part.type === "audio" ||
    part.type === "video" ||
    part.type === "file"
  ))
    return part;
  const mapped =
    (part.url && urls.get(part.url)) ||
    (part.data &&
      part.mimeType &&
      urls.get(`data:${part.mimeType};base64,${part.data}`));
  if (!mapped) return part;
  const { data: _data, fileId: _fileId, ...rest } = part;
  return cloneContentParts([{ ...rest, url: mapped }])[0]!;
}
