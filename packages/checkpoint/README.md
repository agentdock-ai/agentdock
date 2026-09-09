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

Adapters own their resources only when passed through `checkpoint`. A raw
`checkpointer` is caller-owned and is never closed by AgentDock. Every adapter must
support idempotent initialization and close, restart persistence, pending approval
resume, tool-message serialization, deletion through `deleteThread()`, and cleanup
after failures. PostgreSQL, MongoDB, and Redis service-backed tests are optional CI
integration jobs; local unit tests do not require those services.
