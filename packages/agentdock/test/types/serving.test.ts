import { Command, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { Agentdock } from "../../src/index.js";

const schema = z.object({ value: z.string().default("") });
const composedSchema = schema;
const graph = new StateGraph({
  state: schema,
  input: schema,
  context: z.object({ tenantId: z.string() }),
})
  .addNode("finish", () => ({ value: "done" }))
  .addEdge(START, "finish")
  .addEdge("finish", END)
  .compile();

const runtime = new Agentdock(graph);
const start = runtime.stream({
  threadId: "type-test-thread",
  input: { value: "hello" },
  context: { tenantId: "tenant-a" },
});
const resume = runtime.stream({
  threadId: "type-test-thread",
  resume: { decisions: [{ type: "approve" }] },
});
const response = runtime.toResponse({
  threadId: "type-test-thread",
  input: { value: "hello" },
  config: {
    configurable: { tenantId: "tenant-a" },
    tags: ["http-request"],
    metadata: { requestId: "req-1" },
  },
});
const resumeResult = runtime.getResumeState("type-test-thread");

void start;
void resume;
void response;
void composedSchema;
void resumeResult;

// @ts-expect-error Start input retains the graph's state type.
runtime.stream({ threadId: "type-test-thread", input: { value: 42 } });
runtime.stream({
  threadId: "t",
  input: { value: "x" },
  // @ts-expect-error Context inference rejects a non-string tenant.
  context: { tenantId: 42 },
});
// @ts-expect-error A run requires exactly one of input or resume.
runtime.stream({ threadId: "type-test-thread" });
// @ts-expect-error Resume does not accept start input.
runtime.stream({
  threadId: "type-test-thread",
  input: { value: "x" },
  resume: {},
});

runtime.stream({ threadId: "t", continue: true });
runtime.stream({
  threadId: "t",
  input: { value: "x" },
  config: { subgraphs: true, durability: "exit", interruptBefore: ["finish"] },
});
// @ts-expect-error Static continuation does not also accept a resume value.
runtime.stream({ threadId: "t", continue: true, resume: {} });
runtime.stream({
  threadId: "t",
  input: { value: "x" },
  // @ts-expect-error Agentdock owns stream encoding.
  config: { encoding: "text/event-stream" },
});
runtime.stream({
  threadId: "t",
  input: { value: "x" },
  // @ts-expect-error Agentdock owns the abort signal outside graph config.
  config: { signal: new AbortController().signal },
});

runtime.stream({
  threadId: "t",
  input: new Command({
    resume: { approved: true },
    update: { value: "changed" },
  }),
});
runtime.stream({ threadId: "t", input: null });
new Agentdock(graph, { interruptFormat: "langchain-hitl" });
// @ts-expect-error Only supported interrupt display formats are accepted.
new Agentdock(graph, { interruptFormat: "automatic" });
