import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AgentModelFactory,
  AmazonBedrockModelProvider,
  AnthropicModelProvider,
  AzureModelProvider,
  GoogleModelProvider,
  OllamaModelProvider,
  OpenAIModelProvider,
  OpenRouterModelProvider,
  VercelGatewayModelProvider,
  XaiModelProvider,
} from "../../src/index.js";

test("AgentModelFactory creates a model for every supported provider", () => {
  const factory = new AgentModelFactory();
  const configurations = [
    { provider: "openrouter", modelId: "openrouter/model", apiKey: "key" },
    { provider: "ollama", modelId: "llama3.2", baseURL: "http://localhost" },
    { provider: "gateway", modelId: "openai/gpt-4.1", apiKey: "key" },
    { provider: "openai", modelId: "gpt-4.1", apiKey: "key" },
    { provider: "anthropic", modelId: "claude-sonnet", apiKey: "key" },
    { provider: "google", modelId: "gemini-2.5-pro", apiKey: "key" },
    { provider: "xai", modelId: "grok-3", apiKey: "key" },
    { provider: "azure", modelId: "deployment-name", apiKey: "key" },
    {
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-3-5-sonnet",
      region: "us-east-1",
    },
  ];

  for (const configuration of configurations) {
    assert.equal(factory.create(configuration).modelId, configuration.modelId);
  }
});

test("OllamaModelProvider creates a local model without an API call", () => {
  const model = new OllamaModelProvider().create({ modelId: "llama3.2" });

  assert.equal(model.specificationVersion, "v4");
  assert.equal(model.provider, "ollama");
  assert.equal(model.modelId, "llama3.2");
});

test("provider adapters share model ID validation", () => {
  const providers = [
    new OpenRouterModelProvider(),
    new OllamaModelProvider(),
    new VercelGatewayModelProvider(),
    new OpenAIModelProvider(),
    new AnthropicModelProvider(),
    new GoogleModelProvider(),
    new XaiModelProvider(),
    new AzureModelProvider(),
    new AmazonBedrockModelProvider(),
  ];

  for (const provider of providers) {
    assert.throws(
      () => provider.create({ modelId: "   " }),
      new RegExp(`${provider.type.toUpperCase()} modelId is required`),
    );
  }
});

test("OpenRouterModelProvider requires credentials", () => {
  const previousApiKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;

  try {
    assert.throws(
      () => new OpenRouterModelProvider().create({ modelId: "openai/gpt-4.1" }),
      /OPENROUTER_API_KEY is required/,
    );
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousApiKey;
    }
  }
});
