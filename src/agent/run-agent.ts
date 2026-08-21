import {
  generateText,
  jsonSchema,
  stepCountIs,
  streamText,
  tool as defineAiTool,
  type GenerateTextOnStepFinishCallback,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { createOpenRouterModel } from "../providers/openrouter.js";
import { defaultToolRegistry, type ToolRegistry } from "../tools/registry.js";
import type { AgentHooks } from "./hooks.js";
import type { Message } from "./memory.js";
import type {
  AgentContext,
  AgentRunResult,
  RunAgentOptions,
  StreamAgentResult,
  ToolCallRecord,
  ToolErrorRecord,
  ToolResultRecord,
} from "./types.js";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "Tool execution was aborted";
    if (error.name === "TimeoutError") return `Tool timed out: ${error.message}`;
    return error.message;
  }
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "name" in error && "message" in error) {
    const e = error as { name: string; message: string };
    if (e.name === "TimeoutError") return `Tool timed out: ${e.message}`;
    if (e.name === "AbortError") return "Tool execution was aborted";
    return e.message;
  }
  return "Tool execution failed";
}

function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Aborted"));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Aborted"));

    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function deriveAbortSignal(
  abortSignal: AbortSignal | undefined,
  toolTimeout: number | undefined,
): AbortSignal | undefined {
  if (abortSignal && toolTimeout != null) {
    return AbortSignal.any([abortSignal, AbortSignal.timeout(toolTimeout)]);
  }
  if (abortSignal) return abortSignal;
  if (toolTimeout != null) return AbortSignal.timeout(toolTimeout);
  return undefined;
}

function toCoreMessages(messages: Message[]): ModelMessage[] {
  return messages.map((msg) => {
    switch (msg.role) {
      case "user": {
        let content = msg.content;
        if (typeof content !== "string") {
          content = JSON.stringify(content);
        }
        return { role: "user" as const, content: content as any };
      }
      case "assistant": {
        const parts: any[] = [];
        if (msg.content) {
          parts.push({ type: "text", text: msg.content });
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            parts.push({
              type: "tool-call",
              toolCallId: tc.toolCallId,
              toolName: tc.name,
              input: tc.input,
            });
          }
        }
        return {
          role: "assistant" as const,
          content: parts.length > 0 ? parts : "",
        };
      }
      case "tool": {
        return {
          role: "tool" as const,
          content: msg.toolResults.map((toolResult) => ({
            type: "tool-result" as const,
            toolCallId: toolResult.toolCallId,
            toolName: toolResult.name,
            output: toolResult.output as any,
          })),
        };
      }
      case "system":
        return { role: "user" as const, content: msg.content };
    }
  });
}

function toModelInput(messages: Message[]): {
  instructions?: string;
  messages: ModelMessage[];
} {
  const instructions = messages
    .filter(
      (message) => message.role === "system" && message.compacted !== true,
    )
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n\n");
  const conversationMessages = messages.filter(
    (message) => message.role !== "system" || message.compacted === true,
  );

  return {
    ...(instructions ? { instructions } : {}),
    messages: toCoreMessages(conversationMessages),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
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

function toInternalMessages(responseMessages: ModelMessage[]): Message[] {
  return responseMessages.flatMap((message): Message[] => {
    if (message.role === "assistant") {
      const toolCalls: ToolCallRecord[] =
        Array.isArray(message.content)
          ? message.content
              .filter((part) => part.type === "tool-call")
              .map((part: any) => ({
                toolCallId: part.toolCallId,
                name: part.toolName,
                input: part.input,
              }))
          : [];

      return [
        {
          role: "assistant",
          content: textFromAssistantContent(message.content),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        },
      ];
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

      if (toolResults.length === 0) return [];

      return [
        {
          role: "tool",
          content: JSON.stringify(toolResults),
          toolResults,
        },
      ];
    }

    return [];
  });
}

function normalizeToolCalls(toolCalls: any[]): ToolCallRecord[] {
  return toolCalls.map((toolCall) => ({
    toolCallId: toolCall.toolCallId,
    name: toolCall.toolName,
    input: toolCall.input,
  }));
}

function normalizeToolResults(toolResults: any[]): ToolResultRecord[] {
  return toolResults.map((toolResult) => ({
    toolCallId: toolResult.toolCallId,
    name: toolResult.toolName,
    input: toolResult.input,
    output: toolResult.output,
  }));
}

function createDefaultModel(options: RunAgentOptions) {
  const modelOptions: { apiKey?: string; modelId: string } = {
    modelId: options.modelId ?? "google/gemini-2.5-flash",
  };
  if (options.apiKey) modelOptions.apiKey = options.apiKey;
  return createOpenRouterModel(modelOptions);
}

function buildToolSet(
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
        execute: async (input: unknown, options: any) => {
          const normalizedInput = input as Record<string, unknown>;
          const toolCallId = options?.toolCallId as string;
          const toolAbortSignal = deriveAbortSignal(abortSignal, toolTimeout);

          if (hooks?.onToolCall) {
            await hooks.onToolCall({
              toolCallId,
              name: registeredTool.name,
              input: normalizedInput,
            });
          }

          let executionPromise = registeredTool.execute({
            input: normalizedInput,
            ctx,
            signal: toolAbortSignal,
          });

          if (toolAbortSignal) {
            executionPromise = withAbortSignal(executionPromise, toolAbortSignal);
          }

          try {
            const result = await executionPromise;
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
          }
        },
      }),
    ])
  ) as ToolSet;
}

