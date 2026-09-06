#!/usr/bin/env node

import assert from "node:assert/strict";
import { AgentDockModel } from "../../../models/dist/index.js";
import { AgentDock } from "../../dist/index.js";
import {
  requireScenarioEnvironment,
  ScenarioRunner,
} from "./scenario-runner.mjs";

let executions = 0;
const runner = new ScenarioRunner({
  agent: new AgentDock({
    model: AgentDockModel.openRouter({
      model:
        process.env.AGENTDOCK_OPENROUTER_MODEL ??
        "deepseek/deepseek-v4-flash-0731",
      apiKey: requireScenarioEnvironment("OPENROUTER_API_KEY"),
      temperature: 0,
    }),
    defaults: {
      systemPrompt: "Follow the user's tool instructions exactly.",
      maxSteps: 3,
    },
  }),
  sessionId: "scenario-approval",
  colors: false,
  approve: async () => true,
  tools: [
    {
      name: "publish_report",
      description: "Publish a report after approval.",
      parameters: {
        type: "object",
        properties: { reportId: { type: "string" } },
        required: ["reportId"],
        additionalProperties: false,
      },
      requiresApproval: true,
      execute: async ({ input }) => {
        executions += 1;
        return { reportId: input.reportId, published: true };
      },
    },
  ],
});

const result = await runner.run(
  'Call publish_report exactly once with reportId "report-1", then give a short confirmation.',
  { runId: "scenario-approval-run" },
);

assert.equal(result.status, "completed");
assert.equal(executions, 1);
assert.deepEqual(result.toolResults[0].output, {
  reportId: "report-1",
  published: true,
});
runner.line("Approval scenario passed.");
