# @agentdock-ai/contracts

Framework-independent AgentDock contracts shared by backend runtimes, frontends, and future transport packages.

This package contains JSON-compatible public data types only. It does not depend on LangChain, LangGraph, Node.js runtime APIs, or database adapters.

```ts
import type {
  AgentEvent,
  AgentRunResult,
  AgentSessionRecord,
} from "@agentdock-ai/contracts";
```

Runtime implementation types such as `BaseChatModel`, `BaseCheckpointSaver`, tool functions, and LangGraph workflow state remain in the `agentdock` package.

The event contract provides structured content parts, explicit lifecycle events,
generic interrupt records, usage and finish metadata, and `reduceAgentEvent()` for
rebuilding a UI-safe snapshot. The reducer rejects out-of-order events and ignores
exact duplicate event IDs so reconnects are deterministic; reusing an ID with
different data is rejected. Every event carries the numeric
`AGENT_EVENT_PROTOCOL_VERSION` and consumers must reject unsupported versions.

The lifecycle event names are `run.started`, `message.started`,
`message.part.delta`, `message.completed`, `tool.called`, `tool.progress`,
`tool.completed`, `tool.failed`, `interrupt.required`, `interrupt.resolved`,
`usage.updated`, `run.completed`, `run.failed`, and `run.cancelled`. The reducer
tracks multiple assistant messages, tool progress/results/errors, the current
interrupt, usage, limits, and terminal metadata. A delta requires a started
message; tool results require a known tool call; events after a terminal event are
rejected.

All public contract values are strict JSON. `cloneJsonValue()` and
`cloneJsonObject()` reject cycles, `undefined`, functions, symbols, `BigInt`,
`Date`, `Map`, `Set`, and non-finite numbers.

Normalized `Message.content` and `AgentRunResult.content` use the same
`ContentPart[]` contract. Tool calls and tool results are content parts rather than a
second message-specific representation. Media parts identify exactly one source:
`url`, base64 `data`, or `fileId`.

`cloneJsonSchema()` accepts a JSON Schema object or boolean. AgentDock’s ordinary
model-tool boundary requires an object-root schema; the supported raw subset is
documented in the `agentdock` package.
