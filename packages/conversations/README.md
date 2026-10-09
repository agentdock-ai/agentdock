# @agentdock-ai/conversations

Optional Node-side conversation persistence for Agentdock. It stores thread catalog records, ordered display messages, operation receipts, and attachment references in the LangGraph Store supplied by the application. It does not change checkpoints or run workflow nodes itself.

The current release profile is one execution-owning backend process. A shared PostgresStore does not make concurrent workers safe: admission and cancellation are coordinated only inside the `ConversationService` instance.

```ts
import {
  ConversationService,
  createConversationHttpHandler,
  createPostgresConversationFileStorage,
  createPostgresConversationStore,
} from "@agentdock-ai/conversations";

await postgresStore.setup(); // application-owned native LangGraph PostgresStore
const store = await createPostgresConversationStore(
  postgresStore,
  pool,
  "agentdock_store",
);
const fileStorage = await createPostgresConversationFileStorage(pool);
const conversations = new ConversationService({
  runtime: agentdock, // compiled graph/checkpointer already configured
  store, // ordered catalog adapter over the application-owned Store
  fileStorage,
  prepareInput: ({ prompt }) => ({
    messages: [{ role: "user", content: prompt }],
  }),
});

const handle = createConversationHttpHandler({
  service: conversations,
  resolveActor: (request) => requireAuthenticatedActor(request),
});
```

The handler serves its OpenAPI document at `GET /openapi.json` and interactive
Swagger UI at `GET /docs`, alongside the conversation routes below. The docs
describe this package's HTTP API only; host application routes are not included.
Swagger UI loads its static assets from jsDelivr, so the browser needs internet
access to render `/docs`.

Forward requests for `/openapi.json`, `/docs`, and `/conversations/...` to the
handler. In an Express server, mount the Node adapter at the application root
so all three paths reach it. The starter demonstrates this setup.

The host mounts the Fetch-compatible handler and owns authentication, authorization, Store/checkpointer lifecycle, graph compilation, file storage, and business side effects. Start and approval bodies are validated against `@agentdock-ai/contracts`; the actor is always supplied by `resolveActor`, never accepted from JSON.

Thread listing requires an explicit `searchThreads(namespace, limit, offset)` capability that orders by canonical UTC `updatedAt` descending, then ID ascending, **before** pagination. `createPostgresConversationStore` supplies a bounded SQL query and a catalog index on the native PostgresStore table; call it after native Store setup, with the same schema and a host-owned query client. The host owns credentials, connections and index installation permissions. It does not add conversation tables or change checkpoints. Other backends can supply the same capability rather than silently sorting a partial generic Store page.

For development and tests, `createInMemoryConversationStore()` supplies the same ordering contract. Its sort runs over records already held in memory; PostgreSQL catalog requests do not load the entire catalog into the backend process. A plain native Store remains usable for record CRUD, but listing fails clearly without the ordered capability.

The Store is not automatically started or stopped. Call `service.shutdown()` before closing host-owned resources. Do not run more than one execution-owning service against the same thread until a shared execution coordinator proves admission, cancellation routing, and native checkpoint writer fencing.

Settled operation receipts are retained for seven days with Store TTL support. Active and paused receipts do not expire. Each thread retains its latest operation independently of receipt expiry. The client does not automatically retry a request; if an outcome is uncertain, reload history and reconcile before taking another action. Hosts using a Store without per-item TTL should configure an equivalent seven-day expiration policy for settled operation records.

Records are validated and saved as independent snapshots, so mutating a caller object cannot alter persisted state without a confirmed write. A failed thread write does not advance the caller's revision. Known failures before native execution are settled as errors and allow a fresh operation ID once storage recovers. Failed recovery still returns an error; native execution failures remain subject to uncertainty and are never automatically replayed.

File bytes use the host's `ConversationFileStorage` adapter, including S3 or another object store if desired. `createPostgresConversationFileStorage` provides a PostgreSQL implementation over the host's query client; it creates a `public.agentdock_conversation_files` table by default. Pass `schema` and `table` options to select another SQL identifier. Deletion confirms byte cleanup before removing its reference. The adapter's `delete` must be idempotent: deleting an absent object succeeds, allowing retry after a metadata deletion failure. Upload persistence failures attempt byte cleanup and report cleanup failure rather than claiming success.

A producer owns execution and persistence independently of the HTTP consumer. Stop and shutdown wait for bounded durable settlement; failed settlement returns an error and uncertain native work remains reserved. After process loss, unfinished saved operations become uncertain rather than being automatically rerun. History uses a thread revision check and bounded retry when writes overlap. Catalog pages are live offset pages: refresh and deduplicate by thread ID; they are not snapshot pagination under concurrent changes.

## Verification

Run `yarn workspace @agentdock-ai/conversations test` for deterministic
Store/service tests. Typechecking includes test files, and coverage enforces package floors plus stricter service/record floors. Set `AGENTDOCK_TEST_DATABASE_URL` to a disposable database whose name includes `test`. Run `yarn workspace @agentdock-ai/conversations test:db` for the shared memory/Postgres record contract (an isolated test schema is removed afterward). From the starter, run `yarn test:db` for
PostgresStore/checkpointer persistence, migration, and separate-process native
approval recovery. Run `yarn test:load` for a bounded synthetic Store workload
and local latency/RSS measurements. These small local measurements are not a
production capacity claim. The packed check is
`yarn workspace @agentdock-ai/conversations test:packed`. It packs contracts,
Agentdock, and conversations, installs them into an isolated Node consumer,
typechecks the public API, and imports the package entry points. This check
requires npm registry access. In-memory tests alone do not prove crash
recovery.
