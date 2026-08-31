import {
  tool,
  type StructuredToolInterface,
  type ToolRuntime,
} from "@langchain/core/tools";
import type {
  AgentContext,
  ToolCallRecord,
  ToolErrorRecord,
  ToolResultRecord,
} from "../types.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { errorMessage, isRecord } from "../value.js";

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
          outcomes.set(toolCall.toolCallId, {
            result: { ...toolCall, output },
          });
          return stringifyToolOutput(output);
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

function requireRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  const serialized = JSON.stringify(output);
  if (serialized === undefined)
    throw new Error("Tool output must be JSON serializable.");
  return serialized;
}

function withTimeout(
  signal: AbortSignal | undefined,
  timeout: number | undefined,
): AbortSignal | undefined {
  if (timeout === undefined) return signal;
  const timeoutSignal = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}
