import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { agentEventStateSchema, serveAgent } from "../../src/index.js";

const graph = new StateGraph(
  new StateSchema({
    value: z.string().default(""),
    ...agentEventStateSchema.fields,
  }),
)
  .addNode("finish", () => ({ value: "done" }))
  .addEdge(START, "finish")
  .addEdge("finish", END)
  .compile();

const runtime = serveAgent(graph);
const start = runtime.stream({
  threadId: "type-test-thread",
  input: { value: "hello" },
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
// @ts-expect-error A run requires exactly one of input or resume.
runtime.stream({ threadId: "type-test-thread" });
// @ts-expect-error Resume does not accept start input.
runtime.stream({ threadId: "type-test-thread", input: { value: "x" }, resume: {} });
