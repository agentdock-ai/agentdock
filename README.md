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
The optional `@agentdock-ai/agentdock-http` package adds HTTP routes and a Node
bridge.

LangGraph and LangChain own agent execution, tools, models, checkpoints,
interrupts, and resume. Your application owns request parsing, authentication,
authorization, trusted thread IDs, side effects, and checkpointer lifecycle.

## Install

```bash
npm install @agentdock-ai/agentdock @agentdock-ai/contracts \
  @langchain/langgraph langchain @langchain/openrouter zod
npm install @agentdock-ai/agentdock-http
```

Install the LangChain provider and LangGraph checkpointer that your application
uses. Agentdock does not configure or manage either one.

## Create and serve a graph

```ts
import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenRouter } from "@langchain/openrouter";
import { createAgent } from "langchain";
import { withAgentEventState, Agentdock } from "@agentdock-ai/agentdock";

const graph = createAgent({
  model: new ChatOpenRouter({
    model: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
    apiKey: process.env.OPENROUTER_API_KEY,
  }),
  tools: [], // Use LangChain tool() to add application tools.
  stateSchema: withAgentEventState({}),
  checkpointer: new MemorySaver(),
  systemPrompt: "You are a helpful assistant.",
});

const runtime = new Agentdock(graph);
```

`withAgentEventState(fields)` adds the required `agentEventState` checkpoint
field to your graph schema. It preserves Agentdock's run identity, sequence,
and full pending interrupt across requests; LangGraph's checkpointer and
`thread_id` still control graph execution and resumption.

Use `withAgentEventState(fields)` to include application state, and use
`getResumeState(threadId)` to seed a fresh client from a checkpoint:

```ts
import { Agentdock, withAgentEventState } from "@agentdock-ai/agentdock";
import { z } from "zod";

const stateSchema = withAgentEventState({ note: z.string().default("") });
const agent = new Agentdock(graph);
const resumeState = await agent.getResumeState(authorizedThreadId);
```

`getResumeState(threadId)` returns `null` when a checkpoint cannot seed a fresh
client. A ready result requires a complete, validated pending interrupt.
Hydration restores control state; load conversation history separately.
Generated fallback message and tool-call IDs are UUID-based opaque identifiers.

## Connect your HTTP route

Parse and validate the request, authenticate the caller, and derive an
authorized thread ID in your application before calling `pipe()`:

```ts
await runtime.pipe(response, {
  threadId: authorizedThreadId,
  input: { messages: [{ role: "user", content: message }] },
  context: { userId: authenticatedUser.id },
});
```

To resume an interrupted graph, use the same authorized thread ID and pass the
resume value expected by the graph or middleware:

```ts
await runtime.pipe(response, {
  threadId: authorizedThreadId,
  resume: { decisions: [{ type: "approve" }] },
  context: { userId: authenticatedUser.id },
});
```

`pipe()` is compatible with Node HTTP and Express-style responses. Use
`runtime.stream(run)` for a transport-free event stream or
`runtime.toResponse(run)` for Web-standard servers. The app must authorize
thread access; never trust a client-provided thread ID without checking it.

For conventional routes, install `@agentdock-ai/agentdock-http` and mount its
Web handler after supplying application authorization:

```ts
import { AgentdockServer } from "@agentdock-ai/agentdock-http";

const server = new AgentdockServer({
  agent: runtime,
  authorize: async (_request, threadId) =>
    (await canAccessThread(authenticatedUser, threadId))
      ? { context: { userId: authenticatedUser.id } }
      : null,
});

export const POST = server.toHttp();
export const GET = server.toHttp();
```

## Production notes

- `MemorySaver` is for local development. Use a LangGraph saver suitable for
  your deployment and create/close its resources in your application.
- Use a stable, server-derived `thread_id` for each conversation and ensure
  your application handles overlapping requests for the same thread safely.
- Pass trusted per-request data through `context`; keep secrets and authorization
  decisions in the application.
- The Agentdock event mapper supports documented `messages`, `tools`, and
  `updates` streams. Arbitrary graph output remains application-specific.

See [`examples/react-agent`](./examples/react-agent/README.md) for a complete
Node server with tools and an approval interrupt, and
[`AGENTDOCK_SCOPE.md`](./AGENTDOCK_SCOPE.md) for the product boundaries.

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
