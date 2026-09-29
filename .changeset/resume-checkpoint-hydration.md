---
"@agentdock-ai/agentdock": minor
"@agentdock-ai/contracts": minor
"@agentdock-ai/agentdock-http": minor
---

Persist complete pending interrupts in the `agentEventState` checkpoint field,
drop legacy checkpoint and event fields, require the core `Agentdock` instance
when creating an HTTP server, and use UUID-based fallback IDs.
