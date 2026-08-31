#!/usr/bin/env node

import assert from "node:assert/strict";
import { AgentDockModel } from "../../packages/models/dist/index.js";
import { AgentDock } from "../../dist/index.js";
import {
  requireScenarioEnvironment,
  ScenarioRunner,
} from "./scenario-runner.mjs";

let receivedInput;
const runner = new ScenarioRunner({
  agent: new AgentDock({
    model: AgentDockModel.openRouter({
      model: "deepseek/deepseek-v4-flash-0731",
      apiKey: requireScenarioEnvironment("OPENROUTER_API_KEY"),
      temperature: 0,
    }),
    defaults: {
      systemPrompt: "Follow the user's tool instructions exactly.",
      maxSteps: 3,
    },
  }),
  sessionId: "scenario-tool-call",
  colors: false,
  tools: [
    {
      name: "get_weather",
      description: "Return a deterministic weather result.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
      execute: async ({ input }) => {
        receivedInput = input;
        return { city: input.city, forecast: "sunny" };
      },
    },
  ],
});

const result = await runner.run(
  'Call get_weather exactly once with city "Lahore", then give a short answer.',
  { runId: "scenario-tool-call-run" },
);

assert.equal(result.status, "completed");
assert.deepEqual(receivedInput, { city: "Lahore" });
assert.deepEqual(result.toolResults[0].output, {
  city: "Lahore",
  forecast: "sunny",
});
runner.line("Tool-call scenario passed.");
