# AgentDock Monorepo

This repository contains the independently publishable AgentDock packages.

## Packages

- `@agentdock-ai/agentdock` — core AgentDock runtime.
- `@agentdock-ai/contracts` — framework-independent frontend/backend contracts.
- `@agentdock-ai/checkpoint` — shared checkpoint contract and memory adapter.
- `@agentdock-ai/checkpoint-postgres` — PostgreSQL checkpoint adapter.
- `@agentdock-ai/checkpoint-sqlite` — SQLite checkpoint adapter.
- `@agentdock-ai/checkpoint-mongodb` — MongoDB checkpoint adapter.
- `@agentdock-ai/checkpoint-redis` — Redis checkpoint adapter.
- `@agentdock-ai/models` — optional model resolver.

## Development

```bash
yarn install
yarn ci
```

Run a single package command with Yarn workspaces:

```bash
yarn workspace @agentdock-ai/agentdock test
yarn test:coverage
yarn workspace @agentdock-ai/checkpoint build
```

## Publishing

Package versions are managed with Changesets. Add a changeset for a publishable change:

```bash
yarn changeset
```

Publishing is not enabled yet. Changesets and the release scripts are prepared for a future npm publishing workflow, but no automatic publish job currently runs.
