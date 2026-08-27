import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AgentModelFactory,
  createOllamaModel,
  createOpenRouterModel,
} from "../../src/index.js";

const testModel = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test-model",
};

test("AgentModelFactory routes OpenRouter and Ollama configurations", () => {
  const calls = [];
  const factory = new AgentModelFactory({
    openrouter: (options) => {
      calls.push({ provider: "openrouter", options });
      return testModel;
    },
    ollama: (options) => {
      calls.push({ provider: "ollama", options });
      return testModel;
    },
  });

  assert.equal(
    factory.create({
      provider: "openrouter",
      modelId: "openrouter/model",
      apiKey: "test-key",
    }),
    testModel,
  );
  assert.equal(
    factory.create({
      provider: "ollama",
      modelId: "llama3.2",
      baseURL: "http://localhost:11434",
    }),
    testModel,
  );

  assert.deepEqual(calls, [
    {
      provider: "openrouter",
      options: { modelId: "openrouter/model", apiKey: "test-key" },
    },
    {
      provider: "ollama",
      options: { modelId: "llama3.2", baseURL: "http://localhost:11434" },
    },
  ]);
});

test("createOllamaModel creates a local model without an API call", () => {
  const model = createOllamaModel({ modelId: "llama3.2" });

  assert.equal(model.specificationVersion, "v4");
  assert.equal(model.provider, "ollama");
  assert.equal(model.modelId, "llama3.2");
});

test("provider helpers reject blank model IDs", () => {
  assert.throws(
    () => createOllamaModel({ modelId: "   " }),
    /OLLAMA modelId is required/,
  );
  assert.throws(
    () => createOpenRouterModel({ modelId: "   ", apiKey: "test-key" }),
    /OPENROUTER modelId is required/,
  );
});
