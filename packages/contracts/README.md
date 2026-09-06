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
