# AgentDock — Implementation Plan (Phase by Phase)

Status: **Phases 0–3 and Phase 4 documentation/release preparation are complete
locally. Publication and npm deprecations remain pending the `main` release tag.**

**What changed in v4**

- The example now actually interrupts: an approval-gated tool plus
  `humanInTheLoopMiddleware`, so the resume snippet is reachable.
- The mapper is now a **binding contract** (§5.4): run-context metadata, an
  emission table, and explicit duplication guards.
- Web-stream cancellation (`ReadableStream.cancel()`) is specified and gated.
- The example is runnable (request parsing shown; resume handled) and the
  checkpointer parameter is typed as a saver **instance**.
- `serveAgent` infers the graph's input/context types.
- Scope §3.1 wording aligned (AgentDock forwards `threadId`; it does not own
  session mapping).

**Out of scope:** AgentDock UI.

---

## 0. How to read this plan

- `AGENTDOCK_SCOPE.md` (authoritative for scope) defines _what is in scope_.
- This document defines _what we do, in what order, and how we verify it_.
- **Build stays green:** delete code only when it is unused or already replaced.
- **No export is removed while any consumer exists** — including tests in
  out-of-scope repos.

---

## 1. End state

Two thin layers over untouched LangGraph, plus one example.

```
┌──────────────────────────────────────────────┐
│ Facade (application, ~1 line)                  │  POST · app.post · node:http
├──────────────────────────────────────────────┤
│ Serving layer   serveAgent(graph) → runtime    │  stream · pipe · toResponse
├──────────────────────────────────────────────┤
│ Utility layer   pure helpers                   │  mapper · json · signals
├──────────────────────────────────────────────┤
│ Example         ReAct agent via createAgent    │  documented, not shipped
├──────────────────────────────────────────────┤
│ LangGraph / LangChain  (unchanged, the engine) │  createAgent · StateGraph · savers
└──────────────────────────────────────────────┘
```

**Definition of done**

- No checkpoint adapters, no model package, no context-management code.
- AgentDock ships **no agent loop and no recipes**.
- `serveAgent(graph)` turns any compiled graph into a streaming endpoint with
  cancellation (Node _and_ Web), `thread_id`, opaque interrupt/resume,
  backpressure, cleanup.
- The mapper satisfies the contract's reducer for every mapped event (§5.4).
- One example passes the Phase 0 value bar and demonstrates interrupt → resume.
- `typecheck`, `build`, `test` green; the gate passed before any deletion.

---

## 2. Decisions locked for this plan

### 2.1 Wire format: keep the existing AgentDock contract

`agentdock-ui/ui-core` consumes `AgentEvent`, `AgentReducerState`,
`reduceAgentEvent`, `createAgentReducerState`, `ContentPart`. Phase 2 emits the
existing contract via the **binding mapper contract** in §5.4.

### 2.2 No recipes in V1

No `createToolAgent`, `createTaskAgent`, or `createReActAgent`. A ReAct agent
**is** `createAgent`. V1 ships the serving layer plus a documented example.

### 2.3 Serving API

`run` is the only input. AgentDock never parses HTTP or infers identity.

```ts
type StartRun<TInput, TContext> = {
  input: TInput; // required on a start
  threadId: string; // server-derived; forwarded, never invented
  context?: TContext; // app data → LangGraph `context`
  signal?: AbortSignal;
};

type ResumeRun<TContext> = {
  threadId: string; // same thread as the interrupted run
  resume: unknown; // opaque → new Command({ resume })
  context?: TContext;
  signal?: AbortSignal;
};

type Run<TInput, TContext> = StartRun<TInput, TContext> | ResumeRun<TContext>;

function serveAgent<TInput, TContext>(graph): Runtime<TInput, TContext>;
// runtime.stream(run) · runtime.pipe(res, run) · runtime.toResponse(run)
```

**Typing:** `serveAgent` infers `TInput`/`TContext` from the compiled graph so
`input` and `context` are checked at the call site. The exact generic parameters
come from LangGraph's compiled-graph types and are confirmed in Phase 0.

### 2.4 Checkpointer ownership

The serving layer receives an already-compiled graph and never configures a
checkpointer. Setup belongs to the application/example, typed as a saver
**instance**:

