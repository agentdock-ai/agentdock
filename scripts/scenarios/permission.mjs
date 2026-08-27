#!/usr/bin/env node

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScenarioRunner } from "./scenario-runner.mjs";

const directory = await mkdtemp(join(tmpdir(), "agentdock-permission-demo-"));
const filePath = join(directory, "permission-output.txt");
const expectedContent = "AgentDock permission test passed.";

const runner = new ScenarioRunner({
  sessionId: "permission-demo-session",
  systemPrompt: [
    "You are the AgentDock permission-demo assistant.",
    "Use tools when appropriate and follow the user's instructions exactly.",
  ].join(" "),
  tools: [{
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
  }],
});

const result = await runner.run([
  "Use the write_file tool now.",
  `Write exactly this text: ${expectedContent}`,
  "Do not just explain; make the tool call.",
].join(" "));

const fileContent = await readFileIfPresent(filePath);
if (result.status !== "completed") {
  throw new Error(`Permission scenario did not complete: ${result.status}`);
}
if (!result.toolCalls.some(({ name }) => name === "write_file")) {
  throw new Error("Permission scenario did not call write_file.");
}
if (fileContent !== expectedContent) {
  throw new Error("Permission scenario wrote unexpected file content.");
}

runner.line(`Output file: ${filePath}`);
runner.line(`File content: ${fileContent}`);

async function readFileIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
