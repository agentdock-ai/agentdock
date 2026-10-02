import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import {
  Command,
  StateGraph,
  StateSchema,
  START,
  END,
  interrupt,
} from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { z } from "zod";
import { Agentdock } from "../../dist/index.js";

const [database, threadId, durability, mode, action, serializedAnswer] =
  process.argv.slice(2);
const saver = SqliteSaver.fromConnString(database);
try {
  const graph = new StateGraph(
    new StateSchema({ answers: z.array(z.string()), executions: z.number() }),
  )
    .addNode("ask", () => {
      const first = interrupt("First?");
      const second = interrupt("Second?");
      return { answers: [first, second] };
    })
    .addNode("commit", (state) => {
      appendFileSync(`${database}.effects`, "committed\n");
      return { executions: state.executions + 1 };
    })
    .addEdge(START, "ask")
    .addEdge("ask", "commit")
    .addEdge("commit", END)
    .compile({ checkpointer: saver });
  for (const name of ["updateState", "bulkUpdateState"])
    graph[name] = () => {
      throw new Error(`Unexpected serving ${name}`);
    };
  const config = { configurable: { thread_id: threadId }, durability };
  const runtime = new Agentdock(graph);
  const events = [];
  if (action !== "read") {
    const input = { answers: [], executions: 0 };
    const answer =
      action === "resume" ? JSON.parse(serializedAnswer) : undefined;
    if (mode === "native")
      await graph.invoke(
        action === "start" ? input : new Command({ resume: answer }),
        config,
      );
    else
      for await (const event of runtime.stream(
        action === "start"
          ? { threadId, input, config: { durability } }
          : { threadId, resume: answer, config: { durability } },
      ))
        events.push(event);
  }
  const digest = async () => {
    const tuples = [];
    for await (const tuple of saver.list(config)) tuples.push(tuple);
    return JSON.stringify(tuples);
  };
  const before = await digest();
  const seed = await runtime.getResumeState(threadId);
  const after = await digest();
  assert.equal(after, before);
  const snapshot = await graph.getState(config);
  assert.equal("agentEventState" in snapshot.values, false);
  console.log(
    JSON.stringify({
      pid: process.pid,
      events,
      seed,
      snapshot,
      checkpointDigest: after,
    }),
  );
} finally {
  saver.db.close();
}
