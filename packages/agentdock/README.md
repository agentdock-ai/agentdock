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
  if (event.type === "message.part.delta" && event.part.type === "text")
    process.stdout.write(event.part.text);
}

console.log(await result);
```

The stream uses the canonical AgentDock event contract. Events include structured
content (`message.part.delta`), tool lifecycle events (`tool.completed` and
`tool.failed`), interrupts, terminal metadata, and stable run/session sequencing.

For new code, the simpler typed API avoids hand-written raw schemas:

```ts
import { createAgentDock, defineTool } from "agentdock";
import { z } from "zod";

const weather = defineTool({
  name: "get_weather",
  description: "Look up weather.",
  input: z.object({ city: z.string() }),
  run: async ({ city }) => ({ city, forecast: "sunny" }),
});

const dock = createAgentDock({
  model,
  instructions: "Answer clearly.",
  tools: { weather },
});
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

## Approval and resume

Set `requiresApproval: true` on a side-effecting tool. AgentDock emits
`interrupt.required` and returns a `waiting_for_approval` result. LangGraph keeps
the graph checkpoint; resume the same session after a decision.

Event sequence numbers are ordered within each returned stream. Resuming a run creates a new stream with its own sequence.

The contracts package provides the event types with session/run/phase identifiers,
logical ordering, structured content parts, generic interrupt records, usage, finish
metadata, and a deterministic reducer. Tool approval is the first implemented
interrupt kind; custom interrupt execution remains a later milestone.

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

Use a durable checkpoint adapter in production:

```ts
import { PostgresCheckpoint } from "@agentdock/checkpoint-postgres";

const dock = new AgentDock({
  model,
  checkpoint: new PostgresCheckpoint({
    connectionString: process.env.DATABASE_URL!,
  }),
});
```

Install only the optional backend package you need, for example `yarn add @agentdock/checkpoint-postgres`. The default `MemoryCheckpoint` is process-local and intended for development and tests. Raw LangGraph savers remain available through `checkpointer` for advanced integrations; AgentDock does not close those caller-owned savers.

## Core boundary

- One built-in workflow: streamed tool-calling (`dock.toolCalling`, the default).
- One execution path: `stream()`; `run()` consumes that stream.
- One state owner: the LangGraph checkpointer.
- One tool/authorization/approval path shared by every future workflow.
- No bundled model provider wrappers, custom graph engine, context-engine, UI, or plugin system.

## Lifecycle and authoring rules

`new AgentDock()` is the advanced escape hatch for raw LangChain models, checkpointers,
adapters, and middleware. `defineTool()` validates model input with Zod and infers
the `run` input type. Raw JSON Schema is supported for advanced integrations, but
ordinary model tools must use an object-root schema.

`getSession()` returns current normalized model-visible messages. Use
`getSessionHistory()` for checkpoint-by-checkpoint history and `deleteSession()` to
remove all model-visible checkpoint context. Deletion fails while the namespace/session
has an active run.

Authorization is checked before an approval interrupt and again immediately before
tool execution. A denied protected tool therefore does not create an approval prompt.
