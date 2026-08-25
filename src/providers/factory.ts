import type { LanguageModel } from "ai";
import {
  createOpenRouterModel,
  type OpenRouterModelOptions,
} from "./openrouter.js";
import {
  createOllamaModel,
  type OllamaModelOptions,
} from "./ollama.js";

export type AgentModelConfig =
  | ({ provider: "openrouter" } & OpenRouterModelOptions)
  | ({ provider: "ollama" } & OllamaModelOptions);

export interface AgentModelFactoryDependencies {
  openrouter?: (options: OpenRouterModelOptions) => LanguageModel;
  ollama?: (options: OllamaModelOptions) => LanguageModel;
}

export class AgentModelFactory {
  private readonly openrouter: NonNullable<
    AgentModelFactoryDependencies["openrouter"]
  >;

  private readonly ollama: NonNullable<
    AgentModelFactoryDependencies["ollama"]
  >;

  constructor(dependencies: AgentModelFactoryDependencies = {}) {
    this.openrouter = dependencies.openrouter ?? createOpenRouterModel;
    this.ollama = dependencies.ollama ?? createOllamaModel;
  }

  create(config: AgentModelConfig): LanguageModel {
    switch (config.provider) {
      case "openrouter": {
        const { provider: _, ...options } = config;
        return this.openrouter(options);
      }
      case "ollama": {
        const { provider: _, ...options } = config;
        return this.ollama(options);
      }
      default:
        return assertNever(config);
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported model provider: ${String(value)}`);
}
