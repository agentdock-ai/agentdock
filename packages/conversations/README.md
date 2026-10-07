# @agentdock-ai/conversations

Optional Node-side conversation persistence for Agentdock. It stores thread catalog records, ordered display messages, operation receipts, and attachment references in the LangGraph Store supplied by the application. It does not change checkpoints or run workflow nodes itself.

The current release profile is one execution-owning backend process. A shared PostgresStore does not make concurrent workers safe: admission and cancellation are coordinated only inside the `ConversationService` instance.

```ts
const conversations = new ConversationService({
  runtime: agentdock, // compiled graph/checkpointer already configured
  store: postgresStore, // BaseStore, started by the application
  prepareInput: ({ prompt }) => ({
    messages: [{ role: "user", content: prompt }],
  }),
});

const handle = createConversationHttpHandler({
  service: conversations,
  resolveActor: (request) => requireAuthenticatedActor(request),
});
```

The host mounts the Fetch-compatible handler and owns authentication, authorization, Store/checkpointer lifecycle, graph compilation, file storage, and business side effects. Start and approval bodies are validated against `@agentdock-ai/contracts`; the actor is always supplied by `resolveActor`, never accepted from JSON.

The Store is not automatically started or stopped. Call `service.shutdown()` before closing host-owned resources. Do not run more than one execution-owning service against the same thread until a shared execution coordinator proves admission, cancellation routing, and native checkpoint writer fencing.

Settled operation receipts are retained for seven days with Store TTL support. Active and paused receipts do not expire. Each thread retains its latest operation independently of receipt expiry. The client does not automatically retry a request; if an outcome is uncertain, reload history and reconcile before taking another action. Hosts using a Store without per-item TTL should configure an equivalent seven-day expiration policy for settled operation records.

A producer owns execution and persistence independently of the HTTP consumer. Stop and shutdown wait for bounded durable settlement; failed settlement returns an error and uncertain native work remains reserved. After process loss, unfinished saved operations become uncertain rather than being automatically rerun. History uses a thread revision check and bounded retry when writes overlap. Catalog pages are live offset pages: refresh and deduplicate by thread ID; they are not snapshot pagination under concurrent changes.

## Verification

Run `yarn workspace @agentdock-ai/conversations test` for deterministic
Store/service tests. From the starter, set `AGENTDOCK_TEST_DATABASE_URL` to a
disposable database whose name includes `test`, then run `yarn test:db` for
PostgresStore/checkpointer persistence, migration, and separate-process native
approval recovery. Run `yarn test:load` for a bounded synthetic Store workload
and local latency/RSS measurements. These small local measurements are not a
production capacity claim. The packed check is
`yarn workspace @agentdock-ai/conversations test:packed`. It packs contracts,
Agentdock, and conversations, installs them into an isolated Node consumer,
typechecks the public API, and imports the package entry points. This check
requires npm registry access. In-memory tests alone do not prove crash
recovery.
