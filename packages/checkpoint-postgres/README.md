# @agentdock/checkpoint-postgres

PostgreSQL checkpoint storage for AgentDock. Install it separately when PostgreSQL persistence is needed.

```ts
import { AgentDock } from "agentdock";
import { PostgresCheckpoint } from "@agentdock/checkpoint-postgres";

const agent = new AgentDock({
  model,
  checkpoint: new PostgresCheckpoint({
    connectionString: process.env.DATABASE_URL!,
  }),
});
```
