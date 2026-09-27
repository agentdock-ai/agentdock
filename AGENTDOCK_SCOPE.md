# AgentDock — Scope

Status: **Draft v2 — aligned with `AGENTDOCK_IMPLEMENTATION_PLAN.md`.** Changes no
code. This is the authoritative scope; the plan covers execution and phases.

> **Scope discipline.** If a capability is not listed under **In scope**, it is
> out of scope by default.

---

## 1. Business requirement

LangGraph already runs agents: graphs, loops, tools, checkpoints, interrupts,
resume, streaming, middleware. It is the execution authority. We do not compete
with it and we do not re-wrap its primitives.

What LangGraph does **not** do for a Node/TypeScript backend is the last mile:
**expose an agent as a well-behaved streaming HTTP endpoint** — with sessions,
cancellation, interrupt/resume, backpressure, and cleanup.

**Product promise**

> Bring any compiled LangGraph graph and expose it as a streaming HTTP endpoint
> in a few lines. One documented example shows a ReAct agent, built with
> LangChain's `createAgent`.

**Why it must stay small**

The current implementation grew into a framework that re-implements what
LangGraph, LangChain, and the database drivers already own. Every duplicate is
code we maintain, test, and keep in version lock-step forever. The value of
AgentDock is _integration_, not reimplementation.

---

## 2. Ownership boundaries

| Layer                                | Owns                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| LangGraph / LangChain                | Graph execution, agent loop (`createAgent`), tools, checkpointers, stores, interrupts, resume, streaming, model providers, middleware |
| **AgentDock**                        | The serving layer; the utility layer; request → LangGraph config translation                                                          |
| Application backend                  | Authentication, authorization, tenancy, secrets, business rules, side effects, the HTTP framework                                     |
| Frontend (Assistant UI / any client) | Rendering messages, tools, progress, approvals                                                                                        |

**The governing rule:** AgentDock _forwards_ LangGraph/LangChain objects; it
never _wraps_ them. It never parses HTTP and never infers identity.

---

## 3. Scope (strict)

### 3.1 In scope

1. **Serving layer.** `serveAgent(graph)` → a `runtime` exposing
   `stream` / `pipe(res)` / `toResponse`. Owns: forwarding the application's
   `threadId` to LangGraph's `configurable.thread_id`, cancellation, opaque
   interrupt/resume, backpressure, cleanup. Framework-agnostic — the application
   writes the one-line facade.
2. **Utility layer.** Pure helpers: stream-event projection, JSON helpers, signal
   composition.
3. **Wire format: a compatibility mapper.** LangGraph stream output → the
   **existing AgentDock event contract**, kept because `agentdock-ui/ui-core`
   consumes it. Bounded scope (plan §5.4) — not a general normalizer.
4. **Passthrough inputs.** Model, checkpointer, store, callbacks, middleware —
   forwarded using LangChain/LangGraph's own names.
5. **Docs + one example.** A ReAct agent via `createAgent`, plus an
   interrupt/resume example.

### 3.2 Out of scope (refused)

- **Prebuilt agents / recipes** — V1 ships none. A ReAct agent _is_ `createAgent`.
- **Agent loop implementation** — LangChain `createAgent` owns it.
- Graph engine, nodes/edges, DSL, workflow builder — LangGraph owns this.
- Checkpoint saver implementations or adapter packages — LangGraph owns this.
- Model/provider configuration package — LangChain providers own this.
- A tool-definition primitive or registry — LangChain `tool()` owns this.
- Context summarization/trimming — LangChain middleware owns this.
- Session or message-history storage — LangGraph checkpoints own this.
- UI components, a chat surface, or a React hook — Assistant UI / LangGraph SDK.
- **Authorization policy** — the application's job (§2).
- Identity, tenancy, secrets, billing, hosting.
- A hosted platform, marketplace, or visual builder.

### 3.3 Scope guardrails (any feature must pass all four)

1. Does LangGraph/LangChain already do it? → Do not build it; preset or forward.
2. Does it require AgentDock to own durable state? → Reject.
3. Does it fit the serving/utility layers only? → If it needs an agent loop or a
   data model of its own, it is out of scope.
