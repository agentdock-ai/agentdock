import assert from "node:assert/strict";
import { test } from "vitest";
import {
  Command,
  StateGraph,
  Annotation,
  Send,
  START,
  END,
  interrupt,
} from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import { z } from "zod";
import {
  Agentdock,
  withAgentEventState,
  validateToolApprovalResume,
} from "../../src/index.js";
import {
  createScriptedChatModel,
  createScriptedMessageChunks,
  createToolCallArgumentChunks,
} from "../helpers/stream-fixtures.mjs";
import { createCheckpointStores } from "../helpers/checkpoint-stores.mjs";
import {
  checkpointDigest,
  checkpointShape,
  collectEvents,
  forbidServingWrites,
  reduceEvents,
  threadConfig,
} from "../helpers/native-state-fixtures.mjs";

const cases = ["memory", "sqlite"].flatMap((backend) =>
  ["default", "custom", "legacy"].flatMap((schema) =>
    ["approve", "edit", "reject"].map((decision) => ({
      backend,
      schema,
      decision,
    })),
  ),
);

function createApprovalAgent(saver, schema, effects) {
  const sendEmail = tool(
    async ({ recipient }) => {
      effects.push(recipient);
      return "Email sent";
    },
    {
      name: "send_email",
      description: "Send an email",
      schema: z.object({ recipient: z.string() }),
    },
  );
  const options = {
    model: createScriptedChatModel({
      streamSequences: [
        createToolCallArgumentChunks({
          name: "send_email",
          toolCallId: "email-call",
          input: { recipient: "original@example.test" },
          messageId: "request",
        }),
        createScriptedMessageChunks(["Finished"], { id: "answer" }),
      ],
    }),
    tools: [sendEmail],
    checkpointer: saver,
    middleware: [
      humanInTheLoopMiddleware({ interruptOn: { send_email: true } }),
    ],
  };
  if (schema !== "default") {
    const fields = {
      business: z.object({ account: z.string(), flags: z.array(z.string()) }),
    };
    options.stateSchema =
      schema === "legacy" ? withAgentEventState(fields) : z.object(fields);
  }
  return createAgent(options).graph;
}

const messageShape = (message) => ({
  role: message.getType(),
  content: message.content,
  tool_calls: message.tool_calls,
  tool_call_id: message.tool_call_id,
  status: message.status,
});

test.each(cases)(
  "createAgent schema parity: $backend / $schema / $decision",
  async ({ backend, schema, decision }) => {
    const stores = await createCheckpointStores(backend);
    try {
      const referenceEffects = [];
      const actualEffects = [];
      const reference = createApprovalAgent(
        stores.referenceSaver,
        schema,
        referenceEffects,
      );
      const graph = createApprovalAgent(
        stores.actualSaver,
        schema,
        actualEffects,
      );
      const assertNoWrites = forbidServingWrites(graph);
      const input = { messages: [{ role: "user", content: "Send the email" }] };
      if (schema !== "default")
        input.business = { account: "customer", flags: ["keep"] };
      if (schema === "legacy")
        input.agentEventState = {
          runId: "stale",
          logicalSequence: 99,
          pendingInterrupt: {
            kind: "custom",
            interruptId: "wrong",
            prompt: "Wrong",
            actions: [],
          },
        };
      const originalInput = structuredClone(input);
      const config = threadConfig("email");
      const native = async (nativeInput) =>
        collectEvents(
          await reference.stream(nativeInput, {
            ...config,
            streamMode: ["messages", "tools", "updates", "tasks"],
          }),
        );
      const runtime = () =>
        new Agentdock(graph, {
          interruptFormat: "langchain-hitl",
          validateResume: validateToolApprovalResume,
        });
      await native(structuredClone(input));
      const initial = await collectEvents(
        runtime().stream({ threadId: "email", input }),
      );
      const cold = await runtime().getResumeState("email");
      const warm = reduceEvents(initial);
      assert.deepEqual(warm.interrupts, cold.interrupts);
      assert.deepEqual(warm.pausedNodes, cold.pausedNodes);
      assert.equal(cold.interrupt.kind, "tool-approval");
      assert.equal(cold.interrupt.actions[0].toolCallId, "email-call");
      assert.deepEqual(actualEffects, []);
      const digest = await checkpointDigest(stores.actualSaver, config);
      const messages = await runtime().getMessages("email");
      assert.equal(messages.length, 2);
      messages[0].content = "Changed client history";
      messages[1].tool_calls[0].args.recipient = "changed-client@example.test";
      assert.equal(await checkpointDigest(stores.actualSaver, config), digest);
      assert.deepEqual(
        (await runtime().getMessages("email")).map(messageShape),
        (await reference.getState(config)).values.messages.map(messageShape),
      );
      let selectedDecision = { type: decision };
      if (decision === "edit")
        selectedDecision = {
          type: "edit",
          editedAction: {
            name: "send_email",
            args: { recipient: "edited@example.test" },
          },
        };
      else if (decision === "reject")
        selectedDecision = { type: "reject", message: "Do not send" };
      const response = { decisions: [selectedDecision] };
      await native(new Command({ resume: response }));
      const finalEvents = await collectEvents(
        runtime().stream({ threadId: "email", resume: response }),
      );
      assert.equal(reduceEvents(finalEvents, warm).status, "completed");
      assert.equal(reduceEvents(finalEvents, cold).status, "completed");
      assert.equal(await runtime().getResumeState("email"), null);
      const actualState = (await graph.getState(config)).values;
      const referenceState = (await reference.getState(config)).values;
      assert.deepEqual(
        actualState.messages.map(messageShape),
        referenceState.messages.map(messageShape),
      );
      assert.deepEqual(actualEffects, referenceEffects);
      let expectedEffects = [];
      if (decision === "approve") expectedEffects = ["original@example.test"];
      else if (decision === "edit") expectedEffects = ["edited@example.test"];
      assert.deepEqual(actualEffects, expectedEffects);
      for (const field of ["business", "agentEventState"]) {
        assert.deepEqual(actualState[field], originalInput[field]);
        assert.deepEqual(actualState[field], referenceState[field]);
      }
      assert.deepEqual(input, originalInput);
      assert.deepEqual(
        await checkpointShape(stores.actualSaver, config),
        await checkpointShape(stores.referenceSaver, config),
      );
      assertNoWrites();
    } finally {
      await stores.dispose();
    }
  },
);

