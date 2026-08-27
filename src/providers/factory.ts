import type { LanguageModel } from "ai";
import type { ModelProvider } from "./base.js";
import {
  AmazonBedrockModelProvider,
  type AmazonBedrockModelOptions,
} from "./bedrock.js";
import {
  AnthropicModelProvider,
  type AnthropicModelOptions,
} from "./anthropic.js";
import {
  AzureModelProvider,
  type AzureModelOptions,
} from "./azure.js";
import {
  VercelGatewayModelProvider,
  type VercelGatewayModelOptions,
} from "./gateway.js";
import {
  GoogleModelProvider,
  type GoogleModelOptions,
} from "./google.js";
import {
  OllamaModelProvider,
  type OllamaModelOptions,
} from "./ollama.js";
import {
  OpenAIModelProvider,
  type OpenAIModelOptions,
} from "./openai.js";
import {
  OpenRouterModelProvider,
  type OpenRouterModelOptions,
} from "./openrouter.js";
import { XaiModelProvider, type XaiModelOptions } from "./xai.js";

interface AgentModelOptionsByProvider {
  openrouter: OpenRouterModelOptions;
  ollama: OllamaModelOptions;
  gateway: VercelGatewayModelOptions;
  openai: OpenAIModelOptions;
  anthropic: AnthropicModelOptions;
  google: GoogleModelOptions;
  xai: XaiModelOptions;
  azure: AzureModelOptions;
  "amazon-bedrock": AmazonBedrockModelOptions;
}

type AgentModelProviderName = keyof AgentModelOptionsByProvider;

export type AgentModelConfig = {
  [Provider in AgentModelProviderName]: {
    provider: Provider;
  } & AgentModelOptionsByProvider[Provider];
}[AgentModelProviderName];

type AgentModelProviders = {
  [Provider in AgentModelProviderName]: ModelProvider<
    AgentModelOptionsByProvider[Provider]
  >;
};

export class AgentModelFactory {
  private readonly providers = {
    openrouter: new OpenRouterModelProvider(),
    ollama: new OllamaModelProvider(),
    gateway: new VercelGatewayModelProvider(),
    openai: new OpenAIModelProvider(),
    anthropic: new AnthropicModelProvider(),
    google: new GoogleModelProvider(),
    xai: new XaiModelProvider(),
    azure: new AzureModelProvider(),
    "amazon-bedrock": new AmazonBedrockModelProvider(),
  } satisfies AgentModelProviders;

  create<Provider extends AgentModelProviderName>(
    config: { provider: Provider } & AgentModelOptionsByProvider[Provider],
  ): LanguageModel {
    const { provider, ...options } = config;
    return this.providers[provider].create(options);
  }
}
