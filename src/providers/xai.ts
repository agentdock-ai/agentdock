import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import { BaseModelProvider } from "./base.js";

export interface XaiModelOptions {
  modelId: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

export class XaiModelProvider extends BaseModelProvider<XaiModelOptions> {
  readonly type = "xai";

  protected createLanguageModel(
    modelId: string,
    options: XaiModelOptions,
  ): LanguageModel {
    const provider = createXai({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });

    return provider(modelId);
  }
}
