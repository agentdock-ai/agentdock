# AgentDock

AgentDock is a small TypeScript facade for a streamed LangChain tool-calling agent running on LangGraph.

It owns the application contract: tool registration, approval policy, normalized events, run lifecycle, and a small public API. LangChain owns models and tools; LangGraph owns the tool-calling loop, checkpoints, interrupts, and resume.

## Install

```bash
yarn add agentdock @langchain/openai
```

Applications install the LangChain provider they need and pass a configured chat model to AgentDock.

## Usage

```ts
import { ChatOpenAI } from "@langchain/openai";
import { AgentDock } from "agentdock";

const dock = new AgentDock({
  model: new ChatOpenAI({ model: "gpt-5.4-mini" }),
  defaults: {
    systemPrompt: "Answer clearly and use tools when they help.",
    maxSteps: 4,
  },
});

dock.registerTool({
  name: "get_weather",
  description: "Look up the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
  execute: async ({ input }) => ({ city: input.city, forecast: "sunny" }),
});

const { stream, result } = await dock.stream(
  "What is the weather in Lahore?",
  { userId: "user-123" },
  { sessionId: "session-123" },
);

for await (const event of stream) {
  if (event.type === "text.delta") process.stdout.write(event.text);
}

console.log(await result);
```

## Optional provider resolver

`@agentdock/models` is a separate package for applications that prefer a small provider configuration object over importing LangChain provider classes directly. It returns the same `BaseChatModel`; it does not change AgentDock's workflow behavior.

```ts
import { AgentDock } from "agentdock";
import { AgentDockModel } from "@agentdock/models";

const dock = new AgentDock({
  model: AgentDockModel.openAI({
    model: "gpt-5.4-mini",
    apiKey: process.env.OPENAI_API_KEY,
  }),
});
```

The optional resolver initially supports `openai`, `ollama`, and `openrouter`; applications that need a provider outside that set can continue to pass any LangChain `BaseChatModel` directly.

### OpenRouter scenarios

All scenarios use OpenRouter with `deepseek/deepseek-v4-flash-0731` by default. They exercise real streaming, tool calling, approval, and resume. They are separate from `yarn test` because they use your account and incur provider usage.

```bash
yarn install
yarn install:models
export OPENROUTER_API_KEY="your-key"
yarn test:scenarios
```

Override the model without changing source code when needed:

```bash
AGENTDOCK_OPENROUTER_MODEL="provider/model" yarn test:scenarios
```

## Approval and resume

Set `requiresApproval: true` on a side-effecting tool. AgentDock emits `approval.required` and returns a `waiting_for_approval` result. LangGraph keeps the graph checkpoint; resume the same session after a decision.

```ts
const waiting = await dock.run("Publish the report.", context, {
  sessionId: "session-123",
  runId: "run-publish",
});

const completed = await dock.resume(
  {
    runId: waiting.runId,
    approvals: waiting.approvalRequests.map((request) => ({
      approvalId: request.approvalId,
      approved: true,
    })),
  },
  context,
  { sessionId: "session-123" },
);
```

Use a durable LangGraph checkpointer in production:

```ts
const dock = new AgentDock({
  model,
  checkpointer: productionCheckpointer,
});
```

The default `MemorySaver` is process-local and intended for development and tests.

## V1 boundary

- One built-in workflow: streamed tool-calling (`workflow: "tool-calling"`, the default).
- One execution path: `stream()`; `run()` consumes that stream.
- Custom workflows use the same `AgentWorkflow` and `AgentEvent` contracts.
- One state owner: the LangGraph checkpointer.
- One tool/authorization/approval path shared by every future workflow.
- No bundled model provider wrappers, custom graph engine, context-engine, UI, or plugin system.
