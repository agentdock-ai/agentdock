import { createGateway } from "ai";
import type { LanguageModel } from "ai";
import { BaseModelProvider } from "./base.js";

export interface VercelGatewayModelOptions {
  modelId: string;
  apiKey?: string;
  baseURL?: string;
  teamIdOrSlug?: string;
  headers?: Record<string, string>;
}

export class VercelGatewayModelProvider extends BaseModelProvider<VercelGatewayModelOptions> {
  readonly type = "gateway";

  protected createLanguageModel(
    modelId: string,
    options: VercelGatewayModelOptions,
  ): LanguageModel {
    const provider = createGateway({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.teamIdOrSlug ? { teamIdOrSlug: options.teamIdOrSlug } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });

    return provider(modelId);
  }
}
