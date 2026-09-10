# @agentdock/checkpoint-sqlite

SQLite checkpoint storage for local AgentDock applications.

```ts
import { SqliteCheckpoint } from "@agentdock/checkpoint-sqlite";
import { AgentDock } from "agentdock";

const checkpoint = new SqliteCheckpoint({ path: "./data/agentdock.sqlite" });
const agent = new AgentDock({ model, checkpoint });
await agent.run(prompt, context, {
  sessionId: authorizedSessionId,
  sessionNamespace: `my-app:${authorizedTenantId}`,
});
```

AgentDock owns and closes an adapter passed as `checkpoint`. The host still owns
session authorization: never trust a client-provided session ID without checking
access, and use a stable application/tenant namespace when a file is shared.
