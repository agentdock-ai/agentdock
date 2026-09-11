# @agentdock-ai/checkpoint-postgres

PostgreSQL checkpoint storage for AgentDock. Install it separately when PostgreSQL persistence is needed.

```ts
import { AgentDock } from "agentdock";
import { PostgresCheckpoint } from "@agentdock-ai/checkpoint-postgres";

const agent = new AgentDock({
  model,
  checkpoint: new PostgresCheckpoint({
    connectionString: process.env.DATABASE_URL!,
  }),
});

await agent.run(prompt, context, {
  sessionId: authorizedSessionId,
  sessionNamespace: `my-app:${authorizedTenantId}`,
});
```

Passing the adapter as `checkpoint` transfers lifecycle ownership to AgentDock; it
is initialized lazily and closed by `agent.close()`. The host must authorize the
session ID before every run, resume, read, history, or delete call. Use a stable
application/tenant `sessionNamespace` whenever storage is shared.
