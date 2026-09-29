# Agentdock Core Instructions

- Agentdock is a thin TypeScript serving adapter for compiled LangGraph graphs. Its goal is to make a graph straightforward to expose over HTTP/SSE with reliable cancellation, backpressure, event mapping, and cleanup.
- Keep LangGraph and LangChain as execution authorities. They own agent loops, tools, models, checkpoints, interrupts, and resume behavior. The application owns request parsing, authentication, authorization, identity, secrets, side effects, and saver lifecycle.
- Keep Agentdock limited to serving, the compatibility event mapper, and small serving utilities. Prebuilt agents, recipes, graph/workflow engines, provider or saver wrappers, session storage, authorization, and UI features are out of scope.
- `AGENTDOCK_SCOPE.md` defines product boundaries. Follow it when evaluating changes; do not add framework functionality that LangGraph or LangChain already provides.
- Read and follow `CODE_STANDARDS.md` strictly for all code changes.
- Work in the core repository only. Do not push, publish, release, or deploy unless the user explicitly asks.
