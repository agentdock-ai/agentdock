# @agentdock/contracts

Framework-independent AgentDock contracts shared by backend runtimes, frontends, and future transport packages.

This package contains JSON-compatible public data types only. It does not depend on LangChain, LangGraph, Node.js runtime APIs, or database adapters.

```ts
import type {
  AgentEvent,
  AgentRunResult,
  AgentSessionRecord,
} from "@agentdock/contracts";
```

Runtime implementation types such as `BaseChatModel`, `BaseCheckpointSaver`, tool functions, and LangGraph workflow state remain in the `agentdock` package.

The event contract provides structured content parts, explicit lifecycle events,
generic interrupt records, usage and finish metadata, and `reduceAgentEvent()` for
rebuilding a UI-safe snapshot. The reducer rejects out-of-order events and ignores
duplicate event IDs so reconnects are deterministic.

All public contract values are strict JSON. `cloneJsonValue()` and
`cloneJsonObject()` reject cycles, `undefined`, functions, symbols, `BigInt`,
`Date`, `Map`, `Set`, and non-finite numbers.
