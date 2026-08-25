import { createOllama } from "ai-sdk-ollama";
import type { LanguageModel } from "ai";

export interface OllamaModelOptions {
  modelId: string;
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export function createOllamaModel(
  options: OllamaModelOptions,
): LanguageModel {
  if (!options.modelId.trim()) {
    throw new Error(
      "OLLAMA modelId is required. Provide an explicit model ID.",
    );
  }

  const provider = createOllama({
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
  });

  return provider(options.modelId);
}
