# `@agentdock-ai/agentdock-http`

HTTP routes and Node adapters for an `Agentdock` instance.

```ts
import { Agentdock } from "@agentdock-ai/agentdock";
import { AgentdockServer } from "@agentdock-ai/agentdock-http";

const agent = new Agentdock(graph);
const server = new AgentdockServer({
  agent,
  basePath: "/agent",
  authorize: async (request, threadId) => {
    const user = await authenticate(request);
    if (!user || !(await canAccessThread(user, threadId))) return null;
    return { context: { userId: user.id } };
  },
});

export const GET = server.toHttp();
export const POST = server.toHttp();
```

The server provides run, resume, message, resume-state, and optional thread-list
routes under `basePath`. Supply `threads.listThreads` to enable `GET /threads`.
The application remains responsible for authentication, thread ownership, and
the list of threads available to each user.

For Node HTTP servers, Express, or a raw Fastify response, use
`server.toNode()`. For Web-standard servers, use `server.toHttp()`.
