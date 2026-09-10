# @agentdock/checkpoint-redis

Redis checkpoint storage for AgentDock.

`RedisCheckpoint` uses LangGraph’s Redis saver, which requires Redis Stack with the
JSON and Search modules. Use `redis/redis-stack-server` in development and CI,
not a plain Redis server.

```ts
import { RedisCheckpoint } from "@agentdock/checkpoint-redis";

const checkpoint = new RedisCheckpoint({
  url: process.env.REDIS_URL!,
});

const agent = new AgentDock({ model, checkpoint });
await agent.initialize();
await agent.run(prompt, context, {
  sessionId: authorizedSessionId,
  sessionNamespace: `my-app:${authorizedTenantId}`,
});
```

The adapter owns its Redis client when passed as `checkpoint`, supports idempotent
initialization/close, and preserves approval checkpoints and tool history across
AgentDock recreation.

`ttl.defaultTTL` is a positive duration in minutes; `refreshOnRead` controls whether
reads extend it. The host must authorize every session operation and use a stable
application/tenant namespace when Redis is shared. Passing a raw `checkpointer`
instead keeps lifecycle ownership with the caller.
