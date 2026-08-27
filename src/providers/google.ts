import { createGoogle } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { BaseModelProvider } from "./base.js";

export interface GoogleModelOptions {
  modelId: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

export class GoogleModelProvider extends BaseModelProvider<GoogleModelOptions> {
  readonly type = "google";

  protected createLanguageModel(
    modelId: string,
    options: GoogleModelOptions,
  ): LanguageModel {
    const provider = createGoogle({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });

    return provider(modelId);
  }
}
