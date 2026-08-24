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

## ✨ Features

- **Agent Runtime:** Run, stream, resume approvals, and cancel agent runs.
- **Tool Registry:** Register and manage tools per `AgentDock` instance.
- **Run Store:** Inject in-memory or durable run persistence.
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
  ToolRegistry,
  InMemoryAgentRunStore,
  createOpenRouterModel,
} from "agentdock";

const agent = new AgentDock({
  model: createOpenRouterModel({ modelId: "your-model-id" }),
  registry: new ToolRegistry(),
  runStore: new InMemoryAgentRunStore(),
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

const result = await agent.run("What is the weather in Lahore?", {
  userId: "user-123",
});
```
