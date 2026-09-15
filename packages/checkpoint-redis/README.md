<div align="center">
  <p>
    <img src="https://raw.githubusercontent.com/agentdock-ai/agentdock/main/logo.png" alt="Agentdock" width="300" />
  </p>

  <p>Redis Stack checkpoints for fast, shared Agentdock sessions.</p>

  <p>
    <a href="https://www.npmjs.com/package/@agentdock-ai/checkpoint-redis"><img alt="npm version" src="https://img.shields.io/npm/v/%40agentdock-ai%2Fcheckpoint-redis?label=release&color=6959DF" /></a>
    <a href="https://github.com/agentdock-ai/agentdock/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-111827" /></a>
    <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" />
  </p>
</div>

Use this adapter when sessions need shared Redis storage, fast access, or optional
TTL-based retention.

## ⚠️ Redis Stack required

LangGraph’s Redis saver requires Redis Stack with the JSON and Search modules. Use
`redis/redis-stack-server` in development and CI; a plain Redis server is not enough.

## 🚀 Install

```bash
yarn add @agentdock-ai/agentdock @agentdock-ai/checkpoint-redis
```

## 💻 Usage

```ts
import { AgentDock } from "@agentdock-ai/agentdock";
import { RedisCheckpoint } from "@agentdock-ai/checkpoint-redis";

const agent = new AgentDock({
  model,
  checkpoint: new RedisCheckpoint({
    url: process.env.REDIS_URL!,
    ttl: {
      defaultTTL: 60 * 24 * 7, // minutes
      refreshOnRead: true,
    },
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

Agentdock owns the Redis client, initializes the saver lazily, and closes it through
`agent.close()`. A raw LangGraph saver remains caller-owned when passed through the
advanced `checkpointer` option.

Use a stable `sessionNamespace` and authorize every session operation in the host
application when Redis is shared across tenants.

## 📄 License

MIT. See the [repository license](https://github.com/agentdock-ai/agentdock/blob/main/LICENSE).
