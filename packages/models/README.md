<div align="center">
  <p>
    <img src="https://raw.githubusercontent.com/agentdock-ai/agentdock/main/logo.png" alt="Agentdock" width="360" />
  </p>

  <p>
    Provider helpers for Agentdock, an easy-to-use TypeScript wrapper around LangGraph.
  </p>

  <p>
    <a href="https://github.com/agentdock-ai/agentdock"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-111827" /></a>
    <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" />
    <img alt="Release 0.1.0" src="https://img.shields.io/badge/release-0.1.0-6959DF" />
  </p>
</div>

# @agentdock-ai/models

Configure OpenAI, Ollama, or OpenRouter for [Agentdock](https://www.npmjs.com/package/@agentdock-ai/agentdock) without importing provider classes from LangChain. Agentdock uses the configured model internally.

## Install

```bash
yarn add @agentdock-ai/agentdock @agentdock-ai/models
```

## Usage

```ts
import { AgentDock } from "@agentdock-ai/agentdock";
import { AgentDockModel } from "@agentdock-ai/models";

const model = AgentDockModel.openAI({
  model: "gpt-5.4-mini",
  apiKey: process.env.OPENAI_API_KEY,
});

const dock = new AgentDock({ model });
```

Supported providers are `openai`, `ollama`, and `openrouter`. An omitted API key leaves the provider's normal environment-variable configuration in effect.

Requires Node.js 22 or newer.
