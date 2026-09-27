# ReAct server example

This is an application example, not an AgentDock recipe or shipped package. The
agent loop comes from LangChain `createAgent`; AgentDock only adapts its compiled
graph to the event stream.

Install these packages in the host application:

```bash
npm install @agentdock-ai/agentdock @agentdock-ai/contracts \
  @langchain/core @langchain/langgraph @langchain/openrouter langchain zod
npm install --save-dev tsx typescript @types/node
```

Set `OPENROUTER_API_KEY` and optionally `OPENROUTER_MODEL`, then run the server
from the repository root:

```bash
yarn example:serve
```

POST a start request to `/agent` with a client-generated conversation UUID and
message. To approve a `send_email` interrupt, make a second request with the
same conversation ID, `action: "resume"`, and a decision such as
`[{ "type": "approve" }]`. The handler derives the LangGraph thread ID from
server-side identity and the conversation ID on each request.

The example uses `MemorySaver`, which is suitable for local demonstration only:
it loses checkpoints when the process exits and is not shared by multiple
instances. Use a LangGraph saver backed by your production store for durable
resume. Replace the fixed demo identity and logging email adapter with your
authentication, authorization, and mail-delivery code before exposing this
server. The approval middleware is a workflow checkpoint, not authorization.
