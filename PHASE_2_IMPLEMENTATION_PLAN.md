# Phase 2 — Production Serving Layer

Status: **Ready for implementation after the contract decisions below are
accepted.** This document covers Phase 2 only. It does not change product scope
or authorize implementation.

## Goal

Replace the legacy `AgentDock` execution framework with a small, production-
ready serving layer around an already-compiled LangGraph graph. AgentDock must
not own graph construction, model/tool loops, persistence drivers, session
storage, or authorization. The application supplies the graph, checkpointer,
authenticated `threadId`, context, and start/resume input.

The application-facing path remains:

```ts
const runtime = serveAgent(graph);
await runtime.pipe(response, run);
```

`runtime.stream(run)` is transport-free; `runtime.toResponse(run)` adapts the
same stream to Web `Response`/`ReadableStream`. The public API stays limited to
`serveAgent`, `stream`, `pipe`, and `toResponse`, plus types and the existing
event contract.

## Decisions required before implementation

### Run identity across approval resume

The current Phase 2 draft says resume gets a new `runId`. The Phase 0 gate and
the existing reducer instead require the interrupted operation and its resume
to retain the same `runId` and continue `logicalSequence`; the Phase 1
checkpoint-backed schema proves this across runtime recreation. **Phase 2 will
preserve the original `runId` across interrupt/resume** unless the reducer and
all UI consumers are deliberately changed in a separately reviewed protocol
version. Do not implement the new-run wording from the older draft.

Each HTTP request may have a distinct `phaseId`; `logicalSequence` remains
monotonic for the logical operation, and `sequence` is monotonic within a
phase. A later, independent start on the same thread creates a new `runId`.

### Opt-in checkpoint state

The existing event contract requires checkpoint-backed identity/sequence for a
resume. The graph must compose the exported `agentEventStateSchema` into its
state schema. This is a narrow graph-state extension, not an AgentDock session
store. The app still owns the saver and its lifecycle. A graph without this
extension may stream a start, but the runtime must reject an interrupt/resume
path with an actionable error rather than silently emit reducer-invalid
events. Verify the exact non-interrupt behavior against the event contract
before freezing this rule.

### Boundary ownership

- HTTP request parsing, authentication, authorization, tenant policy, thread ID
  derivation, and response status selection stay with the application.
- AgentDock receives a validated `Run` and forwards its `threadId`, `context`,
  `signal`, input, and opaque resume value to LangGraph.
- AgentDock never creates, initializes, closes, or stores a checkpointer.
- AgentDock does not add local maps, caches, run registries, or resume state.

## File and responsibility layout

Keep one concern per source file. Avoid a single serving file that owns graph
invocation, mapping, SSE framing, cancellation, and both transports. Do not make
separate files for one-line constants or private helpers that have no isolated
responsibility.

Proposed layout inside `packages/agentdock/src/`:

| File                       | Sole responsibility                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `serving/serve-agent.ts`   | Public factory; binds a compiled graph to the runtime methods.                                                                              |
| `serving/types.ts`         | Generic `Run`, `StartRun`, `ResumeRun`, runtime, and transport structural types.                                                            |
| `serving/stream.ts`        | Validates run shape, prepares LangGraph config, drives the graph stream, and coordinates cancellation.                                      |
| `serving/event-state.ts`   | Defines/reads/writes the opt-in checkpoint-backed event metadata. Keep the current schema here or move it without changing its public name. |
| `serving/to-wire-event.ts` | Projects one LangGraph chunk into zero or more contract events; owns only mapping state.                                                    |
| `serving/event-context.ts` | Creates per-request/per-logical-run event IDs and sequence counters; no process-persistent state.                                           |
| `serving/sse.ts`           | Encodes one `AgentEvent` as an SSE frame and defines the standard event-stream headers.                                                     |
| `serving/pipe.ts`          | Node/Express-compatible response writing, backpressure, disconnect handling, response end, and listener cleanup.                            |
| `serving/to-response.ts`   | Web `Response` and `ReadableStream` adaptation, including consumer cancellation.                                                            |
| `utils/abort-signal.ts`    | Composes signals with already-aborted handling and deterministic listener cleanup.                                                          |