```ts
// checkpointer?: BaseCheckpointSaver   (from @langchain/langgraph-checkpoint)
createAgent({ ..., checkpointer: params.checkpointer ?? new MemorySaver() });
```

Never depend on a database driver. HITL requires a checkpointer — documented,
not defaulted by the serving layer.

### 2.5 Prompts

The example sets `createAgent({ systemPrompt })`. **Per-run prompt override is
not in V1.** `Run.context` reaches nodes/tools via LangGraph's `runtime.context`;
the example shows a tool reading it.

### 2.6 Authorization is the application's

No `authorize` hook. A generic layer cannot gate every side effect in an
arbitrary graph. The application authorizes and passes trusted data via
`context`; approval uses `humanInTheLoopMiddleware` in the graph.

### 2.7 Resume is opaque

`run.resume` → `new Command({ resume: run.resume })`. AgentDock owns no approval
protocol. HITL's value is `{ decisions: [{ type: "approve" }] }`.

### 2.8 Thread id is server-derived

`threadId` is forwarded to `configurable.thread_id` and derived from the
authenticated session — never trusted verbatim from the client.

---

## 3. Phase 0 — Value spike and gate (before any deletion)

Prove the serving layer removes real work versus a hand-written endpoint.

Build a **throwaway** `serveAgent` prototype and compare it with the
pure-LangGraph baseline (`AGENTDOCK_SCOPE.md` §7) on the same example.

**Falsifiable value bar — all must hold:**

1. The HTTP handler shrinks to **≤ 5 lines** with `serveAgent`.
2. `serveAgent` owns these six concerns: SSE headers, `data:` framing,
   backpressure (`drain`), disconnect → abort, terminal error frame, cleanup.
3. Public surface is **≤ 4 functions** (`stream`, `pipe`, `toResponse`; resume is
   a `Run` variant).
4. The prototype passes: (a) a cancel test on **both** paths — Node `close` and
   Web `ReadableStream.cancel()`; (b) a backpressure test; (c) an
   **interrupt → resume** round trip; (d) a **mapper test** (§5.4) reducing a
   fixture stream through `reduceAgentEvent` without throwing.

**Gate:** if any fails, **stop and reconsider the product** before cleanup.

**Exit:** a written pass/fail with the two code samples side by side.

---

## 4. Phase 1 — Cleanup (only after the gate passes)

### 4.1 Delete packages (whole)

| Package               | Reason                                                  | Breaks              |
| --------------------- | ------------------------------------------------------- | ------------------- |
| `checkpoint`          | duplicate of LangGraph checkpoint contract              | 3 core files (§4.4) |
| `checkpoint-postgres` | duplicate of `@langchain/langgraph-checkpoint-postgres` | none                |
| `checkpoint-sqlite`   | duplicate of `@langchain/langgraph-checkpoint-sqlite`   | CLI (§4.5)          |
| `checkpoint-mongodb`  | duplicate of `@langchain/langgraph-checkpoint-mongodb`  | none                |
| `checkpoint-redis`    | duplicate of `@langchain/langgraph-checkpoint-redis`    | none                |
| `models`              | passthrough over LangChain providers                    | CLI only (§4.5)     |

### 4.2 Delete core files (unused or duplicated)

`agent/context-management.ts`, `agent/context-message-window.ts`,
`agent/context-policy.ts`, `agent/memory.ts`, `agent/permissions/types.ts`,
`tools/define-tool.ts`, `tools/registry.ts`, and the empty placeholder dirs under
`agent/` (`checkpoint/`, `runs/`, `sessions/`, `storage/`, `runtime/`).

### 4.3 Trim `contracts` — provably-dead exports only

Remove `AgentResumeRequest`, `cloneJsonSchema`, `AgentSessionHistoryEntry`.
**Keep `reduceAgentEvents`** (external test consumer) and the event protocol.

### 4.4 Rewire the 3 breakages from deleting `@agentdock-ai/checkpoint`

`agent/agent-dock.ts` (accept a `BaseCheckpointSaver`), `agent/validation.ts`
(drop `CheckpointAdapter`), `agent/index.ts` (remove the re-export).

### 4.5 Rewire the CLI

`provider-settings.ts` (LangChain providers), `cli-application.tsx`
(LangGraph `SqliteSaver`).

### 4.6 Ordering rule

Delete only once nothing imports it: leaf packages (§4.1) → rewire (§4.4/§4.5) →
delete now-unused core files (§4.2). Re-run `typecheck` after each step.

