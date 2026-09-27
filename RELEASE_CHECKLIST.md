# Serving release checklist

The `0.2.0` changesets and package changelogs are prepared locally. Publish only
after the changes are merged to `main` and the final CI check passes. The
repository's release workflow rejects tags whose commit is not on `main`.

Registry audit (2026-09-27) found versions `0.1.0` of `models`, `checkpoint`,
`checkpoint-postgres`, and `checkpoint-mongodb`; none had deprecation metadata.
The `checkpoint-sqlite` and `checkpoint-redis` names returned 404 and must not be
deprecated. Recheck the registry after publication before running the commands.

After the `@agentdock-ai/agentdock@0.2.0` serving release is published, deprecate
the four confirmed legacy package versions with the migration guide:

```bash
npm deprecate @agentdock-ai/models@0.1.0 \
  "Use a LangChain provider integration; migrate at https://agentdock-ai.vercel.app/docs/migration."
npm deprecate @agentdock-ai/checkpoint@0.1.0 \
  "Use LangGraph checkpointers directly; migrate at https://agentdock-ai.vercel.app/docs/migration."
npm deprecate @agentdock-ai/checkpoint-postgres@0.1.0 \
  "Use @langchain/langgraph-checkpoint-postgres; migrate at https://agentdock-ai.vercel.app/docs/migration."
npm deprecate @agentdock-ai/checkpoint-mongodb@0.1.0 \
  "Use @langchain/langgraph-checkpoint-mongodb; migrate at https://agentdock-ai.vercel.app/docs/migration."
```

The deprecations are version-scoped so the newly published serving API is not
marked deprecated. Do not deprecate names or versions that were not published.
