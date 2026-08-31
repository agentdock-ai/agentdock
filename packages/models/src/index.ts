import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOpenRouter } from "@langchain/openrouter";

interface AgentDockModelSettings {
  readonly model: string;
  readonly temperature?: number;
}

export interface OpenAIModelConfig extends AgentDockModelSettings {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface OllamaModelConfig extends AgentDockModelSettings {
  readonly baseUrl?: string;
}

export interface OpenRouterModelConfig extends AgentDockModelSettings {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/**
 * Creates LangChain chat models for the providers supported by AgentDock.
 * Provider environment variables remain available when an API key is omitted.
 */
export class AgentDockModel {
  private constructor() {}

  static openRouter(config: OpenRouterModelConfig): BaseChatModel {
    validateModelConfig(config);
    assertOptionalNonEmptyString(config.apiKey, "apiKey");
    assertOptionalUrl(config.baseUrl, "baseUrl");

    return new ChatOpenRouter({
      model: config.model,
      temperature: config.temperature,
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  static openAI(config: OpenAIModelConfig): BaseChatModel {
    validateModelConfig(config);
    assertOptionalNonEmptyString(config.apiKey, "apiKey");
    assertOptionalUrl(config.baseUrl, "baseUrl");

    return new ChatOpenAI({
      model: config.model,
      temperature: config.temperature,
      apiKey: config.apiKey,
      configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined,
    });
  }

  static ollama(config: OllamaModelConfig): BaseChatModel {
    validateModelConfig(config);
    assertOptionalUrl(config.baseUrl, "baseUrl");

    return new ChatOllama({
      model: config.model,
      temperature: config.temperature,
      baseUrl: config.baseUrl,
    });
  }
}

function validateModelConfig(
  config: unknown,
): asserts config is AgentDockModelSettings {
  if (!isRecord(config)) {
    throw new Error("AgentDock model configuration must be an object.");
  }
  assertNonEmptyString(config.model, "model");
  assertOptionalTemperature(config.temperature);
}

function assertNonEmptyString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`AgentDock model ${name} must be a non-empty string.`);
  }
}

function assertOptionalNonEmptyString(value: unknown, name: string): void {
  if (value !== undefined) {
    assertNonEmptyString(value, name);
  }
}

function assertOptionalTemperature(value: unknown): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 2
  ) {
    throw new Error(
      "AgentDock model temperature must be a number from 0 to 2.",
    );
  }
}

function assertOptionalUrl(value: unknown, name: string): void {
  if (value === undefined) return;
  assertNonEmptyString(value, name);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`AgentDock model ${name} must be a valid HTTP(S) URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`AgentDock model ${name} must be a valid HTTP(S) URL.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
