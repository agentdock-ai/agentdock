# @agentdock/models

Optional provider configuration resolver for [AgentDock](https://www.npmjs.com/package/agentdock). It creates a standard LangChain `BaseChatModel`, so AgentDock stays provider-neutral.

## Install

```bash
yarn add agentdock @agentdock/models
```

## Usage

```ts
import { AgentDock } from "agentdock";
import { AgentDockModel } from "@agentdock/models";

const model = AgentDockModel.openAI({
  model: "gpt-5.4-mini",
  apiKey: process.env.OPENAI_API_KEY,
});

const dock = new AgentDock({ model });
```

Supported providers are `openai`, `ollama`, and `openrouter`. An omitted API key leaves the provider's normal environment-variable configuration in effect.
