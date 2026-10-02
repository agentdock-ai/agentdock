<div align="center">
  <p>
    <img src="https://raw.githubusercontent.com/agentdock-ai/agentdock/main/logo.png" alt="Agentdock" width="300" />
  </p>

  <p>Framework-independent JSON event and message contracts.</p>

  <p>
    <a href="https://www.npmjs.com/package/@agentdock-ai/contracts"><img alt="npm version" src="https://img.shields.io/npm/v/%40agentdock-ai%2Fcontracts?label=release&color=6959DF" /></a>
    <a href="https://github.com/agentdock-ai/agentdock/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-111827" /></a>
  </p>
</div>

Use this package to share Agentdock's JSON-compatible event protocol and reducer
across the backend, UI, and transports without depending on LangChain or
LangGraph. Application session history and approval submission models stay in
the application that owns them.

## Included

- Stream event types for assistant messages, tool activity, interrupts, usage,
  and terminal run state.
- Event payload, content, and tool-call data used on the wire.
- `reduceAgentEvent()` and `reduceAgentEvents()` for rebuilding a UI snapshot.
- Strict JSON cloning and event validation helpers.

## Install

```bash
npm install @agentdock-ai/contracts
```

## Usage

```ts
import {
  AgentEventType,
  reduceAgentEvent,
  createAgentReducerState,
} from "@agentdock-ai/contracts";
import type { AgentEvent } from "@agentdock-ai/contracts";

function applyEvent(
  state: ReturnType<typeof createAgentReducerState>,
  event: AgentEvent,
) {
  if (
    event.type === AgentEventType.MessagePartDelta &&
    event.part.type === "text"
  ) {
    process.stdout.write(event.part.text);
  }
  return reduceAgentEvent(state, event);
}
```

The event protocol carries run identity and sequence metadata. Authentication,
authorization, and thread identity remain the serving application's responsibility.

## Event protocol

- Each invocation has a fresh `runId` and monotonically increasing
  `logicalSequence` starting at 1. `phaseId` and `sequence` describe a phase.
- The reducer retains messages and tool history across invocations. Start the
  next invocation after waiting or a terminal status; concurrent invocations
  must use separate reducers.
- `interrupts` contains all pending interrupts. `interrupt` is a convenience
  alias for the first. Resolution removes only the matching native ID. A later
  occurrence may reuse that ID after resolution. Optional `occurrence` records
  the native task's saved resume count. `responseSchema`, when present,
  contains the native JSON Schema for its answer.
- `run.paused` supplies pending node names for static breakpoints; a recoverable
  failure or cancellation retains waiting state.
- `usage.updated` with `messageId` is a cumulative snapshot for that message;
  the reducer replaces the previous snapshot and sums all messages in the
  invocation. `run.completed.usage` is the invocation total.
- Optional `namespace` identifies a child graph. Message and tool IDs are opaque.
- Duplicate replay is idempotent within the last 128 events of an invocation.
  Reuse with different data and older out-of-order events are rejected. Adjacent
  text and reasoning deltas are coalesced; message history remains application-owned.

Protocol v2 events are rejected. Upgrade serving and consumers together and use
`createAgentReducerState()` instead of constructing a reducer seed by hand. See
[the migration guide](https://github.com/agentdock-ai/agentdock/blob/main/MIGRATION.md).

This package contains data contracts and JSON-safe helpers; model, graph,
checkpoint, and HTTP implementations belong to the application and its chosen
frameworks.

## License

MIT. See the [repository license](https://github.com/agentdock-ai/agentdock/blob/main/LICENSE).