4. Does it remove **real** code versus the pure-LangGraph baseline (§7)? → If
   not, it is out of scope.

### 3.4 Definition of done for V1

- A user can go from a compiled LangGraph graph to a working streaming HTTP
  endpoint in **one file**.
- One example runs end to end against a real model and a real checkpointer, with
  an interrupt → resume round trip.
- The serving layer owns the six error-prone concerns (SSE headers, framing,
  backpressure, disconnect→abort, error frame, cleanup).
- The removal list in §4 is complete, and the deleted packages are deprecated
  **at release** with migration notes.

---

## 4. What to remove

### `agentdock/` (core workspace)

- **Packages:** `checkpoint`, `checkpoint-postgres`, `checkpoint-sqlite`,
  `checkpoint-mongodb`, `checkpoint-redis`, `models` — 1:1 duplicates of
  LangGraph savers / LangChain providers. Delete.
- **Core files:** `agent/context-management.ts`,
  `agent/context-message-window.ts`, `agent/context-policy.ts`, `agent/memory.ts`,
  `agent/permissions/types.ts`, `tools/define-tool.ts`, `tools/registry.ts`, and
  the empty placeholder dirs under `agent/` (`checkpoint/`, `runs/`, `sessions/`,
  `storage/`, `runtime/`).
- **Docs:** retire `AGENTDOCK_PRODUCT_DIRECTION.md` and
  `AGENTDOCK_CORE_PROTOCOL_FIXES.md`.

### `agentdock-cli/`

- Keep as a **demo/dev harness only** — re-pointed at `serveAgent`.

### `agentdock-starter/`

- Empty placeholder (only `.git`). Decide: retire, or make it the end-to-end
  example. Do not leave it ambiguous.

### `agentdock-ui/`

- **Retained, not removed.** Independent repo, out of this cleanup's deletion
  scope. Not forked from Assistant UI. Decided on its own, later.

---

## 5. What to keep (retain)

- **The serving layer** — to be built; the core deliverable.
- **The utility layer** — projection, JSON, signals.
- **The compatibility mapper** — LangGraph stream → the existing contract.
- **`contracts`** — trimmed only of provably-dead exports (§6).
- **The CLI** — as a demo consumer of the public API.
- **The docs site** — re-pointed at the new scope.
- **`agentdock-ui`** — retained, out of scope for deletion.

**On persistence:** durable state is **not** an AgentDock responsibility. It is
delegated to LangGraph checkpointers and stores, supplied by the application and
forwarded by AgentDock. The serving layer receives an already-compiled graph and
never configures a checkpointer.

---

## 6. Contracts cleanup (per-file verdict)

`@agentdock-ai/contracts` is the shared vocabulary between the backend and the
frontend. Keep the _idea_; trim the contents.

**Rule:** no export is removed while **any** consumer exists — including tests in
out-of-scope repos.

| File           | Verdict      | Reason                                                                               |
| -------------- | ------------ | ------------------------------------------------------------------------------------ |
| `json.ts`      | **Keep**     | Generic JSON types + validators.                                                     |
| `messages.ts`  | **Trim/cut** | Duplicates LangChain `BaseMessage`.                                                  |
| `tools.ts`     | **Trim**     | Cut `ToolSchema`; keep wire-minimum records if the mapper needs them.                |
| `runs.ts`      | **Trim**     | Keep a minimal run request + `AgentContext`. Cut `AgentResumeRequest`.               |
| `sessions.ts`  | **Cut**      | Mirrors LangGraph threads/checkpoints. Cut `AgentSessionHistoryEntry`.               |
| `approvals.ts` | **Cut**      | Duplicates interrupts; collapse at the boundary.                                     |
| `events.ts`    | **Keep**     | The event contract is consumed by `agentdock-ui/ui-core`; the reducer stays for now. |

Provably-dead exports to remove: `AgentResumeRequest`, `cloneJsonSchema`,
`AgentSessionHistoryEntry`. **Keep** `reduceAgentEvents` (external test consumer).

---

## 7. The pure-LangGraph baseline (no AgentDock packages)

The reference implementation and the comparison point for the Phase 0 value gate:

