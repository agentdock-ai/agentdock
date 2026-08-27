<div align="center">
  <img src="logo.png?v=50cf7f7" alt="AgentDock Logo" width="250" style="margin-bottom: 20px;"/>

  **Reusable TypeScript agent infrastructure for multi-tenant applications.**

  [![version](https://img.shields.io/badge/version-0.1.0-blue.svg?cacheSeconds=2592000)](https://github.com/Muhammad-Zain01/agentdock)
  [![TypeScript](https://img.shields.io/badge/TypeScript-7.0.2-blue.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
  [![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
</div>

<br />

This package provides a single `AgentDock` runtime for backend applications. Product-specific tools, prompts, authorization, and persistence stay in the consuming app.

Runs belong to a required `sessionId`. AgentDock loads and updates the session's
conversation messages through the injected `store`; callers do not need
to manually pass message history between runs. The default in-memory stores are
process-local and can be replaced with database-backed implementations.

## ✨ Features

- **Agent Runtime:** Run, stream, resume approvals, and cancel agent runs.
- **Typed Events:** Provider-independent events for live clients.
- **Tool Registry:** Register and manage tools per `AgentDock` instance.
- **Run State:** Inject in-memory or durable run persistence.
- **Provider Helpers:** Built-in helpers for AI SDK providers such as OpenRouter.
- **TypeScript First:** Fully typed for safe, scalable, and rapid development.

## 🚀 Setup

Install the dependencies and build the package:

```bash
yarn install
yarn build
```

## 💻 Local Development

Run the TypeScript compiler in watch mode:

```bash
yarn dev
```

## 📦 Build And Package

To perform typechecking, create a clean build, and package the artifact:

```bash
yarn typecheck
yarn build
yarn pack:artifact
```

> **Note:** `yarn pack:artifact` creates `agentdock.tgz`. The package lifecycle runs a clean build before packing, so the artifact is always created from the current source.

## 🛠️ Usage

Create one configured `AgentDock` instance for your backend application:

```ts
import {
  AgentDock,
  AgentModelFactory,
  ToolRegistry,
  InMemoryAgentStore,
} from "agentdock";

const modelFactory = new AgentModelFactory();
const sessionId = "session-123";
const agent = new AgentDock({
  model: modelFactory.create({
    provider: "openrouter",
    modelId: "your-model-id",
  }),
  registry: new ToolRegistry(),
  store: new InMemoryAgentStore(),
});

agent.registerTool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
  execute: async ({ input }) => ({ city: input.city, temperature: 22 }),
});

const result = await agent.run(
  "What is the weather in Lahore?",
  { userId: "user-123" },
  { sessionId },
);
```

For live output, consume the normalized AgentDock event stream:

```ts
import { AgentEventType } from "agentdock";

const session = await agent.stream(
  "What is the weather in Lahore?",
  { userId: "user-123" },
  { sessionId },
);

for await (const event of session.stream) {
  if (event.type === AgentEventType.TextDelta) {
    process.stdout.write(event.text);
  }
}

const result = await session.result;
```

### Provider selection

`AgentModelFactory` provides the supported model providers through one typed API.

```ts
import { AgentModelFactory } from "agentdock";

const modelFactory = new AgentModelFactory();

const model = modelFactory.create({
  provider: "ollama",
  modelId: "llama3.2",
  // Optional when Ollama is not running on the default local host.
  baseURL: "http://localhost:11434",
});
```

For OpenRouter, use `provider: "openrouter"` and provide `modelId`. The API key
can be passed explicitly or read from `OPENROUTER_API_KEY`.

The permission demo supports both providers:

```bash
AGENTDOCK_PROVIDER=ollama AGENTDOCK_MODEL=llama3.2 yarn demo:permissions
```
