# Phase 0 — AgentDock Serving Value Spike

**Result: PASS — Phase 1 cleanup gate cleared.**

The Node serving prototype reduces the application route and passes the tested
transport checks. The start → interrupt → resume event sequence now passes the
existing `AgentEvent` reducer across separate requests when a graph opts into
`agentEventStateSchema`. The schema is checkpoint-backed; the spike uses no
process-local AgentDock session state and adds no fields to the public `Run`
type. The serving API remains a test-local prototype, not a product API.

## Side-by-side examples

Both routes use this exact application setup. `resolveRun` represents the same
request parsing, authentication, trusted context, and server-derived thread ID
in each example.

```ts
const agent = createAgent({
  model: scriptedModel,
  tools: [approvalGatedSend],
  middleware: [humanInTheLoopMiddleware({ interruptOn: { send: true } })],
  checkpointer: new MemorySaver(),
});

async function resolveRun(req) {
  const body = await readJson(req);
  const user = await authenticate(req);
  const threadId = await deriveThreadId(user.id, body.conversationId);
  const common = { threadId, context: { userId: user.id } };
  return body.approval
    ? { ...common, resume: body.approval }
    : {
        ...common,
        input: { messages: [{ role: "user", content: body.message }] },
      };
}
```

### Hand-written LangGraph HTTP/SSE route

```ts
createServer(async (req, res) => {
  const run = await resolveRun(req);
  const abort = new AbortController();
  const onClose = () => abort.abort(new Error("client disconnected"));
  const write = async (event) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    if (!res.write(frame)) await once(res, "drain");
  };
  res.on("close", onClose);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  try {
    const input =
      "resume" in run ? new Command({ resume: run.resume }) : run.input;
    const chunks = await agent.stream(input, {
      configurable: { thread_id: run.threadId },
      context: run.context,
      signal: abort.signal,
      streamMode: ["messages", "tools", "updates"],
    });
    for await (const [mode, chunk] of chunks) {
      const event = projectLangGraphChunk(mode, chunk);
      if (event) await write(event);
    }
  } catch (error) {
    if (!res.destroyed)
      await write({ type: "run.failed", message: String(error) });
  } finally {
    res.off("close", onClose);
    res.end();
  }
}).listen(3000);
```

### AgentDock route

```ts
const runtime = serveAgent(agent);
createServer(async (req, res) => {
  const run = await resolveRun(req);
  await runtime.pipe(res, run);
}).listen(3000);
```

**Line counts:** hand-written route 27 lines; AgentDock route 5 lines (at the
5-line bar). Including the shared 15 nonblank lines of request/agent setup in
each example: 42 lines versus 20 lines. Counts exclude blank lines, code-fence
delimiters, imports, and the application-provided `projectLangGraphChunk` mapper. The
candidate surface is exactly four functions: `serveAgent`, `stream`, `pipe`, and
`toResponse`; Web `toResponse` behavior was not implemented or evaluated in this
Node-only phase.

## Verification

| Check                                                | Result | Evidence                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate API surface ≤ 4 functions                  | PASS   | Four names counted above; `toResponse` is a deferred stub.                                                                                                                                                                                                                  |
| SSE headers and framing                              | PASS   | Node response harness verified `text/event-stream` and `data:` frames.                                                                                                                                                                                                      |
| Backpressure                                         | PASS   | After `write()` returned `false`, the next event was not written until `drain`.                                                                                                                                                                                             |
| Disconnect cancellation and cleanup                  | PASS   | Disconnect aborted the cooperative tool; `close` listener was removed and `end()` ran once.                                                                                                                                                                                 |
| Terminal error and response ending                   | PASS   | Graph failure produced a framed `run.failed` event and one response end.                                                                                                                                                                                                    |
| HITL side effect gated by approval                   | PASS   | Scripted `createAgent`, `MemorySaver`, and approval middleware: first request interrupted with no side effect; second request resumed the same thread and ran the side effect once.                                                                                         |
| Existing event contract across start/resume requests | PASS   | `test/unit/event-state.test.mjs` composes the schema with `createAgent`, pauses at approval, persists run identity/sequence before delivering the interrupt, creates a fresh serving runtime for resume on the same thread, and reduces the combined sequence successfully. |

The runnable spike used the existing scripted model, tool-call chunk, cooperative
abort, and memory-checkpointer fixtures. It exercised the two HITL requests via
separate calls to `pipe()`. No external model credentials were used.

Verification after the event-state extension: `yarn workspace
@agentdock-ai/agentdock test` passed, including 146 unit tests and 4 integration
tests. The dedicated event-state tests cover schema composition, interrupt
persistence, runtime recreation, resume sequence continuity, side-effect
gating, and reducer compatibility.

## Gate decision

The narrow checkpoint-backed state extension resolves the gate. Graph authors
must compose `agentEventStateSchema` into their graph state when they need the
compatibility event mapper's start/resume continuity. Phase 1 cleanup may
proceed; future serving behavior still needs to become a product API only if a
later phase establishes that its value justifies owning that layer.