If implementation shows `event-context.ts` has no independent responsibility,
keep that small state private to the mapper instead of splitting files merely
to satisfy a file count. Keep each public type next to its API or in
`serving/types.ts`; do not create a broad `common.ts` or `helpers.ts` bucket.

### Code standards

- Follow the workspace's strict TypeScript settings, including
  `noUnusedLocals`, `noUnusedParameters`, `NodeNext` resolution, and declaration
  generation. Public API types must compile from a consumer type test.
- Keep values from LangGraph's broad stream boundary typed as `unknown` until
  narrowed. Avoid `any`, unchecked casts, and duplicated vendor interfaces;
  isolate an unavoidable cast and explain it beside the cast.
- Use the existing `.mjs` + Vitest convention for runtime fixtures and `.ts`
  type tests. Keep one primary behavior under test per test file where that
  keeps setup and failures understandable.
- Format with the existing Prettier checks. The repo has no lint command today;
  do not introduce a lint tool as part of Phase 2 without a separate decision.
- Keep imports explicit with the repository's NodeNext `.js` specifiers in
  TypeScript source. Add dependencies only when runtime code directly imports
  them, and justify any new production dependency.
- Public methods document ownership, cancellation, and failure semantics. Avoid
  catching-and-ignoring errors, non-idempotent cleanup, module-level mutable
  state, and logs that expose request/context values.

Public exports come from the package root. Remove the old `./agent` and
`./tools` export paths only after in-repository and known external consumers are
migrated or explicitly accounted for. Keep the compatibility event contract
and reducer unchanged in this phase.

## Implementation sequence and gates

### 0. Freeze contracts and inventory consumers

1. Record the decisions above in the main implementation plan so it no longer
   conflicts with this document.
2. Inspect the installed LangGraph/LangChain type definitions for `streamMode`,
   message/tool/update chunk shapes, `Command`, graph state access, and abort
   semantics. Treat vendor types/runtime behavior as authoritative; do not
   invent chunk shapes from examples.
3. Search both workspace repositories and known UI consumers for imports from
   `AgentDock`, `ToolRegistry`, `defineTool`, `AgentDockEventType`, and removed
   export paths. Record required migrations before deleting any public export.
4. Confirm `agentEventStateSchema` composition works for `createAgent` and a
   general `StateGraph`; confirm the checkpointer retains the extension across
   separate requests and recreated runtimes.

**Gate:** no serving implementation or legacy deletion until the run-ID rule,
opt-in behavior, and event field mapping are agreed and typeable.

### 1. Define the minimal typed API

Implement the `Run` discriminated union so starts require `input`, resumes
require opaque `resume`, and both require a non-empty server-derived `threadId`.
Reject objects that provide both `input` and `resume`, neither, an empty thread
ID, or a malformed signal. Preserve inferred graph input/context types through
`serveAgent(graph)`; keep type assertions localized where vendor generic types
do not preserve inference.

Only expose run settings justified by the scope. If a recursion limit is
needed, define its default and validation in one place and forward it to
LangGraph. Do not add AgentDock-specific model, tool, authorization, or session
options. Document that the host must serialize overlapping runs for a shared
thread if its graph/checkpointer does not support that concurrency.

**Gate:** compile-time tests accept valid typed start/resume values and reject
invalid inputs without widening `input`/`context` to `any`.

### 2. Implement event-state lifecycle and mapper

Keep mapping deterministic and testable independently of HTTP:

1. A start allocates a `runId`, initializes `logicalSequence`, injects the
   opt-in state key into graph input, and emits `run.started` first.
2. A resume reads the saved event state by the same `thread_id`; it must find a
   pending interrupt and reuse the saved `runId`/sequence. Emit the matching
   `interrupt.resolved` exactly once for the accepted resume.
