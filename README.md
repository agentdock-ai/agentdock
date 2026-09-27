<div align="center">
  <p>
    <img src="./logo.png" alt="Agentdock" width="360" />
  </p>

  <p>
    Production-oriented TypeScript infrastructure for streamed, tool-using agents.
  </p>

  <p>
    <a href="https://agentdock-ai.vercel.app"><strong>Visit the Agentdock landing page →</strong></a>
  </p>

  <p>
    <a href="https://github.com/agentdock-ai/agentdock"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-111827" /></a>
    <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" />
    <img alt="Release 0.1.0" src="https://img.shields.io/badge/release-0.1.0-6959DF" />
    <img alt="Open source" src="https://img.shields.io/badge/open--source-yes-2ea44f" />
  </p>
</div>

Agentdock gives a TypeScript application the runtime it needs to build a real agent: model calls, typed tools, approvals, sessions, persistence, streaming events, and lifecycle control.

Agentdock owns the normalized runtime and event contract. Applications choose LangChain chat models and LangGraph checkpointers directly, so provider setup and persistence stay with the application.

Create the runtime with the `AgentDock` class. This is the only AgentDock agent
construction API. `defineTool()` is a typed tool-definition helper; it does not
create another agent runtime or execution path.

## Features

- **Typed agent runtime:** create an agent with the `AgentDock` class.
- **Provider configuration:** pass a LangChain chat model from the provider integration you already use.
- **Typed tools:** define tools with Zod using `defineTool()`, validate input, report progress, and receive an abort signal.
- **Tool registry:** register, inspect, and update tools at runtime.
- **Approvals and authorization:** pause side effects for approval and check whether a user may call a tool before and during execution.
- **Streaming events:** consume one normalized event contract for text, reasoning, media, tool calls, progress, usage, interrupts, and terminal states.
- **Sessions:** continue conversations by `sessionId`, partition shared storage with `sessionNamespace`, read history, and delete sessions safely.
- **Checkpointing:** use LangGraph's in-memory saver by default or pass the saver that matches your infrastructure.
- **Context management:** opt in to conversation summarization when long sessions approach the model’s input limit.
- **Run control:** set step and timeout limits, cancel active runs, and resume approvals.
- **Framework-independent contracts:** share JSON-compatible events and run data between servers, frontends, and transports.
- **Frontend-ready output:** normalized messages and content parts are designed for React and other clients.

## Packages

| Package                   | Purpose                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `@agentdock-ai/agentdock` | Core runtime for models, tools, runs, approvals, sessions, streaming, and lifecycle.      |
| `@agentdock-ai/contracts` | Framework-independent JSON data contracts, event types, content parts, and event reducer. |

The core runtime is intentionally separate from the React package. For a ready-made chat surface, see [`agentdock-ui`](https://github.com/agentdock-ai/agentdock-ui).

## Install

For the normal application path:

```bash
npm install @agentdock-ai/agentdock @langchain/openai zod
```

Use Node.js 20 or newer for the core runtime. Install the LangChain provider integration for your model provider.

## Quick start

Set your provider key on the server, then create a model, define a tool, and run the agent:

```ts
import { AgentDock, ToolRegistry, defineTool } from "@agentdock-ai/agentdock";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const weather = defineTool({
  name: "get_weather",
  description: "Get the weather for a city.",
  input: z.object({ city: z.string() }),
  run: async ({ city }) => ({ city, forecast: "Sunny" }),
});

const registry = new ToolRegistry();
registry.register(weather);

const agent = new AgentDock({
  model: new ChatOpenAI({ model: "gpt-4.1-mini" }),
  defaults: {
    systemPrompt: "Answer clearly and use the weather tool when it helps.",
  },
  registry,
});

try {
  const result = await agent.run(
    "What is the weather in Lahore?",
    { userId: "user-123" },
    { sessionId: "session-123" },
  );

  const answer = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

  console.log(answer);
} finally {
  await agent.close();
}
```

`get_weather` is an application-defined example tool. Agentdock does not provide a weather service; replace its `run` function with your own API or business logic.

Every run has a `sessionId` and a JSON context object. Use `agent.stream()` when the application should show text and tool activity as it arrives:

```ts
const { stream, result } = await agent.stream(
  "Summarize my latest order.",
  { userId: "user-123" },
  { sessionId: "session-123" },
);

for await (const event of stream) {
  if (event.type === "message.part.delta" && event.part.type === "text") {
    process.stdout.write(event.part.text);
  }
}

console.log(await result);
```

## Durable sessions

The default checkpoint is process-local memory. Pass a LangGraph `BaseCheckpointSaver` when conversations must survive restarts or be shared across application instances:

```bash
npm install @langchain/langgraph-checkpoint-sqlite
```

```ts
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const checkpointer = SqliteSaver.fromConnString("./checkpoints.sqlite");
const agent = new AgentDock({ model, checkpointer });
// The application owns the checkpointer and closes it when shutting down.
checkpointer.db.close();
```

Authorize every run, resume, read, history, and delete request in your application. Use a stable `sessionNamespace` when multiple applications or tenants share one checkpoint store.

## Production model

Agentdock owns the application contract:

- tool definitions and validation;
- authorization and approval policy;
- normalized events and run results;
- session operations over the supplied LangGraph saver;
- cancellation, timeouts, and resource cleanup.

Your application owns provider credentials, user authentication, session access rules, saver lifecycle, infrastructure, and external side effects. Keep model keys on the server and make every side-effecting tool idempotent in the host system.

## Development

This repository is a Yarn workspace. Use Node.js 20 or newer:

```bash
yarn install
yarn ci
```

Run a single package while developing:

```bash
yarn workspace @agentdock-ai/agentdock test
yarn workspace @agentdock-ai/agentdock typecheck
yarn workspace @agentdock-ai/contracts build
```

The full workspace commands are:

```bash
yarn format:check
yarn typecheck
yarn build
yarn test
```

## Publishing

All packages are MIT licensed and designed to be usable in open-source and commercial applications. Versions are managed with Changesets:

```bash
yarn changeset
yarn version-packages
yarn release
```

The repository is currently pre-1.0, so public APIs may continue to evolve before the first stable release.

## Related projects

- [`agentdock-ui`](https://github.com/agentdock-ai/agentdock-ui): React components and hooks for displaying Agentdock event streams.

## License

MIT. Use Agentdock in open-source and commercial software. Your application remains responsible for its own providers, infrastructure, security, and dependency obligations.
