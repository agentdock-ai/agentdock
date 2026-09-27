# Serving release checklist

The `0.2.0` changesets and package changelogs are prepared locally. Publish only
after the changes are merged to `main` and the final CI check passes. The
repository's release workflow rejects tags whose commit is not on `main`.

After the `@agentdock-ai/agentdock@0.2.0` serving release is published, deprecate
the confirmed legacy package versions with migration guidance:

```bash
npm deprecate @agentdock-ai/models@0.1.0 \
  "Use a LangChain provider integration; see the AgentDock migration guide."
npm deprecate @agentdock-ai/checkpoint@0.1.0 \
  "Use LangGraph checkpointers directly; see the AgentDock migration guide."
npm deprecate @agentdock-ai/checkpoint-postgres@0.1.0 \
  "Use @langchain/langgraph-checkpoint-postgres; see the AgentDock migration guide."
npm deprecate @agentdock-ai/checkpoint-mongodb@0.1.0 \
  "Use @langchain/langgraph-checkpoint-mongodb; see the AgentDock migration guide."
```

The deprecations are version-scoped so the newly published serving API is not
marked deprecated. Recheck the registry before running these commands; do not
deprecate names or versions that were not published.
