# Agentdock Core Instructions

- Agentdock is a thin TypeScript adapter serving compiled LangGraph graphs through event streams, Node HTTP/SSE, and Web Responses. It owns event mapping, cancellation, backpressure, transport cleanup, and read-only checkpoint control-state projection.
- LangGraph/LangChain own execution, tools, models, retries, checkpoints, interrupts, and resume behavior. Applications own request parsing, auth, identity, context, secrets, side effects, and checkpointer lifecycle. Graph schemas stay application-owned; serving must not add state fields or write event bookkeeping to checkpoints.
- Keep shared JSON contracts, validation, and event reduction in `@agentdock-ai/contracts`; keep framework and HTTP dependencies out. Map tool lifecycle through the native callback observer and execution identity.
- Keep the existing serving package limited to serving and small utilities. The optional `@agentdock-ai/conversations` package owns durable conversation records and reusable conversation HTTP integration; it must not become a workflow engine or write bookkeeping into checkpoints. No provider/saver wrappers, business authorization, browser UI, alternate serving protocols, or deprecated serving APIs.
- Follow `CODE_STANDARDS.md` for code changes. Work in this repository; do not push, publish, release, or deploy unless explicitly asked.
