<div align="center">
  <p>
    <img src="https://raw.githubusercontent.com/agentdock-ai/agentdock/main/logo.png" alt="Agentdock" width="300" />
  </p>

  <p>A small SSE serving adapter for compiled LangGraph agents.</p>

  <p>
    <a href="https://www.npmjs.com/package/@agentdock-ai/agentdock"><img alt="npm version" src="https://img.shields.io/npm/v/%40agentdock-ai%2Fagentdock?label=release&color=6959DF" /></a>
    <a href="https://github.com/agentdock-ai/agentdock/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-111827" /></a>
    <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" />
  </p>
</div>

Agentdock adapts a graph you already built with LangGraph to a stable stream of
JSON events. Your application owns graph construction, models, tools, identity,
authorization, request parsing, and checkpoint saver lifecycle.

## Install

```bash
npm install @agentdock-ai/agentdock @agentdock-ai/contracts @langchain/langgraph langchain zod
```

Install the LangChain provider integration and checkpoint saver your application
uses.

## Serve a compiled graph

Use `withAgentEventState(fields)` in the graph's state schema when the graph can
interrupt and resume. Its `agentEventState` field preserves event identity,
sequence, and the full pending interrupt across requests and runtime instances.

```ts
import { Agentdock, withAgentEventState } from "@agentdock-ai/agentdock";
import { createAgent, tool } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";

const checkpointer = new MemorySaver();
const lookup = tool(async ({ city }) => ({ city, forecast: "Sunny" }), {
  name: "lookup_weather",
  description: "Look up the weather for a city.",
  schema: z.object({ city: z.string() }),
});

const graph = createAgent({
  model, // Supply a LangChain chat model from your provider integration.
  tools: [lookup],
  stateSchema: withAgentEventState({}),
  checkpointer,
}).graph;

const runtime = new Agentdock(graph);
```

Use `withAgentEventState(fields)` to compose the required event checkpoint
field with application state. It reserves `agentEventState` for Agentdock
and preserves the field validators and defaults supplied by the application.
`getMessages(threadId)` reads a checkpoint's message channel.

For cold-client hydration, `runtime.getResumeState(threadId)` returns a reducer
seed only when the checkpoint contains a complete, validated pending interrupt.
The seed restores run identity, sequence, and interrupt status; load conversation
history separately.

Fallback message and tool-call IDs are UUID-based and opaque. Keep the IDs
received in events for correlation; do not rely on their generated format.

After authenticating and authorizing the request, give the runtime the
application-derived thread ID and graph input:

```ts
await runtime.pipe(response, {
  threadId: authenticatedThreadId,
  input: { messages: [{ role: "user", content: "Weather in Lahore?" }] },
  context: { userId: authenticatedUser.id },
  config: {
    tags: ["customer-request"],
    metadata: { requestId },
    configurable: { tenantId: authenticatedUser.tenantId },
  },
  signal: requestAbortSignal,
});
```

`config` forwards LangGraph run options such as callbacks, tags, metadata,
store, and extra `configurable` values. Agentdock overwrites
`configurable.thread_id` with the application-authorized `threadId`; stream
modes, context, signal, and recursion limit are also controlled by the serving
runtime.

`pipe()` writes a `text/event-stream` response, waits for Node backpressure,
aborts graph work after a disconnect, and ends the response once. The app should
complete parsing, authentication, authorization, and status selection before
calling it.

## Resume an interrupt

Use the same authorized thread ID and pass LangGraph's resume value unchanged.
The graph and checkpointer own the approval policy and resume payload shape.

```ts
await runtime.pipe(response, {
  threadId: authenticatedThreadId,
  resume: { decisions: [{ type: "approve" }] },
  context: { userId: authenticatedUser.id },
});
```

`runtime.stream(run)` exposes the same contract events without a transport.
`runtime.toResponse(run)` returns a Web `Response` backed by a cancelable
`ReadableStream` for Web-standard servers.

For built-in HTTP routes, install `@agentdock-ai/agentdock-http` and construct
`AgentdockServer` with this `Agentdock` instance plus an application-owned
`authorize` callback.

## Operational ownership

- Your app assigns and authorizes every `threadId`; treat it as a security
  boundary and serialize overlapping runs for a thread when your graph or saver
  requires it.
- Your app creates and closes the checkpointer. Agentdock does not open,
  replace, or close saver resources.
- Cancellation reaches LangGraph and cooperative tools through an
  `AbortSignal`. A tool that ignores its signal may continue after a client has
  disconnected.
- Without `withAgentEventState(fields)`, a graph can serve a non-interrupted start,
  but a resume is rejected because the runtime cannot restore the event stream
  identity safely.

## Event contract

The runtime emits the JSON-safe event types and reducer from
[`@agentdock-ai/contracts`](https://www.npmjs.com/package/@agentdock-ai/contracts).
The package includes the `Agentdock` class and checkpoint-backed event
state schema; agent loops, tool registries, providers, and session stores remain
LangChain/LangGraph or application responsibilities.

## License

MIT. See the [repository license](https://github.com/agentdock-ai/agentdock/blob/main/LICENSE).
