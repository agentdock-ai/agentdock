# @agentdock-ai/checkpoint

Shared checkpoint lifecycle contract and in-memory implementation for AgentDock.

```ts
import { AgentDock } from "@agentdock-ai/agentdock";
import { MemoryCheckpoint } from "@agentdock-ai/checkpoint";

const agent = new AgentDock({
  model,
  checkpoint: new MemoryCheckpoint(),
});
```

Install a backend package such as `@agentdock-ai/checkpoint-postgres` when durable storage is required.

Adapters own their resources only when passed through `checkpoint`. A raw
`checkpointer` is caller-owned and is never closed by AgentDock. Every adapter must
support idempotent initialization and close, restart persistence, pending approval
resume, tool-message serialization, deletion through `deleteThread()`, and cleanup
after failures. SQLite is covered by the normal local integration suite. PostgreSQL,
MongoDB, and Redis Stack run in the service-backed CI integration job; local unit
tests do not require those services.

The host application must authorize a session before every run, resume, read,
history, or delete operation. Use `sessionNamespace` to partition a shared saver by
application and tenant; context metadata does not enforce ownership. Passing an
adapter as `checkpoint` gives AgentDock lifecycle ownership, while a raw
`checkpointer` always remains caller-owned.