3. Map text only from `messages`, tool lifecycle only from `tools`, interrupt
   data from LangGraph updates, and run completion/failure/cancellation once.
   Never emit duplicate text/tool events from `updates`.
4. Increment `logicalSequence` for every mapped event and keep `sequence`
   monotonic within its documented phase. Generate unique `eventId`s and valid
   ISO timestamps.
5. On interrupt, persist `runId`, the sequence through `interrupt.required`,
   and `pendingInterruptId` to the graph checkpoint **before** yielding the
   interrupt event to the caller. Clear pending interrupt metadata after an
   accepted resume and persist terminal state as needed for correct subsequent
   starts.
6. Start a new independent operation on a completed thread with a new `runId`;
   do not mistake an old checkpointed event state for an active interrupt.
7. Validate mapped events with `reduceAgentEvent` in fixtures. Unknown vendor
   chunks must have an explicit policy: map supported content to `custom` or
   fail with a terminal error; never silently mislabel or duplicate content.

If LangGraph cannot persist the extension at the required ordering point without
modifying graph behavior, stop and revise the API/contract. Do not add a local
run registry or undocumented public `Run` fields to work around it.

**Gate:** separate start/resume requests using the existing reducer pass after
runtime recreation; malformed/missing checkpoint metadata fails clearly; side
effects run only after approval.

### 3. Implement cancellation and stream cleanup

`runtime.stream(run)` owns the graph iterator and merged abort signal. It must
handle a signal already aborted before iteration, caller abort during model or
tool execution, and consumer early exit (`break`/iterator `return`). In every
case, stop pulling chunks, abort cooperative work, call iterator cleanup when
available, and release signal listeners. Do not promise to stop uncooperative
tools; document LangGraph/tool cancellation requirements.

The abort helper must preserve the first meaningful abort reason, be safe when
either input signal is missing/already aborted, and remove all installed
listeners on completion, error, or cancellation.

**Gate:** tests prove abort propagation and cleanup on normal completion, graph
error, pre-aborted signal, mid-stream abort, and consumer early return.

### 4. Implement Node SSE `pipe`

Use a small structural response type that supports the actual needed Node HTTP
operations and cleanup (`writeHead`, `write`, `end`, `on`, and listener removal).
Do not import Express or framework types. The application chooses route,
authentication, status codes before calling `pipe`.

`pipe` must:

- set `text/event-stream`, no-cache, and proxy-buffering headers before output;
- encode contract events as valid `data: <JSON>\n\n` frames;
- await `drain` after `write()` returns `false`, while also waking on abort or
  disconnect so it cannot wait forever;
- abort graph work if the client disconnects before normal completion;
- distinguish normal response close from premature disconnect;
- send at most one terminal error event when the response is still writable;
- never attempt writes after disconnect or after a terminal event;
- call `end()` at most once and remove every response/signal listener in `finally`.

Do not leak stack traces, prompts, context, resume payloads, credentials, or
database errors into terminal events. Preserve a stable public error code and a
safe message. A disconnected client cannot receive a terminal event; abort and
cleanup are the required behavior in that case.

**Gate:** fake-response tests cover headers/framing, backpressure, drain-vs-close
race, disconnect, error after headers, error before output, single terminal
event, single end, and listener cleanup. At least one real `node:http` loopback
test confirms interoperability with `ServerResponse`.

### 5. Implement Web `toResponse`

Return a standard `Response` with the same SSE headers and frame bytes as
`pipe`. The `ReadableStream` must propagate producer failures consistently and
abort the graph when the consumer cancels the body. Merge, do not replace, the
caller-provided signal. Do not enqueue after cancellation or close/error the
controller more than once.

**Gate:** Web tests cover normal output, start/resume, cancel during a
cooperative tool, pre-aborted caller signal, graph failure, reader cancellation,
and cleanup. Compare the serialized event sequence with Node `pipe` for the same
fixture.

