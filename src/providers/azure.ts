import { createAzure } from "@ai-sdk/azure";
import type { LanguageModel } from "ai";
import { BaseModelProvider } from "./base.js";

export interface AzureModelOptions {
  modelId: string;
  apiKey?: string;
  baseURL?: string;
  resourceName?: string;
  apiVersion?: string;
  useDeploymentBasedUrls?: boolean;
  headers?: Record<string, string>;
  tokenProvider?: () => Promise<string>;
}

export class AzureModelProvider extends BaseModelProvider<AzureModelOptions> {
  readonly type = "azure";

  protected createLanguageModel(
    modelId: string,
    options: AzureModelOptions,
  ): LanguageModel {
    const provider = createAzure({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.resourceName ? { resourceName: options.resourceName } : {}),
      ...(options.apiVersion ? { apiVersion: options.apiVersion } : {}),
      ...(options.useDeploymentBasedUrls !== undefined
        ? { useDeploymentBasedUrls: options.useDeploymentBasedUrls }
        : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.tokenProvider ? { tokenProvider: options.tokenProvider } : {}),
    });

    return provider(modelId);
  }
}
