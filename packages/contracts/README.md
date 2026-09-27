<div align="center">
  <p>
    <img src="https://raw.githubusercontent.com/agentdock-ai/agentdock/main/logo.png" alt="AgentDock" width="300" />
  </p>

  <p>Framework-independent JSON event and message contracts.</p>

  <p>
    <a href="https://www.npmjs.com/package/@agentdock-ai/contracts"><img alt="npm version" src="https://img.shields.io/npm/v/%40agentdock-ai%2Fcontracts?label=release&color=6959DF" /></a>
    <a href="https://github.com/agentdock-ai/agentdock/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-111827" /></a>
  </p>
</div>

Use this package to share AgentDock's JSON-compatible events and reducer across
the backend, UI, and transports without depending on LangChain or LangGraph.

## Included

- Stream event types for assistant messages, tool activity, interrupts, usage,
  and terminal run state.
- Message, content, tool-call, and approval data types.
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

The event `sessionId` field is retained for compatibility with existing UI
consumers. A serving backend should put its authorized thread identity there and
keep authentication and authorization in the application.

This package contains data contracts and JSON-safe helpers; model, graph,
checkpoint, and HTTP implementations belong to the application and its chosen
frameworks.

## License

MIT. See the [repository license](https://github.com/agentdock-ai/agentdock/blob/main/LICENSE).
