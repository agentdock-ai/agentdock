#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentDock,
  AgentModelFactory,
  InMemoryAgentStore,
  ToolRegistry,
} from "../dist/index.js";

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

const modelConfig = provider === "ollama"
  ? {
      provider: "ollama",
      modelId,
      baseURL: ollamaBaseURL,
    }
  : {
      provider: "openrouter",
      modelId,
      ...(process.env.OPENROUTER_API_KEY
        ? { apiKey: process.env.OPENROUTER_API_KEY }
        : {}),
    };

const model = new AgentModelFactory().create(modelConfig);
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
      "Use tools when they are appropriate and follow the user's instructions exactly.",
    ].join(" "),
    permissionMode: "normal",
    maxSteps: 3,
  },
});
const context = {};
const directory = await mkdtemp(join(tmpdir(), "agentdock-permission-demo-"));
const filePath = join(directory, "dummy.txt");

registry.register({
  name: "write_dummy_file",
  description: "Write the requested text to the demo dummy file.",
  requiresApproval: true,
  authorize: ({ toolCall }) => {
    const content = toolCall.input?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      return {
        allowed: false,
        reason: "File content must not be empty.",
      };
    }

    return { allowed: true };
  },
  parameters: {
    type: "object",
    properties: {
      content: { type: "string" },
    },
    required: ["content"],
    additionalProperties: false,
  },
  execute: async ({ input: toolInput }) => {
    await writeFile(filePath, String(toolInput.content), "utf8");
    return { path: filePath, written: true };
  },
});

const prompt = [
  "Use the write_dummy_file tool now.",
  `Write exactly this text: AgentDock permission test passed.`,
  "Do not just explain; make the tool call.",
].join(" ");

let result = await consume(
  await agent.stream(prompt, context, { sessionId }),
);
let approvalRounds = 0;

while (result.status === "waiting_for_approval") {
  approvalRounds += 1;
  if (approvalRounds > 5) {
    throw new Error("Permission demo exceeded 5 approval rounds.");
  }

  const readline = createInterface({ input, output });
  const approvals = [];

  for (const request of result.approvalRequests) {
    const answer = await readline.question(
      `Allow ${request.toolCall.name}? [y/n] `,
    );
    const approved = /^(y|yes)$/i.test(answer.trim());

    approvals.push({
      approvalId: request.approvalId,
      approved,
      ...(approved ? {} : { reason: "Denied manually" }),
    });
  }

  readline.close();

  result = await consume(
    await agent.resumeStream(
      {
        runId: result.runId,
        approvals,
      },
      context,
      { sessionId },
    ),
  );
}

console.log("\nFinal result:");
console.dir(
  {
    runId: result.runId,
    status: result.status,
    content: result.content,
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
    approvalRequests: result.approvalRequests,
    sessionId,
    filePath,
    fileContent: await readFileIfPresent(filePath),
  },
  { depth: null },
);

async function consume(session) {
  for await (const part of session.stream) {
    if (part.type === "text.delta") process.stdout.write(part.text);
  }
  return session.result;
}

async function readFileIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
