<div align="center">
  <p>
    <img src="https://raw.githubusercontent.com/agentdock-ai/agentdock/main/logo.png" alt="Agentdock" width="300" />
  </p>

  <p>PostgreSQL checkpoints for durable Agentdock sessions.</p>

  <p>
    <a href="https://www.npmjs.com/package/@agentdock-ai/checkpoint-postgres"><img alt="npm version" src="https://img.shields.io/npm/v/%40agentdock-ai%2Fcheckpoint-postgres?label=release&color=6959DF" /></a>
    <a href="https://github.com/agentdock-ai/agentdock/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-111827" /></a>
    <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" />
  </p>
</div>

Use this adapter when multiple processes or application instances need to share
LangGraph checkpoints through PostgreSQL.

## 🚀 Install

```bash
yarn add @agentdock-ai/agentdock @agentdock-ai/checkpoint-postgres
```

## 💻 Usage

```ts
import { AgentDock } from "@agentdock-ai/agentdock";
import { PostgresCheckpoint } from "@agentdock-ai/checkpoint-postgres";

const agent = new AgentDock({
  model,
  checkpoint: new PostgresCheckpoint({
    connectionString: process.env.DATABASE_URL!,
    schema: "agentdock", // optional
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

Agentdock initializes the LangGraph tables when the adapter is first used and
closes the PostgreSQL resource through `agent.close()`. The adapter preserves
messages, tool calls, approval interrupts, and workflow recovery state.

Use a stable `sessionNamespace` and authorize every session operation in the host
application when a database is shared across tenants.

## 📄 License

MIT. See the [repository license](https://github.com/agentdock-ai/agentdock/blob/main/LICENSE).
