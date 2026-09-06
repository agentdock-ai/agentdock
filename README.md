# AgentDock Monorepo

This repository contains the independently publishable AgentDock packages.

## Packages

- `agentdock` — core AgentDock runtime.
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

## Publishing

Package versions are managed with Changesets. Add a changeset for a publishable change:

```bash
yarn changeset
```

Publishing is not enabled yet. Changesets and the release scripts are prepared for a future npm publishing workflow, but no automatic publish job currently runs.
