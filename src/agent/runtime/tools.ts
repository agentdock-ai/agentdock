import {
  jsonSchema,
  tool as defineAiTool,
  type ToolExecutionOptions,
  type ToolSet,
} from "ai";
import type { AgentContext, ToolErrorRecord } from "../types.js";
import type { AgentHooks } from "../hooks.js";
import {
  deriveAbortSignal,
  releaseAbortSignal,
  toErrorMessage,
  withAbortSignal,
} from "./errors.js";
import type { ToolRegistry } from "../../tools/registry.js";

export function buildToolSet(
  registry: ToolRegistry,
  ctx: AgentContext,
  abortSignal: AbortSignal | undefined,
  toolTimeout: number | undefined,
  hooks: AgentHooks | undefined,
  toolErrors: ToolErrorRecord[],
): ToolSet {
  return Object.fromEntries(
    registry.list().map((registeredTool) => [
      registeredTool.name,
      defineAiTool({
        description: registeredTool.description,
        inputSchema: jsonSchema(registeredTool.parameters),
        execute: async (
          input: unknown,
          options: ToolExecutionOptions<unknown>,
        ) => {
          if (input === null || typeof input !== "object" || Array.isArray(input)) {
            throw new TypeError("Tool input must be an object.");
          }

          const normalizedInput = input as Record<string, unknown>;
          const toolCallId = options.toolCallId;
          const toolAbortSignal = deriveAbortSignal(abortSignal, toolTimeout);

          try {
            await hooks?.onToolCall?.({
              toolCallId,
              name: registeredTool.name,
              input: normalizedInput,
            });

            let execution = registeredTool.execute({
              input: normalizedInput,
              ctx,
              signal: toolAbortSignal,
            });

            if (toolAbortSignal) execution = withAbortSignal(execution, toolAbortSignal);

            const result = await execution;
            hooks?.onToolResult?.({
              toolCallId,
              name: registeredTool.name,
              input: normalizedInput,
              result,
            });
            return result;
          } catch (error) {
            const message = toErrorMessage(error);
            toolErrors.push({
              toolCallId,
              name: registeredTool.name,
              input: normalizedInput,
              error: message,
            });
            hooks?.onToolResult?.({
              toolCallId,
              name: registeredTool.name,
              input: normalizedInput,
              result: undefined,
              error: message,
            });
            return { error: message };
          } finally {
            releaseAbortSignal(toolAbortSignal);
          }
        },
      }),
    ]),
  ) as ToolSet;
}
