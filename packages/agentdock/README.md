<div align="center">
  <p>
    <img src="https://raw.githubusercontent.com/agentdock-ai/agentdock/main/logo.png" alt="Agentdock" width="300" />
  </p>

  <p>Production-oriented TypeScript runtime for streamed, tool-using agents.</p>

  <p>
    <a href="https://www.npmjs.com/package/@agentdock-ai/agentdock"><img alt="npm version" src="https://img.shields.io/npm/v/%40agentdock-ai%2Fagentdock?label=release&color=6959DF" /></a>
    <a href="https://github.com/agentdock-ai/agentdock/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-111827" /></a>
    <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" />
  </p>
</div>

Agentdock gives TypeScript applications a focused runtime for model calls, typed
tools, approvals, sessions, persistence, streaming, and lifecycle control. LangChain
and LangGraph run internally; application code uses the Agentdock API.

## ✨ What you get

- **Agent runtime:** one `AgentDock` class for runs, streams, and resumes.
- **Typed tools:** validation, authorization, progress, cancellation, and approvals.
- **Durable sessions:** memory, SQLite, PostgreSQL, MongoDB, and Redis adapters.
- **Normalized events:** one frontend-friendly contract for text, tools, usage, and interrupts.
- **Safe lifecycle:** timeouts, cancellation, cleanup, and owned resource management.

## 🚀 Install

```bash
yarn add @agentdock-ai/agentdock @agentdock-ai/models zod
```

## 💻 Quick start

```ts
import { AgentDock, defineTool } from "@agentdock-ai/agentdock";
import { AgentDockModel } from "@agentdock-ai/models";
import { z } from "zod";

const weather = defineTool({
  name: "get_weather",
  description: "Get the weather for a city.",
  input: z.object({ city: z.string() }),
  run: async ({ city }) => ({ city, forecast: "Sunny" }),
});

const agent = new AgentDock({
  model: AgentDockModel.openAI({ model: "gpt-5.4-mini" }),
});

agent.registerTool(weather);

try {
  const result = await agent.run(
    "What is the weather in Lahore?",
    { userId: "user-123" },
    { sessionId: "session-123" },
  );

  console.log(result.content);
} finally {
  await agent.close();
}
```

Use `agent.stream()` when the UI should receive text and tool activity as it arrives:

```ts
const { stream, result } = await agent.stream(
  "Summarize my latest order.",
  { userId: "user-123" },
  { sessionId: "session-123" },
);

for await (const event of stream) {
  if (event.type === "message.part.delta" && event.part.type === "text") {
    process.stdout.write(event.part.text);
  }
}

console.log(await result);
```

## 🧠 Sessions and approvals

Pass a stable `sessionId` to continue a conversation. Use a durable checkpoint
adapter when sessions must survive restarts or be shared across instances:

```bash
yarn add @agentdock-ai/checkpoint-postgres
```

```ts
import { PostgresCheckpoint } from "@agentdock-ai/checkpoint-postgres";

const agent = new AgentDock({
  model,
  checkpoint: new PostgresCheckpoint({
    connectionString: process.env.DATABASE_URL!,
  }),
});
```

Set `requiresApproval: true` on a side-effecting tool. Agentdock pauses the run,
persists the interrupt, and resumes it with `agent.resume()` after approval.

## 📚 Useful APIs

| API                   | Use it for                                          |
| --------------------- | --------------------------------------------------- |
| `run()`               | Execute a prompt and receive one result.            |
| `stream()`            | Consume normalized events while a run is executing. |
| `resume()`            | Continue a paused approval run.                     |
| `getSession()`        | Read the current normalized message state.          |
| `getSessionHistory()` | Inspect checkpoint-by-checkpoint history.           |
| `deleteSession()`     | Remove a session’s checkpoint context.              |
| `close()`             | Stop active work and release owned resources.       |

## 🔗 Related packages

- [`@agentdock-ai/models`](https://www.npmjs.com/package/@agentdock-ai/models) — provider configuration.
- [`@agentdock-ai/contracts`](https://www.npmjs.com/package/@agentdock-ai/contracts) — framework-independent events and data types.
- [`@agentdock-ai/checkpoint`](https://www.npmjs.com/package/@agentdock-ai/checkpoint) — checkpoint contract and memory adapter.

## 📄 License

MIT. See the [repository license](https://github.com/agentdock-ai/agentdock/blob/main/LICENSE).