function buildHistory(userPrompt: string, options: RunAgentOptions): Message[] {
  const history: Message[] = [...(options.messages ?? [])];
  history.push({ role: "user", content: userPrompt });

  const systemPrompt = options.systemPrompt;
  const hasSystemPrompt = history.some(
    (message) => message.role === "system" && message.compacted !== true,
  );
  if (systemPrompt && !hasSystemPrompt) {
    history.unshift({ role: "system", content: systemPrompt });
  }

  return history;
}

interface PreparedAgentRun {
  abortSignal?: AbortSignal;
  history: Message[];
  maxSteps: number;
  model: NonNullable<RunAgentOptions["model"]>;
  modelInput: ReturnType<typeof toModelInput>;
  onStepFinish: GenerateTextOnStepFinishCallback<ToolSet>;
  toolErrors: ToolErrorRecord[];
  tools: ToolSet;
}

async function prepareAgentRun(
  userPrompt: string,
  ctx: AgentContext,
  options: RunAgentOptions,
): Promise<PreparedAgentRun> {
  const maxSteps = options.maxSteps ?? 10;
  const abortSignal = options.abortSignal;
  const toolErrors: ToolErrorRecord[] = [];
  const hooks = options.hooks;
  const history = buildHistory(userPrompt, options);
  const registry = options.registry ?? defaultToolRegistry;
  const tools = buildToolSet(
    registry,
    ctx,
    abortSignal,
    options.toolTimeout,
    hooks,
    toolErrors,
  );
  const compression = options.compression;

  if (compression?.shouldCompress(history)) {
    await compression.compress(history);
  }

  const activeMessages = history.filter((message) => message.active !== false);
  const modelInput = toModelInput(activeMessages);

  hooks?.onStepStart?.(1);

  return {
    abortSignal,
    history,
    maxSteps,
    model: options.model ?? createDefaultModel(options),
    modelInput,
    onStepFinish: (step) => {
      hooks?.onStepFinish?.(
        step.stepNumber,
        step.text,
        normalizeToolCalls(step.toolCalls ?? []),
      );
    },
    toolErrors,
    tools,
  };
}

function buildModelRequest(prepared: PreparedAgentRun) {
  return {
    model: prepared.model,
    ...prepared.modelInput,
    tools: prepared.tools,
    stopWhen: stepCountIs(prepared.maxSteps),
    ...(prepared.abortSignal ? { abortSignal: prepared.abortSignal } : {}),
    onStepFinish: prepared.onStepFinish,
  };
}

function createAgentRunResult(
  prepared: PreparedAgentRun,
  text: string,
  responseMessages: ModelMessage[],
  toolCalls: any[],
  toolResults: any[],
): AgentRunResult {
  prepared.history.push(...toInternalMessages(responseMessages));

  return {
    content: text,
    messages: prepared.history,
    toolCalls: normalizeToolCalls(toolCalls),
    toolResults: normalizeToolResults(toolResults),
    toolErrors: prepared.toolErrors,
  };
}

export async function runAgent(
  userPrompt: string,
  ctx: AgentContext,
  options: RunAgentOptions = {},
): Promise<AgentRunResult> {
  const prepared = await prepareAgentRun(userPrompt, ctx, options);
  const result = await generateText(buildModelRequest(prepared));

  return createAgentRunResult(
    prepared,
    result.text,
    result.responseMessages,
    result.toolCalls,
    result.toolResults,
  );
}

export async function streamAgent(
  userPrompt: string,
  ctx: AgentContext,
  options: RunAgentOptions = {},
): Promise<StreamAgentResult> {
  const prepared = await prepareAgentRun(userPrompt, ctx, options);
  const stream = streamText(buildModelRequest(prepared));

  const resultPromise = (async (): Promise<AgentRunResult> => {
    const [text, responseMessages, toolCalls, toolResults] = await Promise.all([
      stream.text,
      stream.responseMessages,
      stream.toolCalls,
      stream.toolResults,
    ]);

    return createAgentRunResult(
      prepared,
      text,
      responseMessages,
      toolCalls,
      toolResults,
    );
  })();

  return {
    textStream: stream.textStream,
    fullStream: stream.fullStream,
    result: resultPromise,
  };
}
