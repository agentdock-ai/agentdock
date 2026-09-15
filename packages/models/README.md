<div align="center">
  <p>
    <img src="https://raw.githubusercontent.com/agentdock-ai/agentdock/main/logo.png" alt="Agentdock" width="300" />
  </p>

  <p>Simple provider configuration for Agentdock models.</p>

  <p>
    <a href="https://www.npmjs.com/package/@agentdock-ai/models"><img alt="npm version" src="https://img.shields.io/npm/v/%40agentdock-ai%2Fmodels?label=release&color=6959DF" /></a>
    <a href="https://github.com/agentdock-ai/agentdock/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-111827" /></a>
    <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" />
  </p>
</div>

`@agentdock-ai/models` keeps provider-specific setup behind one small API. Agentdock
uses the configured LangChain model internally, so application code does not need
to import provider classes directly.

## ✨ Providers

- **OpenAI** — hosted OpenAI chat models.
- **Ollama** — local Ollama models.
- **OpenRouter** — OpenRouter model catalog.

## 🚀 Install

```bash
yarn add @agentdock-ai/agentdock @agentdock-ai/models
```

Requires Node.js 22 or newer.

## 💻 Usage

```ts
import { AgentDock } from "@agentdock-ai/agentdock";
import { AgentDockModel } from "@agentdock-ai/models";

const model = AgentDockModel.openAI({
  model: "gpt-5.4-mini",
  apiKey: process.env.OPENAI_API_KEY,
});

const agent = new AgentDock({ model });
```

Provider keys can be passed explicitly or loaded from the provider’s normal
environment variable. Keep credentials on the server.

## 📄 License

MIT. See the [repository license](https://github.com/agentdock-ai/agentdock/blob/main/LICENSE).
