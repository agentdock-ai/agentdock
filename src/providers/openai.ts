import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { BaseModelProvider } from "./base.js";

export interface OpenAIModelOptions {
  modelId: string;
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  headers?: Record<string, string>;
}

export class OpenAIModelProvider extends BaseModelProvider<OpenAIModelOptions> {
  readonly type = "openai";

  protected createLanguageModel(
    modelId: string,
    options: OpenAIModelOptions,
  ): LanguageModel {
    const provider = createOpenAI({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.organization ? { organization: options.organization } : {}),
      ...(options.project ? { project: options.project } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });

    return provider(modelId);
  }
}
