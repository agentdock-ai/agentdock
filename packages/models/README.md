# @agentdock-ai/models

Optional provider configuration resolver for [AgentDock](https://www.npmjs.com/package/@agentdock-ai/agentdock). It creates a standard LangChain `BaseChatModel`, so AgentDock stays provider-neutral.

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
