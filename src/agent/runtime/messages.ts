import type { ModelMessage } from "ai";
import type { Message } from "../memory.js";
import type {
  ToolCallRecord,
  ToolResultRecord,
} from "../types.js";
import type {
  ToolApprovalResponse,
  ToolApprovalRequest,
} from "../permissions/types.js";

export function toModelInput(messages: Message[]): {
  instructions?: string;
  messages: ModelMessage[];
} {
  const instructions = messages
    .filter((message) => message.role === "system" && message.compacted !== true)
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n\n");

  const conversation = messages.filter(
    (message) => message.role !== "system" || message.compacted === true,
  );

  return {
    ...(instructions ? { instructions } : {}),
    messages: conversation.map(toModelMessage),
  };
}

function toModelMessage(message: Message): ModelMessage {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant": {
      const parts: any[] = [];
      if (message.content) parts.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.name,
          input: call.input,
        });
      }
      for (const request of message.approvalRequests ?? []) {
        parts.push({
          type: "tool-approval-request",
          approvalId: request.approvalId,
          toolCallId: request.toolCall.toolCallId,
        });
      }
      return { role: "assistant", content: parts.length > 0 ? parts : "" };
    }
    case "tool":
      return {
        role: "tool",
        content: [
          ...message.toolResults.map((result) => ({
            type: "tool-result" as const,
            toolCallId: result.toolCallId,
            toolName: result.name,
            output: result.output as any,
          })),
          ...(message.approvalResponses ?? []).map((response) => ({
            type: "tool-approval-response" as const,
            approvalId: response.approvalId,
            approved: response.approved,
            ...(response.reason ? { reason: response.reason } : {}),
          })),
        ],
      };
    case "system":
      return { role: "user", content: message.content };
  }
}

function textFromAssistantContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is { type: "text"; text: string } =>
      part.type === "text" && typeof (part as any).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

export function toInternalMessages(responseMessages: ModelMessage[]): Message[] {
  const approvalRequestsById = new Map<string, ToolApprovalRequest>();

  return responseMessages.flatMap((message): Message[] => {
    if (message.role === "assistant") {
      const toolCalls: ToolCallRecord[] = Array.isArray(message.content)
        ? message.content
            .filter((part) => part.type === "tool-call")
            .map((part: any) => ({
              toolCallId: part.toolCallId,
              name: part.toolName,
              input: part.input,
            }))
        : [];
      const internalApprovalRequests = Array.isArray(message.content)
        ? message.content
            .filter(
              (part) =>
                part.type === "tool-approval-request" &&
                part.isAutomatic !== true,
            )
            .flatMap((part: any) => {
              const toolCall = toolCalls.find(
                (call) => call.toolCallId === part.toolCallId,
              );
              return toolCall
                ? [{ approvalId: part.approvalId, toolCall }]
                : [];
            })
        : [];

      for (const request of internalApprovalRequests) {
        approvalRequestsById.set(request.approvalId, request);
      }

      return [{
        role: "assistant",
        content: textFromAssistantContent(message.content),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(internalApprovalRequests.length > 0
          ? { approvalRequests: internalApprovalRequests }
          : {}),
      }];
    }

    if (message.role === "tool") {
      const toolResults: ToolResultRecord[] = message.content
        .filter((part) => part.type === "tool-result")
        .map((part: any) => ({
          toolCallId: part.toolCallId,
          name: part.toolName,
          input: part.input,
          output: part.output,
        }));

      const approvalResponses: ToolApprovalResponse[] = message.content
        .filter((part) => part.type === "tool-approval-response")
        .flatMap((part: any) => {
          const request = approvalRequestsById.get(part.approvalId);
          return request
            ? [{
                approvalId: part.approvalId,
                approved: part.approved,
                toolCall: request.toolCall,
                ...(part.reason ? { reason: part.reason } : {}),
              }]
            : [];
        });

      return toolResults.length > 0 || approvalResponses.length > 0
        ? [{
            role: "tool",
            content: toolResults.length > 0 ? JSON.stringify(toolResults) : "",
            toolResults,
            ...(approvalResponses.length > 0 ? { approvalResponses } : {}),
          }]
        : [];
    }

    return [];
  });
}

export function normalizeToolCalls(toolCalls: any[]): ToolCallRecord[] {
  return toolCalls.map((call) => ({
    toolCallId: call.toolCallId,
    name: call.toolName,
    input: call.input,
  }));
}

export function normalizeToolResults(toolResults: any[]): ToolResultRecord[] {
  return toolResults.map((result) => ({
    toolCallId: result.toolCallId,
    name: result.toolName,
    input: result.input,
    output: result.output,
  }));
}
