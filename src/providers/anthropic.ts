import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { BaseModelProvider } from "./base.js";

export interface AnthropicModelOptions {
  modelId: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

export class AnthropicModelProvider extends BaseModelProvider<AnthropicModelOptions> {
  readonly type = "anthropic";

  protected createLanguageModel(
    modelId: string,
    options: AnthropicModelOptions,
  ): LanguageModel {
    const provider = createAnthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.authToken ? { authToken: options.authToken } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });

    return provider(modelId);
  }
}
