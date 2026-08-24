import type { TextStreamPart, ToolSet } from "ai";
import {
  AgentEventType,
  type AgentError,
  type AgentEvent,
  type AgentEventPayload,
} from "../events.js";
import type {
  ToolApprovalRequest,
  ToolApprovalResponse,
} from "../permissions/types.js";
import type { AgentRunRecord } from "../runs/store.js";
import type { AgentRunResult } from "../types.js";
import type {
  ToolCallRecord,
  ToolResultRecord,
} from "../types.js";
import { toErrorMessage } from "./errors.js";

interface NormalizerState {
  step: number;
  toolCalls: Map<string, ToolCallRecord>;
  approvalRequestIds: Set<string>;
  approvalResponseIds: Set<string>;
}

function createNormalizerState(step = 0): NormalizerState {
  return {
    step,
    toolCalls: new Map(),
    approvalRequestIds: new Set(),
    approvalResponseIds: new Set(),
  };
}

export interface AgentEventStreamOptions {
  runId: string;
  rawStream: AsyncIterable<TextStreamPart<ToolSet>>;
  result: Promise<AgentRunResult>;
  getRun: () => Promise<AgentRunRecord | null>;
  initialEvents?: readonly AgentEventPayload[];
  stepOffset?: number;
}

export class AgentEventStream implements AsyncIterable<AgentEvent> {
  private readonly state: NormalizerState;
  private readonly initialEvents: readonly AgentEventPayload[];
  private consumed = false;

  constructor(private readonly options: AgentEventStreamOptions) {
    this.state = createNormalizerState(options.stepOffset ?? 0);
    this.initialEvents = options.initialEvents ?? [];
  }

  [Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
    if (this.consumed) {
      throw new Error("AgentEventStream can only be consumed once");
    }

    this.consumed = true;
    return this.consume();
  }

  private async *consume(): AsyncGenerator<AgentEvent> {
    for (const payload of this.initialEvents) {
      const event = this.publish(payload);
      this.rememberApprovalEvent(event);
      yield event;
    }

    try {
      for await (const part of this.options.rawStream) {
        for (const payload of this.normalize(part)) {
          yield this.publish(payload);
        }
      }
    } catch {
      // The final result carries the authoritative failure or cancellation state.
    }

    try {
      const output = await this.options.result;

      if (output.status === "waiting_for_approval") {
        const approvals = serializeApprovalRequests(output.approvalRequests)
          .filter((approval) => !this.state.approvalRequestIds.has(approval.approvalId));

        if (approvals.length > 0) {
          yield this.publish({
            type: AgentEventType.ApprovalRequired,
            approvals,
          });
        }
        return;
      }

      if (output.status === "cancelled") {
        yield this.publish({
          type: AgentEventType.RunCancelled,
          reason: "Agent run cancelled",
        });
        return;
      }

      yield this.publish({
        type: AgentEventType.RunCompleted,
        content: output.content,
        stepsCompleted: output.stepsCompleted,
      });
    } catch (error) {
      const current = await this.options.getRun();
      if (current?.status === "cancelled") {
        yield this.publish({
          type: AgentEventType.RunCancelled,
          reason: current.error ?? "Agent run cancelled",
        });
        return;
      }

      yield this.publish({
        type: AgentEventType.RunFailed,
        error: toAgentError(error),
      });
    }
  }

