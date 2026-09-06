# @agentdock/checkpoint-redis

Redis checkpoint storage for AgentDock.

```ts
import { RedisCheckpoint } from "@agentdock/checkpoint-redis";

const checkpoint = new RedisCheckpoint({ url: process.env.REDIS_URL! });
```
