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

A native compiled graph needs no serving state fields. Agentdock reads pending
tasks and forwards native execution without calling `updateState()`.

```ts
import { Agentdock } from "@agentdock-ai/agentdock";
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
  checkpointer,
}).graph;

const runtime = new Agentdock(graph);
```

`getMessages(threadId, { channel?, config? })` reads a checkpoint's message channel.
`getResumeState(threadId, config?)` returns a reducer seed for native pending
interrupts or static breakpoints, or `null` when none are pending. Reads preserve
saver configuration and overwrite `configurable.thread_id` with the authorized
thread ID. The seed contains `interrupts`, the native IDs and complete payloads,
and `runId: null`; load conversation history separately.

Every invocation receives a fresh `runId` and sequence starting at 1. IDs in child
graph events are scoped by the optional `namespace` to avoid collisions. Treat
message and tool IDs as opaque correlation values.

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
The graph and checkpointer own the approval policy and execution. Agentdock
validates human-in-the-loop decision shapes against the native review configuration
before invocation or response headers. Invalid shapes leave the native checkpoint
untouched and reject the call.

```ts
await runtime.pipe(response, {
  threadId: authenticatedThreadId,
  resume: { decisions: [{ type: "approve" }] },
  context: { userId: authenticatedUser.id },
});
```

For multiple pending interrupts, target native IDs with a resume map:

```ts
await runtime.pipe(response, {
  threadId: authenticatedThreadId,
  resume: { [interruptId]: { decisions: [{ type: "approve" }] } },
});
```

Continue a static `interruptBefore` or `interruptAfter` breakpoint using
`{ threadId, continue: true }`. Dynamic interrupts require `resume`. Custom resume
values must be JSON-compatible; use an ID map for falsy values such as `false` or
`null` that native LangGraph does not accept as scalar resume values.

`run.paused` marks a static breakpoint or a continuation that still has pending
interrupts. `interrupt.required` carries each newly pending interrupt. A failed or
cancelled continuation reports `recoverable: true` when the native checkpoint
still has pending work. Refresh `getResumeState()` before deciding how to retry.

For server diagnostics, supply `new Agentdock(graph, { onError(error, details) {} })`.
The details include `threadId`, `runId`, and `stage` (`graph`, `mapper`, or
`checkpoint`); client errors remain sanitized. Exceptions in the observer do not
replace the original failure.

`runtime.stream(run)` exposes the same contract events without a transport.
`runtime.toResponse(run)` returns a Web `Response` backed by a cancelable
`ReadableStream` for Web-standard servers.

Your framework owns routes, request validation, and authorization. Route
controllers call `runtime.pipe(response, run)` for Node-style responses,
`runtime.toResponse(run)` for Web-standard handlers, or `runtime.stream(run)`
when they need to consume events directly.

## Operational ownership

- Your app assigns and authorizes every `threadId`; treat it as a security
  boundary and serialize overlapping runs for a thread when your graph or saver
  requires it.
- Your app creates and closes the checkpointer. Agentdock does not open,
  replace, or close saver resources.
- Cancellation reaches LangGraph and cooperative tools through an
  `AbortSignal`. A tool that ignores its signal may continue after a client has
  disconnected.

## Event contract

The runtime emits the JSON-safe event types and reducer from
[`@agentdock-ai/contracts`](https://www.npmjs.com/package/@agentdock-ai/contracts).
The package includes the `Agentdock` class and checkpoint read helpers; agent loops, tool registries, providers, and session stores remain
LangChain/LangGraph or application responsibilities.

## License

MIT. See the [repository license](https://github.com/agentdock-ai/agentdock/blob/main/LICENSE).
