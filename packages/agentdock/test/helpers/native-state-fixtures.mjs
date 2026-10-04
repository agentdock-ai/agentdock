import assert from "node:assert/strict";
import {
  Annotation,
  StateGraph,
  StateSchema,
  START,
  END,
  interrupt,
} from "@langchain/langgraph";
import { z } from "zod";
import {
  createAgentReducerState,
  reduceAgentEvent,
} from "@agentdock-ai/contracts";

export const threadConfig = (threadId, options = {}) => ({
  ...options,
  configurable: { ...options.configurable, thread_id: threadId },
});

export async function collectEvents(source) {
  const events = [];
  for await (const event of source) events.push(event);
  return events;
}

export const reduceEvents = (events, seed = createAgentReducerState()) =>
  events.reduce(reduceAgentEvent, seed);

export function workflowInput(schema) {
  const input = {
    business: { owner: "owner", labels: ["keep"] },
    answers: [],
    total: 0,
  };
  if (schema === "application-field")
    input.agentEventState = {
      businessLabel: "application-owned",
      entries: [1, 2],
    };
  return input;
}

export function createSchemaWorkflow(saver, schema, effects = []) {
  const fields = {
    business: z
      .object({ owner: z.string(), labels: z.array(z.string()) })
      .strict(),
    answers: z.array(z.unknown()),
    total: z.number(),
  };
  let state;
  if (schema === "annotation")
    state = Annotation.Root({
      business: Annotation(),
      answers: Annotation(),
      total: Annotation(),
    });
  else {
    if (schema === "application-field")
      fields.agentEventState = z
        .object({ businessLabel: z.string(), entries: z.array(z.number()) })
        .strict();
    state = new StateSchema(fields);
  }
  const keys = Object.keys(workflowInput(schema)).sort();
  return new StateGraph(state)
    .addNode("prepare", (value) => {
      assert.deepEqual(Object.keys(value).sort(), keys);
      effects.push({ node: "prepare", business: value.business });
      return { total: value.total + 1 };
    })
    .addNode("ask", (value) => {
      assert.deepEqual(Object.keys(value).sort(), keys);
      effects.push({ node: "ask", total: value.total });
      const first = interrupt({ prompt: "First?", details: value.business });
      const second = interrupt({ prompt: "Second?", details: value.business });
      effects.push({ node: "approved", answers: [first, second] });
      return { answers: [first, second] };
    })
    .addNode("finish", (value) => {
      effects.push({ node: "finish", answers: value.answers });
      return { total: value.total + 1 };
    })
    .addEdge(START, "prepare")
    .addEdge("prepare", "ask")
    .addEdge("ask", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer: saver });
}

export function forbidServingWrites(graph) {
  const attempted = [];
  for (const name of ["updateState", "bulkUpdateState"])
    graph[name] = () => {
      attempted.push(name);
      throw new Error(`Serving called ${name}`);
    };
  return () => assert.deepEqual(attempted, []);
}

export async function checkpointDigest(saver, config) {
  const tuples = [];
  for await (const tuple of saver.list(config)) tuples.push(tuple);
  return JSON.stringify(
    tuples.sort((a, b) =>
      JSON.stringify(a.config).localeCompare(JSON.stringify(b.config)),
    ),
  );
}

export async function checkpointShape(saver, config) {
  const checkpoints = [];
  for await (const tuple of saver.list(config))
    checkpoints.push({
      source: tuple.metadata.source,
      step: tuple.metadata.step,
      channels: Object.keys(tuple.checkpoint.channel_values).sort(),
      writeChannels: (tuple.pendingWrites ?? [])
        .map(([, channel]) => channel)
        .sort(),
    });
  return checkpoints.sort((a, b) => a.step - b.step);
}

export function controlShape(snapshot) {
  return {
    values: snapshot.values,
    next: snapshot.next,
    tasks: snapshot.tasks.map((task) => ({
      name: task.name,
      interrupts: task.interrupts.map(({ value, response_schema }) => ({
        value,
        response_schema,
      })),
      error: task.error,
    })),
  };
}
