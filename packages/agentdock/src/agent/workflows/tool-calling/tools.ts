import {
  tool,
  type StructuredToolInterface,
  type ToolRuntime,
} from "@langchain/core/tools";
import type { JsonObject, JsonValue } from "@agentdock/contracts";
import type {
  AgentContext,
  ToolCallRecord,
  ToolErrorRecord,
  ToolResultRecord,
} from "../../types.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import { errorMessage, isRecord } from "../../value.js";

export interface ToolOutcome {
  result?: ToolResultRecord;
  error?: ToolErrorRecord;
}

export type ToolOutcomes = Map<string, ToolOutcome>;

export function createToolCallingTools(
  registry: ToolRegistry,
  toolTimeout: number | undefined,
  outcomes: ToolOutcomes,
): StructuredToolInterface[] {
  return registry.list().map((toolDefinition) =>
    tool(
      async (
        rawInput: unknown,
        runtime: ToolRuntime<unknown, AgentContext>,
      ) => {
        const input = requireRecord(
          rawInput,
          `Tool input must be an object: ${toolDefinition.name}`,
        );
        const toolCall: ToolCallRecord = {
          toolCallId: runtime.toolCallId,
          name: toolDefinition.name,
          input,
        };

        try {
          if (toolDefinition.authorize) {
            const authorization = await toolDefinition.authorize({
              toolCall,
              ctx: runtime.context,
            });
            if (!authorization.allowed) throw new Error(authorization.reason);
          }

          const output = await toolDefinition.execute({
            input,
            ctx: runtime.context,
            signal: withTimeout(runtime.config.signal, toolTimeout),
          });
          const serializedOutput = serializeToolOutput(output);
          outcomes.set(toolCall.toolCallId, {
            result: { ...toolCall, output: serializedOutput },
          });
          return stringifyToolOutput(serializedOutput);
        } catch (error) {
          outcomes.set(toolCall.toolCallId, {
            error: { ...toolCall, error: errorMessage(error) },
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

function requireRecord(value: unknown, message: string): JsonObject {
  if (!isRecord(value)) throw new Error(message);
  return value as JsonObject;
}

function serializeToolOutput(output: unknown): JsonValue {
  const serialized = JSON.stringify(output);
  if (serialized === undefined)
    throw new Error("Tool output must be JSON serializable.");
  return JSON.parse(serialized) as JsonValue;
}

function stringifyToolOutput(output: JsonValue): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output);
}

function withTimeout(
  signal: AbortSignal | undefined,
  timeout: number | undefined,
): AbortSignal | undefined {
  if (timeout === undefined) return signal;
  const timeoutSignal = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}
