import assert from "node:assert/strict";
import { test } from "vitest";
import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOpenRouter } from "@langchain/openrouter";
import { AgentDockModel } from "../src/index.ts";

test("creates an OpenAI chat model from explicit configuration", () => {
  const model = AgentDockModel.openAI({
    model: "gpt-5.4-mini",
    apiKey: "test-key",
    baseUrl: "https://api.example.test/v1",
    temperature: 0.2,
  });

  assert.ok(model instanceof ChatOpenAI);
  assert.equal(model.model, "gpt-5.4-mini");
  assert.equal(model.temperature, 0.2);
  assert.equal(model.clientConfig.baseURL, "https://api.example.test/v1");
});

test("creates an Ollama chat model", () => {
  const model = AgentDockModel.ollama({
    model: "llama3.3",
    baseUrl: "http://localhost:11434",
    temperature: 0,
  });

  assert.ok(model instanceof ChatOllama);
  assert.equal(model.model, "llama3.3");
  assert.equal(model.baseUrl, "http://localhost:11434");
});

test("creates an OpenRouter chat model", () => {
  const model = AgentDockModel.openRouter({
    model: "openai/gpt-5.4-mini",
    apiKey: "test-key",
  });

  assert.ok(model instanceof ChatOpenRouter);
  assert.equal(model.model, "openai/gpt-5.4-mini");
});

test("rejects invalid external model configuration", () => {
  assert.throws(
    () => AgentDockModel.openAI({ model: "" }),
    /model must be a non-empty string/,
  );
  assert.throws(
    () =>
      AgentDockModel.ollama({
        model: "llama3.3",
        baseUrl: "ftp://localhost",
      }),
    /baseUrl must be a valid HTTP\(S\) URL/,
  );
  assert.throws(
    () =>
      AgentDockModel.openRouter({
        model: "openai/gpt-5.4-mini",
        temperature: 3,
      }),
    /temperature must be a number from 0 to 2/,
  );
});
