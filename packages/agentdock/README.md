# AgentDock

AgentDock is a durable, frontend-ready TypeScript runtime for a streamed LangChain
tool-calling agent running on LangGraph.

It owns the application contract: tool registration, approval policy, normalized events, run lifecycle, and a small public API. LangChain owns models and tools; LangGraph owns the tool-calling loop, checkpoints, interrupts, and resume.

## Install

```bash
yarn add agentdock @langchain/openai
```

Applications install the LangChain provider they need and pass a configured chat model to AgentDock.

## Usage

```ts
import { ChatOpenAI } from "@langchain/openai";
import { AgentDock } from "agentdock";

const dock = new AgentDock({
  model: new ChatOpenAI({ model: "gpt-5.4-mini" }),
  defaults: {
    systemPrompt: "Answer clearly and use tools when they help.",
    maxSteps: 4,
  },
});

dock.registerTool({
  name: "get_weather",
  description: "Look up the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
  execute: async ({ input }) => ({ city: input.city, forecast: "sunny" }),
});

const { stream, result } = await dock.stream(
  "What is the weather in Lahore?",
  { userId: "user-123" },
  { sessionId: "session-123" },
);

for await (const event of stream) {
  if (event.type === "message.part.delta" && event.part.type === "text")
    process.stdout.write(event.part.text);
}

console.log(await result);
```

`result.content` and every normalized message use `ContentPart[]`. Read text parts
for plain terminal output while preserving reasoning, media, citations, custom JSON,
and tool records for richer clients:

```ts
const text = (await result).content
  .filter((part) => part.type === "text")
  .map((part) => part.text)
  .join("");
```

The stream uses the canonical AgentDock event contract. Events include structured
content (`message.part.delta`), tool lifecycle events (`tool.completed` and
`tool.failed`), interrupts, terminal metadata, and stable run/session sequencing.
There is one stream method and one event union; `run()` consumes the same stream
internally and returns the same logical result.

For new code, the simpler typed API avoids hand-written raw schemas:

```ts
import { createAgentDock, defineTool } from "agentdock";
import { z } from "zod";

const weather = defineTool({
  name: "get_weather",
  description: "Look up weather.",
  input: z.object({ city: z.string() }),
  run: async ({ city }) => ({ city, forecast: "sunny" }),
});

const dock = createAgentDock({
  model,
  instructions: "Answer clearly.",
  tools: { weather },
});
```

## Optional provider resolver

`@agentdock/models` is a separate package for applications that prefer a small provider configuration object over importing LangChain provider classes directly. It returns the same `BaseChatModel`; it does not change AgentDock's workflow behavior.

```ts
import { AgentDock } from "agentdock";
import { AgentDockModel } from "@agentdock/models";

const dock = new AgentDock({
  model: AgentDockModel.openAI({
    model: "gpt-5.4-mini",
    apiKey: process.env.OPENAI_API_KEY,
  }),
});
```

The optional resolver initially supports `openai`, `ollama`, and `openrouter`; applications that need a provider outside that set can continue to pass any LangChain `BaseChatModel` directly.

## Optional automatic context management

Context compaction is opt-in. When enabled, AgentDock compacts older model-visible
conversation state immediately before a primary-model call, then persists the summary
and retained messages through the existing LangGraph checkpoint. It therefore survives
process recreation and approval resumes without a second graph or persistence system.

```ts
import { AgentDock } from "agentdock";
import { PostgresCheckpoint } from "@agentdock/checkpoint-postgres";
import { AgentDockModel } from "@agentdock/models";

const model = AgentDockModel.openAI({
  model: "gpt-5.4-mini",
  apiKey: process.env.OPENAI_API_KEY,
});
const summaryModel = AgentDockModel.openAI({
  model: "gpt-5.4-nano",
  apiKey: process.env.OPENAI_API_KEY,
});

const dock = new AgentDock({
  model,
  checkpoint: new PostgresCheckpoint({
    connectionString: process.env.DATABASE_URL!,
  }),
  contextManagement: {
    summarization: {
      summaryModel, // optional; defaults to model
      trigger: "auto",
    },
  },
});
```

`trigger: "auto"` uses the verified input-context profile of the **primary** model:
it compacts at 75% of that capacity and retains the newest 25%. The summary model may
be smaller; it never changes the primary-model budget, and AgentDock trims its summary
input to fit safely. Supported provider models and `AgentDockModel` expose profile
metadata. An unknown raw LangChain model must provide a profile override in automatic
or fractional mode:

```ts
contextManagement: {
  summarization: {
    trigger: "auto",
    primaryModelProfile: { maxInputTokens: 128_000 },
  },
}
```

Advanced callers can avoid profile discovery with explicit policies such as
`trigger: { tokens: 96_000 }`, `trigger: { messages: 80 }`, and
`keep: { tokens: 24_000 }`. `maxSteps` is unrelated: it limits main model calls,
not the model context size. AgentDock preserves system instructions, recent messages,
and whole assistant/tool-result groups. Runtime `ctx` remains tool and authorization
context; it is not copied into model prompts or summaries.

## Approval and resume

Set `requiresApproval: true` on a side-effecting tool. AgentDock emits
`interrupt.required` and returns a `waiting_for_approval` result. LangGraph keeps
the graph checkpoint; resume the same session after a decision. A resume continues
the same logical run and can cross any number of approval boundaries, including
after recreating AgentDock from a durable checkpoint. Approval requests are read
from the current interrupt only, so old approvals never reappear.

Event sequence numbers are ordered within each returned stream. The logical
sequence continues across phases and restarts, while each returned stream has its
own phase sequence.

The contracts package provides the event types with session/run/phase identifiers,
logical ordering, structured content parts, generic interrupt records, usage, finish
metadata, and a deterministic reducer. Tool approval is the first implemented
interrupt kind; custom interrupt execution remains a later milestone.

```ts
const waiting = await dock.run("Publish the report.", context, {
  sessionId: "session-123",
  runId: "run-publish",
});

const completed = await dock.resume(
  {
    runId: waiting.runId,
    approvals: waiting.approvalRequests.map((request) => ({
      approvalId: request.approvalId,
      approved: true,
    })),
  },
  context,
  { sessionId: "session-123" },
);
```

Use a durable checkpoint adapter in production:

```ts
import { PostgresCheckpoint } from "@agentdock/checkpoint-postgres";

const dock = new AgentDock({
  model,
  checkpoint: new PostgresCheckpoint({
    connectionString: process.env.DATABASE_URL!,
  }),
});
```

Install only the optional backend package you need, for example `yarn add @agentdock/checkpoint-postgres`. The default `MemoryCheckpoint` is process-local and intended for development and tests. Raw LangGraph savers remain available through `checkpointer` for advanced integrations; AgentDock does not close those caller-owned savers.

## Lifecycle and authoring rules

`new AgentDock()` is the advanced escape hatch for raw LangChain models,
checkpointers, adapters, defaults, coordinators, and middleware. The easy factory
accepts the same `middleware` option and passes it to this runtime without a second
execution path. `defineTool()` validates model
input with Zod and infers the `run` input type. The execution callback receives
JSON context, an abort signal, progress reporting, and the finalized tool-call ID.
Raw JSON Schema is an explicit advanced escape hatch. Its supported subset is an
object root with `properties`, `required`, `additionalProperties`, `items`,
`enum`, `const`, `oneOf`, `anyOf`, and `allOf` (plus descriptive metadata);
unsupported keywords are rejected at registration.

Tool input is validated before authorization and again before execution through the
same runtime schema. For publish, write, send, or mutation tools, persist or pass the
`toolCallId` as the external operation's idempotency key. AgentDock does not retry or
undo a side effect that outlives cancellation; a timeout or cancellation is not proof
that the external operation stopped.

`getSession()` returns current normalized model-visible messages. Use
`getSessionHistory()` for checkpoint-by-checkpoint history and `deleteSession()` to
remove all model-visible checkpoint context. Deletion fails while the
namespace/session has an active run. A `sessionNamespace` must be stable for the
host/tenant that owns the session; host authorization and tenant metadata remain
outside AgentDock.

Use a durable `checkpoint` adapter when AgentDock owns the resource. If you pass a
raw `checkpointer`, it remains caller-owned and AgentDock never closes it. Tool and
authorization timeouts have hard deadlines even for code that ignores its abort
signal, but an external side effect may still continue. `close({ gracePeriodMs })`
aborts active runs, waits only for the grace period, closes owned resources once,
and exposes unfinished run IDs through `getUnfinishedRunIds()`.

Authorization is checked before an approval interrupt and again immediately before
tool execution. A denied protected tool therefore does not create an approval prompt.

Every event includes `protocolVersion` plus stable run, session, phase, event, and
sequence fields. Consumers must reject unsupported protocol versions rather than
guessing at payload shape. Usage may include input, cached-input, output, reasoning,
and total tokens together with model, provider, and USD cost when a provider reports
them. A configured model-call limit terminates with `agent_step_limit` and explicit
limit metadata.
