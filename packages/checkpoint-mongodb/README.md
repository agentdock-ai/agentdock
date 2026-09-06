# @agentdock/checkpoint-mongodb

MongoDB checkpoint storage for AgentDock.

```ts
import { MongoDBCheckpoint } from "@agentdock/checkpoint-mongodb";

const checkpoint = new MongoDBCheckpoint({
  connectionString: process.env.MONGODB_URL!,
  database: "agentdock",
});
```