### 6. Migrate consumers, then remove the legacy runtime

1. Rewire the CLI as a demo consumer of `runtime.stream()` and keep its own
   provider, checkpoint, and database lifecycle ownership.
2. Move the ReAct/HITL demonstration to the planned example area; use
   `createAgent` and a scripted graph in automated tests. Do not ship a recipe or
   agent loop in the library.
3. Update docs and package exports to the new serving API. Explain server-owned
   thread IDs, graph schema opt-in, application-owned saver lifecycle, opaque
   resume values, and cancellation limits.
4. Only after CLI/example/build/tests pass, delete `AgentDock`,
   `ToolCallingWorkflow`, context-management files, `ToolRegistry`,
   `defineTool`, and now-unused legacy tests/types. Keep the contracts reducer
   and event types while `agentdock-ui` consumes them.
5. Search workspace sources, manifests, generated declarations, examples, and
   known external consumers again before removing old package subpath exports.
   Do not deprecate or publish packages in Phase 2; release/migration work stays
   in Phase 4.

**Gate:** the CLI and example use only the serving API and LangGraph/LangChain
primitives; no legacy execution symbols remain in shipped source or exports.

### 7. Verify package and support matrix

Run the full contract, type, unit, integration, build, and CLI suites. Add a
consumer type test that imports only the published package root and uses
`serveAgent`, `stream`, `pipe`, `toResponse`, and the event-state schema. Test
the minimum supported Node version (20) and the current supported LTS in CI;
include a browser/Web runtime test for `toResponse`. Run formatter, lint, and
`git diff --check` on all changed files.

The real-provider example is a manual opt-in smoke test requiring credentials;
it must not make CI network-dependent. Automated CI uses deterministic model/tool
fixtures. Verify package contents/exports with `yarn pack` so internal test files
and provider credentials cannot enter the published artifact. Use the existing
Prettier and strict TypeScript checks; Phase 2 does not add a new lint tool.

## Production acceptance checklist

Phase 2 is complete only when all items pass:

- [ ] Run identity semantics are consistent with the existing reducer and the
      Phase 0 gate; the main plan no longer says resume starts a new `runId`.
- [ ] Graph state opt-in is explicit, checkpoint-backed, and tested across
      fresh runtimes; AgentDock has no process-local run/session persistence.
- [ ] The runtime forwards exact graph input, context, opaque resume value,
      thread ID, and abort signal without taking over graph/checkpointer setup.
- [ ] Mapper fixtures cover every emitted contract event and reduce without
      throwing; duplicate and post-terminal events are rejected.
- [ ] Node and Web transports frame the same events, honor backpressure where
      applicable, abort on disconnect/cancel, and clean up deterministically.
- [ ] Errors are terminal, safe to expose, emitted once, and never mask a client
      disconnect or produce a second response end.
- [ ] Type inference, public exports, package contents, docs, and CLI migration
      match the minimal API; no agent loop, saver, provider, registry, or session
      framework remains in the library.
- [ ] Contract, AgentDock, CLI, build, format, Node/Web transport, and
      package-consumer checks are green.
- [ ] Legacy code is removed only after replacement consumers pass; published
      package deprecation is deferred to Phase 4.

## Stop conditions

Stop and return to product design if any of these occur:

- the existing UI reducer cannot accept the chosen start/interrupt/resume
  identity sequence without a contract change;
- a graph cannot compose/persist event metadata without AgentDock owning a
  separate durable store or mutating graph semantics;
- generic LangGraph stream chunks cannot be mapped honestly to the existing
  contract without duplicate or fabricated events;
- Node/Web cancellation or response cleanup cannot be made deterministic;
- the CLI needs the old agent/session framework to continue working; or
- the completed facade no longer clears Phase 0's value bar versus the
  hand-written LangGraph endpoint.

In any stop case, keep the old runtime intact, preserve the failing fixture and
report, and do not delete legacy execution code.
