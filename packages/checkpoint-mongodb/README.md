# @agentdock/checkpoint-mongodb

MongoDB checkpoint storage for AgentDock.

```ts
import { MongoDBCheckpoint } from "@agentdock/checkpoint-mongodb";
import { AgentDock } from "agentdock";

const checkpoint = new MongoDBCheckpoint({
  connectionString: process.env.MONGODB_URL!,
  database: "agentdock",
});

const agent = new AgentDock({ model, checkpoint });
await agent.run(prompt, context, {
  sessionId: authorizedSessionId,
  sessionNamespace: `my-app:${authorizedTenantId}`,
});
```

`database`, `collection`, and `writesCollection` must be non-empty when provided;
the checkpoint and writes collection names must differ. AgentDock owns and closes
the adapter. The host must authorize session access and use a stable tenant namespace
when one database is shared.
