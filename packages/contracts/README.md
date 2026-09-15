<div align="center">
  <p>
    <img src="https://raw.githubusercontent.com/agentdock-ai/agentdock/main/logo.png" alt="Agentdock" width="300" />
  </p>

  <p>Small, framework-independent data contracts for Agentdock applications.</p>

  <p>
    <a href="https://www.npmjs.com/package/@agentdock-ai/contracts"><img alt="npm version" src="https://img.shields.io/npm/v/%40agentdock-ai%2Fcontracts?label=release&color=6959DF" /></a>
    <a href="https://github.com/agentdock-ai/agentdock/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-111827" /></a>
    <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" />
  </p>
</div>

Use this package when a frontend, backend, or transport layer needs Agentdock’s
JSON-compatible event and run types without importing LangChain or LangGraph.

## ✨ Included

- Agent events and run results.
- Structured messages and content parts.
- Interrupt, usage, and finish metadata.
- `reduceAgentEvent()` for rebuilding a UI-safe snapshot.
- Strict JSON cloning and validation helpers.

## 🚀 Install

```bash
yarn add @agentdock-ai/contracts
```

## 💻 Usage

```ts
import type {
  AgentEvent,
  AgentRunResult,
  AgentSessionRecord,
} from "@agentdock-ai/contracts";

function render(event: AgentEvent) {
  if (event.type === "message.part.delta" && event.part.type === "text") {
    process.stdout.write(event.part.text);
  }
}
```

The package intentionally contains types and JSON-safe helpers only. Runtime
implementation types such as models, tools, and checkpoint savers belong to the
Agentdock runtime package.

## 📄 License

MIT. See the [repository license](https://github.com/agentdock-ai/agentdock/blob/main/LICENSE).