test.each(["sync", "async", "exit"])(
  "SQLite partial Send continuation agrees with native execution (%s)",
  async (durability) => {
    const stores = await createCheckpointStores("sqlite");
    try {
      const build = (saver, effects) =>
        new StateGraph(
          Annotation.Root({
            answers: Annotation({
              reducer: (a, b) => a.concat(b),
              default: () => [],
            }),
          }),
        )
          .addNode("dispatch", () => ({}))
          .addNode("worker", (state) => {
            const answer = interrupt({ prompt: state.label });
            effects.push(state.label);
            return { answers: [answer] };
          })
          .addEdge(START, "dispatch")
          .addConditionalEdges(
            "dispatch",
            () => [
              new Send("worker", { label: "A" }),
              new Send("worker", { label: "B" }),
            ],
            ["worker"],
          )
          .addEdge("worker", END)
          .compile({ checkpointer: saver });
      const referenceEffects = [];
      const actualEffects = [];
      const reference = build(stores.referenceSaver, referenceEffects);
      const graph = build(stores.actualSaver, actualEffects);
      const assertNoWrites = forbidServingWrites(graph);
      const config = threadConfig("fan-out", { durability });
      await reference.invoke({ answers: [] }, config);
      const initial = await collectEvents(
        new Agentdock(graph).stream({
          threadId: "fan-out",
          input: { answers: [] },
          config: { durability },
        }),
      );
      let warm = reduceEvents(initial);
      for (const label of ["A", "B"]) {
        const referenceId = (await reference.getState(config)).tasks
          .flatMap((task) => task.interrupts)
          .find((item) => item.value.prompt === label).id;
        const actualId = (
          await new Agentdock(graph).getResumeState("fan-out")
        ).interrupts.find((item) => item.prompt === label).interruptId;
        await reference.invoke(
          new Command({ resume: { [referenceId]: label.toLowerCase() } }),
          config,
        );
        const events = await collectEvents(
          new Agentdock(graph).stream({
            threadId: "fan-out",
            resume: { [actualId]: label.toLowerCase() },
            config: { durability },
          }),
        );
        warm = reduceEvents(events, warm);
        assert.deepEqual(actualEffects, referenceEffects);
        assert.deepEqual(
          (await graph.getState(config)).values,
          (await reference.getState(config)).values,
        );
        const cold = await new Agentdock(graph).getResumeState("fan-out");
        if (label === "A") {
          assert.deepEqual(warm.interrupts, cold.interrupts);
          assert.deepEqual(warm.pausedNodes, cold.pausedNodes);
          assert.equal(cold.interrupts.length, 1);
          assert.equal(cold.interrupt.prompt, "B");
        } else assert.equal(cold, null);
      }
      assert.equal(warm.status, "completed");
      assert.deepEqual(actualEffects, ["A", "B"]);
      assertNoWrites();
    } finally {
      await stores.dispose();
    }
  },
);
