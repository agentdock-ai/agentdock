import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export interface OpenRouterModelOptions {
  apiKey?: string;
  modelId?: string;
}

function getEnv(name: string): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };

  return runtime.process?.env?.[name];
}

export function createOpenRouterModel(
  options: OpenRouterModelOptions = {},
): LanguageModel {
  const apiKey = options.apiKey ?? getEnv("OPENROUTER_API_KEY");

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is required to create an OpenRouter model",
    );
  }

  const openrouter = createOpenRouter({ apiKey });
  return openrouter(options.modelId ?? "google/gemini-2.5-flash");
}