  private normalize(
    part: TextStreamPart<ToolSet>,
  ): AgentEventPayload[] {
    switch (part.type) {
      case "text-start":
        return [{ type: AgentEventType.TextStarted, id: part.id }];

      case "text-delta":
        return [{ type: AgentEventType.TextDelta, id: part.id, text: part.text }];

      case "text-end":
        return [{ type: AgentEventType.TextCompleted, id: part.id }];

      case "reasoning-start":
        return [{ type: AgentEventType.ReasoningStarted, id: part.id }];

      case "reasoning-delta":
        return [{
          type: AgentEventType.ReasoningDelta,
          id: part.id,
          text: part.text,
        }];

      case "reasoning-end":
        return [{ type: AgentEventType.ReasoningCompleted, id: part.id }];

      case "custom":
        return [{
          type: AgentEventType.Custom,
          kind: part.kind,
        }];

      case "tool-input-start":
        return [{
          type: AgentEventType.ToolInputStarted,
          id: part.id,
          toolName: part.toolName,
          ...(part.toolMetadata === undefined
            ? {}
            : { metadata: toSerializable(part.toolMetadata) }),
        }];

      case "tool-input-delta":
        return [{
          type: AgentEventType.ToolInputDelta,
          id: part.id,
          delta: part.delta,
        }];

      case "tool-input-end":
        return [{ type: AgentEventType.ToolInputCompleted, id: part.id }];

      case "source":
        return [{
          type: AgentEventType.SourceAvailable,
          source: toSerializable(part),
        }];

      case "file":
        return [{
          type: AgentEventType.FileGenerated,
          file: toSerializable(part.file),
        }];

      case "reasoning-file":
        return [{
          type: AgentEventType.ReasoningFileGenerated,
          file: toSerializable(part.file),
        }];

      case "start-step":
        this.state.step += 1;
        return [{ type: AgentEventType.StepStarted, step: this.state.step }];

      case "finish-step":
        return [{
          type: AgentEventType.StepCompleted,
          step: Math.max(1, this.state.step),
        }];

      case "start":
        return [{ type: AgentEventType.StreamStarted }];

      case "finish":
        return [{
          type: AgentEventType.StreamFinished,
          finishReason: part.finishReason,
          usage: toSerializable(part.totalUsage),
        }];

      case "abort":
        return [{
          type: AgentEventType.StreamAborted,
          ...(part.reason ? { reason: part.reason } : {}),
        }];

      case "error":
        return [{
          type: AgentEventType.StreamError,
          error: toAgentError(part.error),
        }];

      case "raw":
        return [{
          type: AgentEventType.StreamRaw,
          value: toSerializable(part.rawValue),
        }];

      case "tool-call": {
        const toolCall = serializeToolCall({
          toolCallId: part.toolCallId,
          name: part.toolName,
          input: part.input,
        });
        this.state.toolCalls.set(toolCall.toolCallId, toolCall);
        return [{ type: AgentEventType.ToolCalled, toolCall }];
      }

      case "tool-result":
        return [{
          type: AgentEventType.ToolResult,
          result: serializeToolResult({
            toolCallId: part.toolCallId,
            name: part.toolName,
            input: part.input,
            output: part.output,
          }),
        }];

      case "tool-error": {
        const toolCall = this.state.toolCalls.get(part.toolCallId) ?? serializeToolCall({
          toolCallId: part.toolCallId,
          name: part.toolName,
          input: part.input,
        });
        return [{
          type: AgentEventType.ToolError,
          toolCall,
          error: toAgentError(part.error),
        }];
      }

      case "tool-output-denied": {
        const toolCall = this.state.toolCalls.get(part.toolCallId) ?? {
          toolCallId: part.toolCallId,
          name: part.toolName,
          input: null,
        };
        return [{
          type: AgentEventType.ToolOutputDenied,
          toolCall,
        }];
      }

      case "tool-approval-request": {
        if (this.state.approvalRequestIds.has(part.approvalId)) return [];
        this.state.approvalRequestIds.add(part.approvalId);
        const toolCall = serializeSdkToolCall(part.toolCall);
        this.state.toolCalls.set(toolCall.toolCallId, toolCall);
        return [{
          type: AgentEventType.ApprovalRequired,
          approvals: [{ approvalId: part.approvalId, toolCall }],
        }];
      }

      case "tool-approval-response": {
        if (this.state.approvalResponseIds.has(part.approvalId)) return [];
        this.state.approvalResponseIds.add(part.approvalId);
        return [{
          type: AgentEventType.ApprovalResolved,
          approvals: [{
            approvalId: part.approvalId,
            toolCall: serializeSdkToolCall(part.toolCall),
            approved: part.approved,
            ...(part.reason ? { reason: part.reason } : {}),
          }],
        }];
      }

      default:
        return [{
          type: AgentEventType.StreamRaw,
          value: toSerializable(part),
        }];
    }
  }

  private publish(payload: AgentEventPayload): AgentEvent {
    return {
      ...payload,
      version: 1,
      eventId: crypto.randomUUID(),
      runId: this.options.runId,
      timestamp: new Date().toISOString(),
    } as AgentEvent;
  }

  private rememberApprovalEvent(event: AgentEvent): void {
    if (event.type === AgentEventType.ApprovalRequired) {
      for (const approval of event.approvals) {
        this.state.approvalRequestIds.add(approval.approvalId);
      }
    }

    if (event.type === AgentEventType.ApprovalResolved) {
      for (const approval of event.approvals) {
        this.state.approvalResponseIds.add(approval.approvalId);
      }
    }
  }
}

export function toAgentError(error: unknown): AgentError {
  if (error instanceof Error) {
    return {
      code: error.name || "AGENT_RUN_FAILED",
      message: error.message,
    };
  }

  return {
    code: "AGENT_RUN_FAILED",
    message: toErrorMessage(error),
  };
}

export function serializeToolCall(toolCall: ToolCallRecord): ToolCallRecord {
  return {
    ...toolCall,
    input: toSerializable(toolCall.input),
  };
}

function serializeSdkToolCall(toolCall: {
  toolCallId: string;
  toolName: string;
  input: unknown;
}): ToolCallRecord {
  return serializeToolCall({
    toolCallId: toolCall.toolCallId,
    name: toolCall.toolName,
    input: toolCall.input,
  });
}

export function serializeToolResult(
  result: ToolResultRecord,
): ToolResultRecord {
  return {
    ...result,
    input: toSerializable(result.input),
    output: toSerializable(result.output),
  };
}

export function serializeApprovalResponses(
  responses: ToolApprovalResponse[],
): ToolApprovalResponse[] {
  return responses.map((response) => ({
    ...response,
    toolCall: serializeToolCall(response.toolCall),
  }));
}

export function serializeApprovalRequests(
  requests: ToolApprovalRequest[],
): ToolApprovalRequest[] {
  return requests.map((request) => ({
    ...request,
    toolCall: serializeToolCall(request.toolCall),
  }));
}

function toSerializable(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === undefined) return null;
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return String(value);
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => toSerializable(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      toSerializable(item, seen),
    ]),
  );
}
