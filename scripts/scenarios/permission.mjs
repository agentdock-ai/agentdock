#!/usr/bin/env node

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentDock,
  AgentModelFactory,
  InMemoryAgentStore,
  ToolRegistry,
} from "../../dist/index.js";
import { ScenarioRunner } from "./scenario-runner.mjs";

const provider = process.env.AGENTDOCK_PROVIDER ?? "ollama";
const modelId = process.env.AGENTDOCK_MODEL ?? (
  provider === "ollama"
    ? process.env.OLLAMA_MODEL ?? "llama3.2"
    : process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash"
);
const ollamaBaseURL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

if (provider !== "openrouter" && provider !== "ollama") {
  throw new Error(
    `Unsupported AGENTDOCK_PROVIDER: ${provider}. Use openrouter or ollama.`,
  );
}

const model = new AgentModelFactory().create(
  provider === "ollama"
    ? { provider, modelId, baseURL: ollamaBaseURL }
    : {
        provider,
        modelId,
        ...(process.env.OPENROUTER_API_KEY
          ? { apiKey: process.env.OPENROUTER_API_KEY }
          : {}),
      },
);
const registry = new ToolRegistry();
const store = new InMemoryAgentStore();
const sessionId = process.env.AGENTDOCK_SESSION_ID ?? "permission-demo-session";
const agent = new AgentDock({
  model,
  registry,
  store,
  defaults: {
    systemPrompt: [
      "You are the AgentDock permission-demo assistant.",
      "Use tools when appropriate and follow the user's instructions exactly.",
    ].join(" "),
    permissionMode: "normal",
    maxSteps: 3,
  },
});

const directory = await mkdtemp(join(tmpdir(), "agentdock-permission-demo-"));
const filePath = join(directory, "permission-output.txt");

registry.register({
  name: "write_file",
  description: "Write the requested text to the scenario output file.",
  requiresApproval: true,
  authorize: ({ toolCall }) => {
    const content = toolCall.input?.content;
    return typeof content === "string" && content.trim().length > 0
      ? { allowed: true }
      : { allowed: false, reason: "File content must not be empty." };
  },
  parameters: {
    type: "object",
    properties: { content: { type: "string" } },
    required: ["content"],
    additionalProperties: false,
  },
  execute: async ({ input }) => {
    await writeFile(filePath, String(input.content), "utf8");
    return { path: filePath, written: true };
  },
});

const runner = new ScenarioRunner({ agent, sessionId });
const result = await runner.run([
  "Use the write_file tool now.",
  "Write exactly this text: AgentDock permission test passed.",
  "Do not just explain; make the tool call.",
].join(" "));

runner.line(`Output file: ${filePath}`);
runner.line(`File content: ${await readFileIfPresent(filePath) ?? "(not created)"}`);

async function readFileIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
