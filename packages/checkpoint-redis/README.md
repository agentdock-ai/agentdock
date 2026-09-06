# @agentdock/checkpoint-redis

Redis checkpoint storage for AgentDock.

```ts
import { RedisCheckpoint } from "@agentdock/checkpoint-redis";

const checkpoint = await RedisCheckpoint.create({
  url: process.env.REDIS_URL!,
});
```