**Exit:** the 6 packages gone; no imports remain; `contracts` has no
provably-dead exports; checks green; CLI runs on LangGraph savers.

> **Deprecation of published packages does NOT happen here** — it moves to
> Phase 4 with the release and migration notes (§7).

---

## 5. Phase 2 — Build the serving layer + utility layer

Built from the validated Phase 0 spike; replaces the old `AgentDock` class and
`ToolCallingWorkflow`.

### 5.1 Utility layer (pure, framework-free)

`toWireEvent` (§5.4) · `json.ts` (`JsonValue`/`JsonObject` + clone helpers) ·
`aborts.ts` (compose request and run signals).

### 5.2 `serveAgent` internals

```ts
const isResume = "resume" in run;
graph.stream(isResume ? new Command({ resume: run.resume }) : run.input, {
  streamMode: ["messages", "tools", "updates"],
  configurable: { thread_id: run.threadId }, // thread id: one source
  context: run.context, // app data only
  signal: run.signal,
  recursionLimit, // safety net
});
```

**Cancellation — both transports must abort the run:**

- `pipe(res, run)` — `res.on("close", () => ac.abort())`. Owns SSE headers,
  `data:` framing, `drain` backpressure, a terminal error frame, `res.end()`, and
  no Express/Next types (a minimal structural interface
  `{ writeHead, write, end, on }`).
- `toResponse(run)` — returns a `Response` whose body is a `ReadableStream` with a
  `cancel(reason)` callback that aborts the run:

  ```ts
  const ac = new AbortController();
  const body = new ReadableStream({
    async start(controller) {
      for await (const event of stream({
        ...run,
        signal: merge(run.signal, ac.signal),
      })) {
        controller.enqueue(encode(event));
      }
      controller.close();
    },
    cancel(reason) {
      ac.abort(reason);
    }, // client cancelled → stop the graph
  });
  ```

  The caller's `run.signal` (e.g. `request.signal`) is merged, not replaced.

### 5.3 Delete the old execution path

Once `serveAgent` and the example work end to end, delete `agent/agent-dock.ts`,
`agent/coordinator.ts` (if unused), and `agent/workflows/**`.

### 5.4 Mapper contract (`toWireEvent`) — the binding spec

The target contract is **strict**: `reduceAgentEvent` throws if a stream does not
begin with `run.started`, if sequences are not monotonic, if an event arrives
after a terminal state, if a tool result/progress has no known tool call, or if an
interrupt resolution does not match a pending interrupt. The mapper is therefore
specified, not improvised.

**Run context — minted by the serving layer, once per run:**

| Field             | Source                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `protocolVersion` | the contract constant                                                                                                             |
| `runId`           | `crypto.randomUUID()` per logical operation; an approval resume keeps the checkpointed `runId` and continues its logical sequence |
| `sessionId`       | defaults to `threadId` (we do not invent a second identity)                                                                       |
| `eventId`         | `${runId}:${counter}` — unique                                                                                                    |
| `timestamp`       | ISO-8601 at emission                                                                                                              |
| `logicalSequence` | monotonically increasing across the run                                                                                           |
| `sequence`        | monotonically increasing within the current `phaseId`                                                                             |
| `phaseId`         | incremented at each `updates` chunk (node/superstep boundary)                                                                     |

**Emission contract:**

| Stream input                         | Emitted event                    | Notes                                                                                                             |
| ------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| run begins                           | `run.started`                    | first event                                                                                                       |
| first assistant text/reasoning chunk | `message.started` (assistant)    | emitted lazily before the first delta                                                                             |
| `messages` mode — text chunk         | `message.part.delta` (text)      | **single source for text**                                                                                        |
| `messages` mode — reasoning chunk    | `message.part.delta` (reasoning) | when the model emits reasoning                                                                                    |
| assistant turn ends                  | `message.completed`              |                                                                                                                   |
| `tools` mode — `on_tool_start`       | `tool.called`                    | **single source for tool lifecycle**                                                                              |
| `tools` mode — `on_tool_event`       | `tool.progress`                  | requires a prior `tool.called`                                                                                    |
| `tools` mode — `on_tool_end`         | `tool.completed`                 |                                                                                                                   |
| `tools` mode — `on_tool_error`       | `tool.failed`                    |                                                                                                                   |
| interrupt surfaced                   | `interrupt.required`             | HITL `actionRequests` → `actions`; `kind: "tool-approval"` only when a `toolCallId` exists, else `kind: "custom"` |
| resume accepted                      | `interrupt.resolved`             | must match the pending `interruptId`                                                                              |
| stream completes                     | `run.completed`                  | terminal                                                                                                          |
| error thrown                         | `run.failed`                     | terminal                                                                                                          |
| signal aborted                       | `run.cancelled`                  | terminal                                                                                                          |

