# @agentdock/checkpoint

Shared checkpoint lifecycle contract and in-memory implementation for AgentDock.

```ts
import { AgentDock } from "agentdock";
import { MemoryCheckpoint } from "@agentdock/checkpoint";

const agent = new AgentDock({
  model,
  checkpoint: new MemoryCheckpoint(),
});
```

Install a backend package such as `@agentdock/checkpoint-postgres` when durable storage is required.
