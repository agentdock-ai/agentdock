import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import {
  agentEventStateSchema,
  Agentdock,
  createResumeState,
  withAgentEventState,
} from "../../src/index.js";

const schema = new StateSchema({
  value: z.string().default(""),
  ...agentEventStateSchema.shape,
});
const composedSchema = withAgentEventState({ value: z.string().default("") });
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
const resumeResult = createResumeState(
  {
    agentdockEventState: {
      runId: "run-1",
      logicalSequence: 3,
      pendingInterruptId: "interrupt-1",
      pendingInterrupt: {
        kind: "custom",
        interruptId: "interrupt-1",
        prompt: "Continue?",
        actions: [],
      },
    },
  },
  "type-test-thread",
);

void start;
void resume;
void response;
void composedSchema;
void resumeResult;

// @ts-expect-error Agentdock owns this field in composed state schemas.
withAgentEventState({ agentdockEventState: z.string() });

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
