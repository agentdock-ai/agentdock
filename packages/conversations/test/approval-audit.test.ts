import { expect, it } from "vitest";
import { Agentdock } from "@agentdock-ai/agentdock";
import {
  END,
  START,
  StateGraph,
  StateSchema,
  MemorySaver,
  interrupt,
} from "@langchain/langgraph";
import { z } from "zod";
import {
  ConversationService,
  createInMemoryConversationStore,
  ConversationRecords,
  createConversationHttpHandler,
} from "../src/index.js";

it("persists trusted decision receipts before native resume and returns validation errors before SSE", async () => {
  const store = createInMemoryConversationStore();
  const records = new ConversationRecords(store, "trusted-actor");
  let failAudit = false;
  const put = store.put.bind(store);
  store.put = async (...args: Parameters<typeof store.put>) => {
    if (failAudit && Array.isArray(args[2].decisions)) {
      failAudit = false;
      throw new Error("Audit storage unavailable");
    }
    return put(...args);
  };
  let threadId = "";
  let executions = 0;
  let savedBeforeExecution = false;
  const graph = new StateGraph(
    new StateSchema({ messages: z.array(z.unknown()) }),
  )
    .addNode("review", async (state) => {
      const answer: { decisions: { type: string }[] } = interrupt({
        actionRequests: [
          { name: "lookup", args: {} },
          { name: "send", args: {} },
        ],
        reviewConfigs: [
          { actionName: "lookup", allowedDecisions: ["approve", "reject"] },
          { actionName: "send", allowedDecisions: ["approve", "reject"] },
        ],
      });
      if (answer.decisions[0]?.type === "approve") {
        savedBeforeExecution =
          (await records.getOperation(threadId, "approve"))?.decisions
            ?.length === 2;
        executions++;
      }
      return { messages: state.messages };
    })
    .addEdge(START, "review")
    .addEdge("review", END)
    .compile({ checkpointer: new MemorySaver() });
  const service = new ConversationService({
    store,
    runtime: new Agentdock(graph, { interruptFormat: Agentdock.HITL }),
    prepareInput: () => ({
      messages: [
        {
          id: "assistant",
          content: "",
          tool_calls: [
            { id: "call", name: "lookup", args: {} },
            { id: "send-call", name: "send", args: {} },
          ],
        },
      ],
    }),
  });
  const thread = await service.createThread("trusted-actor");
  threadId = thread.id;
  for await (const _ of service.start("trusted-actor", {
    threadId,
    operationId: "start",
    prompt: "lookup",
    attachments: [],
  })) {
  }
  const state = await service.getHistory("trusted-actor", threadId);
  const id = state.interrupts[0]!.interruptId;
  const handler = createConversationHttpHandler({
    service,
    resolveActor: () => "trusted-actor",
  });
  const request = (operationId: string, decisions: unknown[]) =>
    new Request(`http://test/conversations/${threadId}/approvals`, {
      method: "POST",
      body: JSON.stringify({
        threadId,
        operationId,
        interruptId: id,
        decisions,
      }),
    });
  const invalid = await handler(
    request("invalid", [
      { type: "edit", editedAction: { name: "lookup", args: {} } },
    ]),
  );
  expect(invalid.status).toBe(400);
  expect(invalid.headers.get("content-type")).toContain("application/json");
  expect(executions).toBe(0);
  failAudit = true;
  const failed = await handler(
    request("failed-audit", [{ type: "approve" }, { type: "approve" }]),
  );
  expect(failed.status).toBe(503);
  expect(executions).toBe(0);
  const response = await handler(
    request("approve", [{ type: "approve" }, { type: "approve" }]),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("run.completed");
  expect(executions).toBe(1);
  expect(savedBeforeExecution).toBe(true);
  const receipt = await records.getOperation(threadId, "approve");
  expect(receipt?.decisions).toHaveLength(2);
  expect(receipt?.decisions?.[0]).toMatchObject({
    threadId,
    interruptId: id,
    tool: "lookup",
    decision: "approve",
    context: { actorId: "trusted-actor" },
  });
});