**Duplication guards (explicit non-mappings):**

1. Text comes **only** from `messages`; `updates` is used only for phase
   boundaries and terminal detection. Mapping both duplicates text.
2. Tool lifecycle comes **only** from `tools`; `AIMessageChunk.tool_calls` is
   never emitted as a tool event. Mapping both duplicates tool rows.
3. Nothing is emitted after a terminal event.

**Unmappable:** graphs whose nodes don't use chat models or LangChain tools emit
no textual/tool events — documented, not papered over. `custom` chunks and
unrecognized content parts pass through as a `custom` `ContentPart`; nothing is
silently dropped.

**Test:** one fixture stream per row, reduced through `reduceAgentEvent` (the same
reducer `ui-core` uses). If it throws, `ui-core` breaks.

### 5.5 Re-point the CLI

The CLI becomes the demo consumer of `serveAgent`.

**Exit:** `serveAgent` streams on `node:http` and Web `Response`; cancellation
works on **both** paths; resume and cleanup tested; mapper fixtures pass; old
engine deleted; checks green.

---

## 6. Phase 3 — Example: the ReAct agent (not a recipe)

Built with `createAgent`, including a real approval gate. **No hand-built graph.**

```ts
import { createAgent, tool, humanInTheLoopMiddleware } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import * as z from "zod";

const getWeather = tool(({ city }) => weatherApi.lookup(city), {
  name: "get_weather",
  description: "Get the current weather for a city.",
  schema: z.object({ city: z.string() }),
});

const sendEmail = tool(({ to, body }) => mailer.send({ to, body }), {
  name: "send_email",
  description: "Send an email on the user's behalf.",
  schema: z.object({ to: z.string(), body: z.string() }),
});

export function createExampleAgent(params: {
  model: Parameters<typeof createAgent>[0]["model"];
  tools?: Parameters<typeof createAgent>[0]["tools"];
  checkpointer?: BaseCheckpointSaver; // a saver INSTANCE
  systemPrompt?: string;
}) {
  return createAgent({
    model: params.model,
    tools: params.tools ?? [getWeather, sendEmail],
    systemPrompt: params.systemPrompt ?? "You are a helpful assistant.",
    checkpointer: params.checkpointer ?? new MemorySaver(), // example owns the default
    middleware: [
      // approval gate: the run pauses before send_email executes
      humanInTheLoopMiddleware({ interruptOn: { send_email: true } }),
    ],
  });
}
```

Runnable server — parses the request, derives the thread id server-side, and
handles both start and resume in one handler:

```ts
import { createServer } from "node:http";

const runtime = serveAgent(
  createExampleAgent({ model: "openrouter:z-ai/glm-5.2" }),
);

createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  const body = await readJson(req); // your ~5-line body reader
  const { message, conversationId, decisions } = body;
  const threadId = deriveThreadId(authedUserId(req), conversationId); // server-derived

  const run = decisions
    ? { threadId, resume: { decisions } } // e.g. [{ type: "approve" }]
    : {
        input: { messages: [{ role: "user", content: message }] },
        threadId,
        context: { userId: authedUserId(req) }, // reaches tools via runtime.context
      };

  await runtime.pipe(res, run);
}).listen(3000);
```

**No eject test.** There is no AgentDock artifact to eject — the example already
uses `createAgent` directly, so the property is trivially true and is not a gate.

**Exit:** text answer; tool loop; `context` reaches a tool; interrupt → resume
round trip (the `send_email` call pauses, then resumes on approval).

**Implementation:** `examples/react-agent` is a private workspace example. It
uses `createAgent`, the OpenRouter integration, `MemorySaver`, weather/email
tools, trusted context, and approval middleware. The Node handler validates
requests and derives a thread ID from server identity and a conversation ID. A
deterministic integration fixture verifies that trusted context reaches the
approved tool across a fresh runtime on resume.

