import type { LanguageModel } from "ai";

export interface ModelProviderOptions {
  modelId: string;
}

export interface ModelProvider<Options extends ModelProviderOptions> {
  readonly type: string;
  create(options: Options): LanguageModel;
}

export abstract class BaseModelProvider<
  Options extends ModelProviderOptions,
> implements ModelProvider<Options> {
  abstract readonly type: string;

  create(options: Options): LanguageModel {
    const modelId = this.validateModelId(options.modelId);
    return this.createLanguageModel(modelId, options);
  }

  protected abstract createLanguageModel(
    modelId: string,
    options: Options,
  ): LanguageModel;

  protected validateModelId(modelId: string): string {
    const normalizedModelId = modelId.trim();

    if (!normalizedModelId) {
      throw new Error(
        `${this.type.toUpperCase()} modelId is required. Provide an explicit model ID.`,
      );
    }

    return normalizedModelId;
  }
}

export function getRuntimeEnv(name: string): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };

  return runtime.process?.env?.[name];
}

export function requireApiKey(
  provider: string,
  apiKey: string | undefined,
  environmentVariable: string,
): string {
  if (!apiKey) {
    throw new Error(
      `${environmentVariable} is required to create an ${provider} model`,
    );
  }

  return apiKey;
}
