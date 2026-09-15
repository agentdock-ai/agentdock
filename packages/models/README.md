# @agentdock-ai/models

Provider configuration API for [Agentdock](https://www.npmjs.com/package/@agentdock-ai/agentdock). Use `AgentDockModel` to configure a supported provider without importing provider classes from LangChain; Agentdock uses the configured model internally.

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
