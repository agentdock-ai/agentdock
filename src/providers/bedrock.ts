import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { LanguageModel } from "ai";
import { BaseModelProvider } from "./base.js";

export interface AmazonBedrockModelOptions {
  modelId: string;
  region?: string;
  apiKey?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

export class AmazonBedrockModelProvider extends BaseModelProvider<AmazonBedrockModelOptions> {
  readonly type = "amazon-bedrock";

  protected createLanguageModel(
    modelId: string,
    options: AmazonBedrockModelOptions,
  ): LanguageModel {
    const provider = createAmazonBedrock({
      ...(options.region ? { region: options.region } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.accessKeyId ? { accessKeyId: options.accessKeyId } : {}),
      ...(options.secretAccessKey
        ? { secretAccessKey: options.secretAccessKey }
        : {}),
      ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });

    return provider(modelId);
  }
}
