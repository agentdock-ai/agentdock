<div align="center">
  <p><img src="./logo.png" alt="AgentDock" width="360" /></p>
  <p>A small SSE serving adapter for compiled LangGraph agents.</p>
  <p><a href="https://agentdock-ai.vercel.app"><strong>Visit AgentDock →</strong></a></p>
</div>

AgentDock makes an existing LangGraph agent easier to expose from a Node or Web
backend. It maps graph stream chunks to the event contract consumed by
[`agentdock-ui`](https://github.com/agentdock-ai/agentdock-ui), and handles SSE
framing, backpressure, cancellation, and cleanup.

AgentDock does not build the agent loop, choose model providers, own tools,
authorize requests, or manage checkpoint resources. Use LangChain and LangGraph
for those capabilities and keep application identity and policy in your
backend.

## The value bar

The Phase 0 comparison holds agent setup, request parsing, authentication,
context, and server-derived thread IDs constant. AgentDock earns its place when
it reduces the endpoint-specific handler to five lines or fewer while taking
care of event mapping, SSE framing, backpressure, disconnect cancellation,
terminal errors, and response cleanup. See the
[side-by-side spike report](./PHASE_0_SPIKE_REPORT.md) for the measured
comparison and verification.

## Packages

| Package                                                     | Purpose                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`@agentdock-ai/agentdock`](./packages/agentdock/README.md) | `serveAgent`, its stream/Node/Web transports, and opt-in checkpointed event state. |
| [`@agentdock-ai/contracts`](./packages/contracts/README.md) | JSON-safe event types, tool/message data types, and the UI reducer.                |

## Quick start

```ts
import { serveAgent, agentEventStateSchema } from "@agentdock-ai/agentdock";
import { createAgent } from "langchain";

const graph = createAgent({
  model,
  tools,
  stateSchema: agentEventStateSchema,
  checkpointer,
}).graph;

const runtime = serveAgent(graph);
await runtime.pipe(response, {
  threadId: authenticatedThreadId,
  input: { messages: [{ role: "user", content: prompt }] },
});
```

The backend parses and authenticates the request, chooses the thread ID, and
creates/closes the saver. See the [package guide](./packages/agentdock/README.md)
for interrupt/resume and Web `Response` usage.

## Development

Use Node.js 22 or newer and Yarn:

```bash
yarn install
yarn typecheck
yarn build
yarn test
yarn format:check
```

The project is MIT licensed. Public package versions are managed with Changesets.
