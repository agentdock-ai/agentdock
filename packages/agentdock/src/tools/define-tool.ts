import { cloneJsonObject } from "@agentdock-ai/contracts";
import { z } from "zod";
import type {
  AgentContext,
  Tool,
  ToolAuthorizationInput,
  ToolAuthorizationResult,
} from "../agent/types.js";

export interface DefineToolOptions<
  Schema extends z.ZodObject,
  Context extends AgentContext = AgentContext,
> {
  name: string;
  description: string;
  input: Schema;
  requiresApproval?: boolean;
  authorize?: (
    input: ToolAuthorizationInput,
  ) => ToolAuthorizationResult | Promise<ToolAuthorizationResult>;
  run: (
    input: z.output<Schema>,
    ctx: Context,
    signal: AbortSignal,
    reportProgress?: (text: string) => void,
    toolCallId?: string,
  ) => unknown | Promise<unknown>;
}

/** Creates a typed AgentDock tool from a Zod object schema. */
export function defineTool<
  Schema extends z.ZodObject,
  Context extends AgentContext = AgentContext,
>(options: DefineToolOptions<Schema, Context>): Tool {
  const parameters = cloneJsonObject(
    z.toJSONSchema(options.input),
    `Tool parameters: ${options.name}`,
  );
  return {
    name: options.name,
    description: options.description,
    parameters,
    ...(options.requiresApproval !== undefined
      ? { requiresApproval: options.requiresApproval }
      : {}),
    ...(options.authorize ? { authorize: options.authorize } : {}),
    execute: async ({ input, ctx, signal, reportProgress, toolCallId }) => {
      const parsed = options.input.safeParse(input);
      if (!parsed.success) {
        throw new Error(
          `Invalid input for tool ${options.name}: ${parsed.error.message}`,
        );
      }
      return options.run(
        parsed.data,
        ctx as Context,
        signal,
        reportProgress,
        toolCallId,
      );
    },
  };
}
