#!/usr/bin/env node

import assert from "node:assert/strict";
import { AgentDockModel } from "../../packages/models/dist/index.js";
import { AgentDock } from "../../dist/index.js";
import {
  requireScenarioEnvironment,
  ScenarioRunner,
} from "./scenario-runner.mjs";

const prompt = "Explain AgentDock streaming in one big paragraph.";
const runner = new ScenarioRunner({
  agent: new AgentDock({
    model: AgentDockModel.openRouter({
      model: "deepseek/deepseek-v4-flash-0731",
      apiKey: requireScenarioEnvironment("OPENROUTER_API_KEY"),
      temperature: 0,
    }),
    defaults: { maxSteps: 2 },
  }),
  sessionId: "scenario-streaming",
  colors: false,
});

const result = await runner.run(prompt, { runId: "scenario-streaming-run" });

assert.equal(result.status, "completed");
assert.ok(result.content.trim().length > 0);
runner.line("Streaming scenario passed.");
