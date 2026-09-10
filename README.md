# AgentDock Monorepo

This repository contains the independently publishable AgentDock packages.

## Packages

- `agentdock` — core AgentDock runtime.
- `@agentdock/contracts` — framework-independent frontend/backend contracts.
- `@agentdock/checkpoint` — shared checkpoint contract and memory adapter.
- `@agentdock/checkpoint-postgres` — PostgreSQL checkpoint adapter.
- `@agentdock/checkpoint-sqlite` — SQLite checkpoint adapter.
- `@agentdock/checkpoint-mongodb` — MongoDB checkpoint adapter.
- `@agentdock/checkpoint-redis` — Redis checkpoint adapter.
- `@agentdock/models` — optional model resolver.

The repository root is a private Yarn workspace manager. The CLI remains a separate project.

## Development

```bash
yarn install
yarn ci
```

Run a single package command with Yarn workspaces:

```bash
yarn workspace agentdock test
yarn workspace @agentdock/checkpoint build
```

## Reliability boundaries

AgentDock separates a logical run from its LangGraph execution phases. An approval
resume continues the same `runId`; results and persisted tool records are merged
across every phase and restart. A session may have only one active logical run.

Use `sessionNamespace` when one checkpointer serves multiple tenants. The namespace
is part of the checkpoint thread key, so equal session IDs in different namespaces do
not share model-visible history. Host ownership and tenant authorization metadata
remain outside AgentDock.

Contexts, tool inputs and outputs, event payloads, and persisted AgentDock metadata
must be strict JSON. Side-effecting tools should be idempotent because a process or
distributed coordinator cannot undo an external side effect after a crash.

Messages and final run content use one `ContentPart[]` representation. Text,
reasoning, images, audio, video, files, citations, finalized tool calls, tool results,
and provider-specific JSON therefore survive streaming, checkpoint restart, and
session reconstruction without being flattened to strings.

Tool timeouts abort cooperative tools and also return by a hard deadline for tools
that ignore the signal. An ignored signal can leave an external side effect running;
`tool_timeout` does not claim that the external operation stopped. Shutdown is
bounded with `await dock.close({ gracePeriodMs: 5_000 })`. The optional
`RunCoordinator` interface can provide distributed session locking; the default
coordinator protects runs in the current process.

Every event carries `protocolVersion`, event/run/session/phase IDs, and both phase
and logical-run sequence numbers. There is one `stream()` API and one event union;
there are no version-suffixed stream paths.

## Publishing

Package versions are managed with Changesets. Add a changeset for a publishable change:

```bash
yarn changeset
```

Publishing is not enabled yet. Changesets and the release scripts are prepared for a future npm publishing workflow, but no automatic publish job currently runs.
