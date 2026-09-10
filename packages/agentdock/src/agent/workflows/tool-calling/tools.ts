import {
  tool,
  type StructuredToolInterface,
  type ToolRuntime,
} from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
import {
  cloneJsonObject,
  cloneJsonValue,
  type JsonValue,
} from "@agentdock/contracts";
import type {
  AgentContext,
  Tool,
  ToolCallRecord,
  ToolErrorRecord,
  ToolResultRecord,
} from "../../types.js";
import { ToolRegistry, validateToolInput } from "../../../tools/registry.js";
import { errorMessage } from "../../value.js";
import { isRecord } from "../../value.js";

export interface ToolOutcome {
  result?: ToolResultRecord;
  error?: ToolErrorRecord;
}

export type ToolOutcomes = Map<string, ToolOutcome>;

export interface ToolProgress {
  toolCallId: string;
  text: string;
}

export function createToolCallingTools(
  registry: ToolRegistry,
  toolTimeout: number | undefined,
  authorizationTimeout: number | undefined,
  outcomes: ToolOutcomes,
  onProgress?: (progress: ToolProgress) => void,
): StructuredToolInterface[] {
  return registry.list().map((toolDefinition) =>
    tool(
      async (
        rawInput: unknown,
        runtime: ToolRuntime<unknown, AgentContext>,
      ) => {
        const input = cloneJsonObject(
          rawInput,
          `Tool input: ${toolDefinition.name}`,
        );
        validateToolInput(
          toolDefinition.parameters,
          input,
          toolDefinition.name,
        );
        const toolCall: ToolCallRecord = {
          toolCallId: runtime.toolCallId,
          name: toolDefinition.name,
          input,
        };

        try {
          if (toolDefinition.authorize) {
            const authorization = await authorizeToolCall(
              toolDefinition,
              toolCall,
              runtime.context,
              runtime.config.signal,
              authorizationTimeout,
            );
            if (!authorization.allowed) {
              throw codedError("authorization_denied", authorization.reason);
            }
          }

          const reportProgress = onProgress
            ? (text: string): void => {
                if (typeof text !== "string") {
                  throw new Error("Tool progress must be a string.");
                }
                onProgress({ toolCallId: toolCall.toolCallId, text });
              }
            : undefined;
          const output = await executeWithDeadline(
            (signal) =>
              toolDefinition.execute({
                input,
                ctx: runtime.context,
                signal,
                toolCallId: toolCall.toolCallId,
                ...(reportProgress ? { reportProgress } : {}),
              }),
            runtime.config.signal,
            toolTimeout,
            "tool_timeout",
          );
          const serializedOutput = serializeToolOutput(output);
          outcomes.set(toolCall.toolCallId, {
            result: { ...toolCall, output: serializedOutput },
          });
          return new ToolMessage({
            content:
              typeof serializedOutput === "string"
                ? serializedOutput
                : JSON.stringify(serializedOutput),
            artifact: serializedOutput,
            additional_kwargs: {
              agentdockToolCall: {
                id: toolCall.toolCallId,
                name: toolCall.name,
                args: input,
              },
            },
            tool_call_id: toolCall.toolCallId,
            name: toolDefinition.name,
          });
        } catch (error) {
          outcomes.set(toolCall.toolCallId, {
            error: {
              ...toolCall,
              error: errorMessage(error),
              ...(errorCode(error) ? { code: errorCode(error) } : {}),
            },
          });
          throw error;
        }
      },
      {
        name: toolDefinition.name,
        description: toolDefinition.description,
        schema: toolDefinition.parameters,
      },
    ),
  );
}

export async function authorizeToolCall(
  toolDefinition: Tool,
  toolCall: ToolCallRecord,
  ctx: AgentContext,
  signal: AbortSignal | undefined,
  timeout: number | undefined,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (!toolDefinition.authorize) return { allowed: true };
  let authorization: unknown;
  try {
    authorization = await executeWithDeadline(
      (authorizationSignal) =>
        Promise.resolve(
          toolDefinition.authorize!({
            toolCall,
            ctx,
            signal: authorizationSignal,
          }),
        ),
      signal,
      timeout,
      "authorization_timeout",
    );
  } catch (error) {
    if (errorCode(error)) throw error;
    throw codedError("authorization_failed", errorMessage(error));
  }
  try {
    assertAuthorizationResult(authorization);
  } catch (error) {
    throw codedError("authorization_invalid", errorMessage(error));
  }
  return authorization;
}

function serializeToolOutput(output: unknown): JsonValue {
  return cloneJsonValue(output, "Tool output");
}

async function executeWithDeadline<T>(
  execute: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  timeout: number | undefined,
  timeoutCode: "tool_timeout" | "authorization_timeout",
): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted.");
  if (timeout === undefined && signal === undefined) {
    return execute(new AbortController().signal);
  }

  const timeoutController = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () =>
      reject(combinedSignal.reason ?? new Error("Aborted."));
    if (combinedSignal.aborted) {
      onAbort();
      return;
    }
    combinedSignal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () =>
      combinedSignal.removeEventListener("abort", onAbort);
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    if (timeout === undefined) return;
    timer = setTimeout(() => {
      const timeoutError = codedError(timeoutCode, timeoutCode);
      timeoutController.abort(timeoutError);
      reject(timeoutError);
    }, timeout);
  });

  try {
    return await Promise.race([
      execute(combinedSignal),
      abortPromise,
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener?.();
  }
}

function assertAuthorizationResult(
  value: unknown,
): asserts value is { allowed: true } | { allowed: false; reason: string } {
  if (!isRecord(value) || typeof value.allowed !== "boolean") {
    throw new Error("Tool authorization must return { allowed: boolean }.");
  }
  if (!value.allowed && typeof value.reason !== "string") {
    throw new Error("Denied tool authorization must include a string reason.");
  }
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}
