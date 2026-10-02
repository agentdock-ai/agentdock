import assert from "node:assert/strict";
import { test } from "vitest";
import { Command } from "@langchain/langgraph";
import { Agentdock } from "../../src/index.js";
import {
  checkpointDigest,
  checkpointShape,
  collectEvents,
  controlShape,
  createSchemaWorkflow,
  forbidServingWrites,
  reduceEvents,
  threadConfig,
  workflowInput,
} from "../helpers/native-state-fixtures.mjs";
import { createCheckpointStores } from "../helpers/checkpoint-stores.mjs";

const cases = ["memory", "sqlite"].flatMap((backend) =>
  ["zod", "annotation", "legacy", "application-field"].flatMap((schema) =>
    ["sync", "async", "exit"].flatMap((durability) =>
      ["native", "adapter"].flatMap((start) =>
        ["native", "adapter"].map((resume) => ({
          backend,
          schema,
          durability,
          start,
          resume,
        })),
      ),
    ),
  ),
);

test.each(cases)(
  "native state parity: $backend / $schema / $durability / $start start / $resume resume",
  async ({ backend, schema, durability, start, resume }) => {
    const stores = await createCheckpointStores(backend);
    const { referenceSaver, actualSaver } = stores;
    try {
      const referenceEffects = [];
      const actualEffects = [];
      const reference = createSchemaWorkflow(
        referenceSaver,
        schema,
        referenceEffects,
      );
      const graph = createSchemaWorkflow(actualSaver, schema, actualEffects);
      const assertNoServingWrites = forbidServingWrites(graph);
      const input = workflowInput(schema);
      const originalInput = structuredClone(input);
      const config = threadConfig("parity", { durability });
      let client;
      const advance = async (mode, nativeInput, answer) => {
        await reference.invoke(nativeInput, config);
        if (mode === "native") await graph.invoke(nativeInput, config);
        else {
          const runtime = new Agentdock(graph);
          const seed = await runtime.getResumeState("parity");
          const run =
            answer === undefined
              ? { threadId: "parity", input, config: { durability } }
              : { threadId: "parity", resume: answer, config: { durability } };
          const events = await collectEvents(runtime.stream(run));
          client = reduceEvents(events, seed ?? undefined);
          assert.equal(events[0].type, "run.started");
          assert.equal(
            events.some((event) => event.type === "run.failed"),
            false,
          );
        }
        assert.deepEqual(
          controlShape(await graph.getState(config)),
          controlShape(await reference.getState(config)),
        );
        assert.deepEqual(actualEffects, referenceEffects);
        assert.deepEqual(
          await checkpointShape(actualSaver, config),
          await checkpointShape(referenceSaver, config),
        );
        assert.deepEqual(input, originalInput);
        assertNoServingWrites();
        const beforeRead = await checkpointDigest(actualSaver, config);
        const cold = await new Agentdock(graph).getResumeState("parity");
        assert.equal(await checkpointDigest(actualSaver, config), beforeRead);
        if (client && mode === "adapter" && cold) {
          assert.deepEqual(client.interrupts, cold.interrupts);
          assert.deepEqual(client.pausedNodes, cold.pausedNodes);
        }
        return cold;
      };
      const first = await advance(start, structuredClone(input));
      assert.equal(first.interrupt.prompt, "First?");
      assert.equal(first.interrupt.interruptId === "stale-id", false);
      const second = await advance(
        resume,
        new Command({ resume: "one" }),
        "one",
      );
      assert.equal(second.interrupt.prompt, "Second?");
      assert.equal(second.interrupt.occurrence, 1);
      assert.equal(
        await advance(resume, new Command({ resume: "two" }), "two"),
        null,
      );
      const final = await graph.getState(config);
      assert.deepEqual(final.values, {
        ...originalInput,
        total: 2,
        answers: ["one", "two"],
      });
      assert.equal(
        actualEffects.filter((effect) => effect.node === "approved").length,
        1,
      );
      assert.equal(
        actualEffects.filter((effect) => effect.node === "finish").length,
        1,
      );
      if (resume === "adapter") assert.equal(client.status, "completed");
    } finally {
      await stores.dispose();
    }
  },
);
