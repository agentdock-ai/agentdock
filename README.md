<div align="center">
  <p><img src="./logo.png" alt="Agentdock" width="320" /></p>
  <p>
    <a href="https://www.npmjs.com/package/@agentdock-ai/agentdock"><img alt="npm version" src="https://img.shields.io/npm/v/%40agentdock-ai%2Fagentdock?label=npm" /></a>
    <a href="https://github.com/agentdock-ai/agentdock/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/agentdock-ai/agentdock/actions/workflows/ci.yml/badge.svg?branch=main" /></a>
    <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" />
    <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111827" /></a>
  </p>
</div>

The `Agentdock` class adapts a compiled LangGraph graph to the Agentdock event
contract and handles SSE backpressure, client disconnects, and response cleanup.
Your application owns routes and calls Agentdock from its route controllers.

For optional durable conversation threads, transcripts, and UI synchronization
on top of a configured LangGraph Store, see
[`@agentdock-ai/conversations`](./packages/conversations/README.md). The serving
package remains usable without conversation persistence.

LangGraph and LangChain own agent execution, tools, models, checkpoints,
interrupts, and resume. Your application owns request parsing, authentication,
authorization, trusted thread IDs, side effects, and checkpointer lifecycle.

## Install

```bash
npm install @agentdock-ai/agentdock @agentdock-ai/contracts \
  @langchain/langgraph langchain @langchain/openrouter zod
```

Install the LangChain provider and LangGraph checkpointer that your application
uses. LangGraph 1.4.17+ is required. Agentdock does not configure or manage either one.

## Create and serve a graph

```ts
import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenRouter } from "@langchain/openrouter";
import { createAgent } from "langchain";
import { Agentdock } from "@agentdock-ai/agentdock";

const graph = createAgent({
  model: new ChatOpenRouter({
    model: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
    apiKey: process.env.OPENROUTER_API_KEY,
  }),
  tools: [], // Use LangChain tool() to add application tools.
  checkpointer: new MemorySaver(),
  systemPrompt: "You are a helpful assistant.",
}).graph;

const runtime = new Agentdock(graph);
```

Agentdock reads native pending tasks and never writes serving metadata into graph
checkpoints. No Agentdock state schema is required. Use LangGraph or LangChain's
ordinary schema for application state.

Use `runtime.getResumeState(authorizedThreadId)` to seed a fresh client when native
interrupts or static breakpoints are pending. The seed contains every pending
interrupt, preserves native IDs and payloads, and starts with `runId: null`.
Load conversation history separately with `runtime.getMessages(threadId)`.

Each invocation gets a fresh `runId` with `logicalSequence` starting at 1. A client
can apply continuation events to its existing reducer state or a hydrated seed.
Serving and consumers use the single protocol exported by `@agentdock-ai/contracts`.

## Call Agentdock from your route controller

Your Node.js, Next.js, NestJS, or other framework owns URL routing, request
validation, authentication, and authorization. After that, pass the trusted run
to Agentdock:

```ts
await runtime.pipe(response, {
  threadId: authorizedThreadId,
  input: { messages: [{ role: "user", content: message }] },
  context: { userId: authenticatedUser.id },
});
```

To resume an interrupted graph, use the same authorized thread ID and pass the
resume value expected by the graph or middleware. Generic interruptions remain
opaque by default (`Agentdock.OPAQUE`). For LangChain tool approval UI, select
`interruptFormat: Agentdock.HITL`; this presents native HITL approvals as tool
approvals without changing native execution. The equivalent strings
(`"opaque"` and `"langchain-hitl"`) remain supported. An optional application
`validateResume` hook runs before invocation or SSE headers; native middleware
owns decision permissions:

```ts
await runtime.pipe(response, {
  threadId: authorizedThreadId,
  resume: { decisions: [{ type: "approve" }] },
  context: { userId: authenticatedUser.id },
});
```

For Node and Express-style response objects, call `runtime.pipe(response, run)`.
For Web-standard route handlers, return `runtime.toResponse(run)`. Use
`runtime.stream(run)` when your controller needs to consume events directly.
Agentdock does not define URL paths or HTTP request/response envelopes.

## Production notes

- `MemorySaver` is for local development. Use a LangGraph saver suitable for
  your deployment and create/close its resources in your application.
- Use a stable, server-derived `thread_id` for each conversation and ensure
  your application handles overlapping requests for the same thread safely.
- Pass trusted per-request data through `context`; keep secrets and authorization
  decisions in the application.
- The Agentdock event mapper observes native messages, tools, updates, tasks,
  and lifecycle callbacks. Native cache hits retain their returned messages. Arbitrary graph output remains application-specific.

See [`examples/react-agent`](./examples/react-agent/README.md) for a complete
Node server with tools and an approval interrupt.

## Development

Requires Node.js 22+ and Yarn:

```bash
yarn install
yarn typecheck
yarn build
yarn test
yarn format:check
```

MIT licensed. Package releases are managed with Changesets.
