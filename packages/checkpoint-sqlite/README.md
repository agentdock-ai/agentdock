<div align="center">
  <p>
    <img src="https://raw.githubusercontent.com/agentdock-ai/agentdock/main/logo.png" alt="Agentdock" width="300" />
  </p>

  <p>SQLite checkpoints for local and single-server Agentdock applications.</p>

  <p>
    <a href="https://www.npmjs.com/package/@agentdock-ai/checkpoint-sqlite"><img alt="npm version" src="https://img.shields.io/npm/v/%40agentdock-ai%2Fcheckpoint-sqlite?label=release&color=6959DF" /></a>
    <a href="https://github.com/agentdock-ai/agentdock/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-111827" /></a>
    <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" />
  </p>
</div>

SQLite is a good default for local development, desktop applications, and a single
server that needs durable sessions without running a separate database service.

## 🚀 Install

```bash
yarn add @agentdock-ai/agentdock @agentdock-ai/checkpoint-sqlite
```

## 💻 Usage

```ts
import { AgentDock } from "@agentdock-ai/agentdock";
import { SqliteCheckpoint } from "@agentdock-ai/checkpoint-sqlite";

const agent = new AgentDock({
  model,
  checkpoint: new SqliteCheckpoint({
    path: "./data/agentdock.sqlite",
  }),
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

The adapter creates the parent directory and initializes the LangGraph schema.
Agentdock closes the database through `agent.close()`. SQLite is intended for one
process or one server; use PostgreSQL, MongoDB, or Redis for shared deployments.

Use a stable `sessionNamespace` when more than one application or tenant shares a
database file.

## 📄 License

MIT. See the [repository license](https://github.com/agentdock-ai/agentdock/blob/main/LICENSE).
