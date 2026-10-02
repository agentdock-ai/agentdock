# Native checkpoint ownership tests

These tests exercise ordinary LangGraph and LangChain state schemas without
requiring Agentdock fields. Direct native execution is the reference behavior.

## Invariants

- Native execution and execution through Agentdock produce the same application
  values, pending tasks, node effects, and checkpoint structure.
- Serving never calls `updateState()` or `bulkUpdateState()` to save event metadata.
- Hydration never writes or deletes checkpoints. Repeated reads preserve complete
  checkpoint history, including native pending writes and nested namespaces.
- Mutating returned client state or messages cannot alter saved native state.
- Ordinary custom fields, including an application-owned `agentEventState`, remain
  intact. Stale metadata from the deprecated schema cannot replace native interrupts.
- A different Agentdock instance, compiled graph, or OS process can resume using
  the same native checkpointer and thread ID.
- LangGraph owns retry policies, repeated interrupts, parallel task continuation,
  and resume commands. Application-owned effects occur according to native execution.

## Suites

| Suite                                                                              | Checks                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Native state parity](integration/native-state-parity.integration.test.mjs)        | 96 combinations: MemorySaver/SQLite, Zod/Annotation/legacy/application-owned fields, sync/async/exit durability, native/Agentdock starts and resumes. Every checkpoint boundary is compared with direct LangGraph execution. |
| [Checkpoint integrity](integration/checkpoint-integrity.integration.test.mjs)      | Read-only hydration, defensive copies, nested checkpoints, thread isolation, storage read failures, ephemeral context, exact command forwarding, native retries, and completion without a checkpointer.                      |
| [Agent schemas](integration/agent-schema.integration.test.mjs)                     | Native `createAgent` defaults and custom schemas, approve/edit/reject decisions, preserved business fields, message history, side effects, and SQLite partial Send continuations.                                            |
| [Process restart](e2e/checkpoint-restart.e2e.test.mjs)                             | Nine cases with separate Node processes and a real SQLite file. Checks cold hydration, native/Agentdock interchange, repeated interrupt IDs, saved resume counts, and the application effect after both answers.             |
| [Existing native regressions](integration/round2-regressions.integration.test.mjs) | Failure/cancellation recovery, historical checkpoints, response schemas, cache hits, static breakpoints, native tool identity, and parallel child graphs.                                                                    |

The process fixture imports the built package, so build before running it alone:

```sh
yarn build
yarn workspace @agentdock-ai/agentdock test:integration
yarn workspace @agentdock-ai/agentdock test:e2e
```

Run formatting, types, builds, every test, and coverage with `yarn ci`.

The native SQLite saver is a development dependency of the private workspace.
The published serving package has no SQLite dependency or saver lifecycle code.
These tests use the locked framework versions and native MemorySaver/SQLite.
Chat-model responses are scripted fixtures; external providers and other database
backends are not exercised by these suites.
