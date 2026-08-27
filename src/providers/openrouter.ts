import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { BaseModelProvider, getRuntimeEnv, requireApiKey } from "./base.js";
export interface OpenRouterModelOptions {
  apiKey?: string;
  modelId: string;
}

export class OpenRouterModelProvider extends BaseModelProvider<OpenRouterModelOptions> {
  readonly type = "openrouter";

  protected createLanguageModel(
    modelId: string,
    options: OpenRouterModelOptions,
  ): LanguageModel {
    const apiKey = requireApiKey(
      "OpenRouter",
      options.apiKey ?? getRuntimeEnv("OPENROUTER_API_KEY"),
      "OPENROUTER_API_KEY",
    );

    return createOpenRouter({ apiKey })(modelId);
  }
}
