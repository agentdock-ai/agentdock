<div align="center">
  <p>
    <img src="https://raw.githubusercontent.com/agentdock-ai/agentdock/main/logo.png" alt="Agentdock" width="300" />
  </p>

  <p>Shared checkpoint contract and in-memory adapter for Agentdock.</p>

  <p>
    <a href="https://www.npmjs.com/package/@agentdock-ai/checkpoint"><img alt="npm version" src="https://img.shields.io/npm/v/%40agentdock-ai%2Fcheckpoint?label=release&color=6959DF" /></a>
    <a href="https://github.com/agentdock-ai/agentdock/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-111827" /></a>
    <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" />
  </p>
</div>

This package is the small foundation shared by Agentdock checkpoint backends. It
contains the adapter contract, lifecycle manager, and process-local `MemoryCheckpoint`.

## ✨ Included

- **`CheckpointAdapter`** — common `saver`, `initialize()`, and `close()` contract.
- **`MemoryCheckpoint`** — fast, process-local storage for development and tests.
- **`CheckpointManager`** — selects the adapter and owns its lifecycle.

## 🚀 Install

```bash
yarn add @agentdock-ai/agentdock @agentdock-ai/checkpoint
```

## 💻 Usage

```ts
import { AgentDock } from "@agentdock-ai/agentdock";
import { MemoryCheckpoint } from "@agentdock-ai/checkpoint";

const agent = new AgentDock({
  model,
  checkpoint: new MemoryCheckpoint(),
});

try {
  await agent.run(
    "Hello",
    { userId: "user-123" },
    { sessionId: "session-123" },
  );
} finally {
  await agent.close();
}
```

## 🗄️ Choose durable storage

Install only the backend you need:

| Package                                                                                  | Best for                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------ |
| [`checkpoint-sqlite`](https://www.npmjs.com/package/@agentdock-ai/checkpoint-sqlite)     | Local applications and one server.   |
| [`checkpoint-postgres`](https://www.npmjs.com/package/@agentdock-ai/checkpoint-postgres) | Shared production deployments.       |
| [`checkpoint-mongodb`](https://www.npmjs.com/package/@agentdock-ai/checkpoint-mongodb)   | MongoDB-based applications.          |
| [`checkpoint-redis`](https://www.npmjs.com/package/@agentdock-ai/checkpoint-redis)       | Redis Stack and TTL-based retention. |

Pass an adapter instance through `checkpoint`. A raw LangGraph `checkpointer` is
also supported by Agentdock as an advanced, caller-owned escape hatch.

## 📄 License

MIT. See the [repository license](https://github.com/agentdock-ai/agentdock/blob/main/LICENSE).
