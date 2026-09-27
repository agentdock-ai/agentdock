import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { agentEventStateSchema, serveAgent } from "../../src/index.js";

const schema = new StateSchema({
  value: z.string().default(""),
  ...agentEventStateSchema.shape,
});
const graph = new StateGraph({
  state: schema,
  input: new StateSchema({
    value: z.string().default(""),
    ...agentEventStateSchema.shape,
  }),
  context: z.object({ tenantId: z.string() }),
})
  .addNode("finish", () => ({ value: "done" }))
  .addEdge(START, "finish")
  .addEdge("finish", END)
  .compile();

const runtime = serveAgent(graph);
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
});

void start;
void resume;
void response;

// @ts-expect-error Start input retains the graph's state type.
runtime.stream({ threadId: "type-test-thread", input: { value: 42 } });
// @ts-expect-error Context inference rejects a non-string tenant.
const invalidContext: { tenantId: string } = { tenantId: 42 };
runtime.stream({
  threadId: "type-test-thread",
  input: { value: "x" },
  context: invalidContext,
});
// @ts-expect-error A run requires exactly one of input or resume.
runtime.stream({ threadId: "type-test-thread" });
// @ts-expect-error Resume does not accept start input.
runtime.stream({
  threadId: "type-test-thread",
  input: { value: "x" },
  resume: {},
});