```ts
// deps: langchain, @langchain/langgraph, a checkpointer, zod
import { createAgent, tool } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import * as z from "zod";

const getWeather = tool(({ city }) => weatherApi.lookup(city), {
  name: "get_weather",
  description: "Get the current weather for a city.",
  schema: z.object({ city: z.string() }),
});

const agent = createAgent({
  model: "openrouter:z-ai/glm-5.2", // or a ChatModel instance
  tools: [getWeather],
  systemPrompt: "You are a helpful assistant.",
  checkpointer: new MemorySaver(), // application-owned
});

const config = { configurable: { thread_id: sessionId } };
for await (const chunk of await agent.stream(
  { messages: [{ role: "user", content: "Weather in Lahore?" }] },
  { ...config, streamMode: ["messages", "tools"] },
)) {
  // project chunk → SSE by hand
}
```

Everything here is stock LangChain/LangGraph. AgentDock adds **no** agent
primitive to this list — only the serving layer around it.

---

## 8. The serving API (V1)

`run` is the only input. The application produces it; AgentDock never parses HTTP.

```ts
type StartRun = {
  input: unknown;            // graph input, e.g. { messages: [...] }
  threadId: string;          // server-derived (never trusted from the client)
  context?: unknown;         // app data → LangGraph `context`
  signal?: AbortSignal;
};

type ResumeRun = {
  threadId: string;          // same thread as the interrupted run
  resume: unknown;           // opaque → new Command({ resume })
  context?: unknown;
  signal?: AbortSignal;
};

type Run = StartRun | ResumeRun;   // a run either starts or resumes

const runtime = serveAgent(graph);
runtime.stream(run): AsyncIterable<AgentEvent>   // engine, transport-free
runtime.pipe(res, run): Promise<void>            // node:http / Express res
runtime.toResponse(run): Promise<Response>       // Web / edge runtimes
```

```ts
// node:http facade — the application parses the request and derives identity
createServer((req, res) =>
  runtime.pipe(res, {
    input: { messages: [{ role: "user", content: message }] },
    threadId: deriveThreadId(req), // application-owned, server-derived
    context: { userId: authedUserId(req) }, // application-owned
  }),
).listen(3000);

// resume (opaque value decided by the graph / HITL middleware)
await runtime.pipe(res, {
  threadId,
  resume: { decisions: [{ type: "approve" }] },
});
```

`pipe` owns: SSE headers, `data:` framing, `drain` backpressure, `close`→abort, a
terminal error frame, and `end()`. **There is no `authorize` hook** — the
application authorizes access and passes trusted data via `context`.

**The value test:** AgentDock is worth its weight only if this API is meaningfully
smaller/clearer than the §7 baseline for the same result. The Phase 0 gate in the
plan makes that falsifiable.

---

## 9. Example, not a recipe

V1 ships **no recipes**. The ReAct agent is a documented example:

```ts
createAgent({
  model,
  tools,
  systemPrompt,
  checkpointer: saver ?? new MemorySaver(),
});
```

- The prompt is `createAgent({ systemPrompt })`. **Per-run prompt override is not
  in V1** — it is a LangChain middleware pattern we do not wrap.
- `Run.context` reaches nodes/tools via LangGraph's `runtime.context`; the example
  demonstrates this with a tool reading `context`.
- Human approval uses LangChain's `humanInTheLoopMiddleware` in the graph; the
  interrupt is consumed and resumed through the opaque `resume` value
  (`{ decisions: [{ type: "approve" }] }`).

---

## 10. Decisions

1. **Wire format: keep the existing contract.** `agentdock-ui/ui-core` consumes
   it; adopting an ecosystem format is deferred to a coordinated change.
2. **No recipes in V1.** Serving layer + one example.
3. **Serving shape:** `stream()` / `pipe(res)` / `toResponse()` over a single
   `Run`. No framework facades.
4. **Checkpointer:** application/example-owned; the serving layer never sets one.
5. **Authorization:** application-owned; no serving hook.
6. **Resume:** opaque value; AgentDock owns no approval protocol.
7. **Thread id:** server-derived; maps to `configurable.thread_id`.

---

## 11. Execution

See `AGENTDOCK_IMPLEMENTATION_PLAN.md` for the phase-by-phase plan. The Phase 0
value gate must pass **before** any deletion or deprecation.