---

## 7. Phase 4 — Docs, release, and migration

- README, docs site, landing page, and machine-readable docs describe the
  current serving surface and its ownership boundaries.
- The Phase 0 comparison remains in the spike report; package docs do not claim
  AgentDock builds the agent loop.
- The `createAgent` example and interrupt/resume flow are documented.
- Migration guidance maps the former runtime, provider helpers, and saver
  adapters to direct LangChain/LangGraph APIs.
- Changesets prepare the pre-1.0 release as `@agentdock-ai/agentdock@0.2.0`
  and `@agentdock-ai/contracts@0.2.0`.
- At release, deprecate only legacy package versions confirmed as published.
  The repository release workflow requires the tagged commit to be on `main`;
  npm publication and deprecation therefore follow merge and final verification.

**Exit:** docs match the shipped surface; migration notes are present; changesets
are prepared; publish and deprecation actions run from the approved main-branch
release tag.

---

## 8. Risks and rollback

| Risk                                                   | Mitigation                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| Serving layer adds little over a hand-written endpoint | Phase 0 gate; stop if the bar fails.                                 |
| Mapper emits a stream the reducer rejects              | Binding contract §5.4 + fixtures reduced through `reduceAgentEvent`. |
| Duplicate text or tool rows in the UI                  | Explicit non-mappings (§5.4).                                        |
| Serving layer mistaken for a security boundary         | No `authorize` hook (§2.6).                                          |
| Trimming `contracts` breaks `agentdock-ui`             | Remove only provably-dead exports; keep the protocol.                |
| Thread-id spoofing                                     | Server-derived thread ids (§2.8).                                    |
| Users stranded by removal                              | Deprecate at release with migration notes (§7).                      |
| Build goes red mid-phase                               | Fail-safe ordering (§4.6).                                           |
| Scope creeps back toward a framework                   | Guardrails in `AGENTDOCK_SCOPE.md` §3.3.                             |

Rollback: each phase is a self-contained commit series; `git revert` restores the
prior phase. npm deprecations are reversible.

---

## 9. Verification matrix

| Phase | Must pass                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Value bar (§3): ≤5-line handler, six owned concerns, ≤4 functions, cancel (Node + Web) + backpressure + interrupt/resume + mapper spike                                        |
| 1     | No imports of deleted packages; `contracts` has no provably-dead exports (keeping `reduceAgentEvents`); CLI runs; checks green                                                 |
| 2     | `serveAgent` streams on `node:http` and Web `Response`; cancellation on both paths; resume + cleanup tested; every mapper fixture reduces without throwing; old engine deleted |
| 3     | Example: text + tool loop + `context` to a tool + interrupt/resume via `send_email`; deterministic context/approval integration test                                           |
| 4     | Docs and LLM references match surface; migration notes present; 0.2.0 changesets prepared; published legacy versions deprecated at release                                     |

---

## 10. Appendix — current-system findings (used to sequence Phase 1)

- **Core package:** 22 source files. The LangGraph integration lives in
  `agent/workflows/tool-calling/{workflow,tools,message-adapter,interrupts}.ts`
  plus `workflows/event-stream.ts`; `workflow.ts` is the single essential file
  (uses `createAgent`, `Command`, `interrupt`, `isGraphBubbleUp`).
- **Deleting `@agentdock-ai/checkpoint` breaks exactly 3 files:**
  `agent/agent-dock.ts`, `agent/validation.ts`, `agent/index.ts`.
- **`@agentdock-ai/models` has zero imports in core `src`** — only the CLI uses it.
- **`contracts` consumers:** `agentdock-cli` (`isJsonObject`, `cloneContentParts`,
  `JsonObject`, `JsonValue`) and `agentdock-ui/ui-core` (`AgentEvent`,
  `AgentReducerState`, `AgentReducerMessage`, `reduceAgentEvent`,
  `reduceAgentEvents`, `createAgentReducerState`, `cloneAgentEvent`,
  `ContentPart`).
- **Provably-dead exports:** `AgentResumeRequest`, `cloneJsonSchema`,
  `AgentSessionHistoryEntry`. (`reduceAgentEvents` kept — external test consumer.)
- **Placeholder directories** under `agent/`: `checkpoint/`, `runs/`,
  `sessions/`, `storage/`, `runtime/` — verify and remove.
