import { ChatOpenRouter } from "@langchain/openrouter";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware } from "langchain";
import { agentEventStateSchema, Agentdock } from "@agentdock-ai/agentdock";
import { contextSchema, getWeather, sendEmail } from "./tools.js";

const model = new ChatOpenRouter({
  model: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
  apiKey: process.env.OPENROUTER_API_KEY,
});

export const graph = createAgent({
  model,
  tools: [getWeather, sendEmail],
  contextSchema,
  stateSchema: agentEventStateSchema,
  checkpointer: new MemorySaver(),
  systemPrompt:
    "You are a helpful assistant. Use get_weather for weather questions. " +
    "Ask before sending an email; send_email requires user approval.",
  middleware: [humanInTheLoopMiddleware({ interruptOn: { send_email: true } })],
});

export const runtime = new Agentdock(graph);
