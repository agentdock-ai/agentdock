import { afterEach, expect, it, vi } from "vitest";
import { cloneAgentEvent } from "@agentdock-ai/contracts";
import {
  ConversationService,
  createConversationHttpHandler,
  createInMemoryConversationStore,
} from "../src/index.js";

afterEach(() => vi.useRealTimers());
it.each([0, 15000])(
  "conversation SSE uses idle comments without persisting them (%s)",
  async (heartbeatMs) => {
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const event = (type: string, sequence: number) =>
      cloneAgentEvent({
        protocolVersion: 3,
        eventId: `run:${sequence}`,
        runId: "run",
        logicalSequence: sequence,
        phaseId: "phase",
        sequence,
        timestamp: new Date().toISOString(),
        type,
        ...(type === "run.completed"
          ? { content: [], finishReason: "stop" }
          : {}),
      });
    const service = new ConversationService({
      store: createInMemoryConversationStore(),
      prepareInput: () => ({}),
      runtime: {
        getResumeState: async () => null,
        async *stream() {
          yield event("run.started", 1);
          await wait;
          yield event("run.completed", 2);
        },
      },
    });
    const thread = await service.createThread("owner");
    const handler = createConversationHttpHandler({
      service,
      resolveActor: () => "owner",
      heartbeatMs,
    });
    const response = await handler(
      new Request(`http://test/conversations/${thread.id}/start`, {
        method: "POST",
        body: JSON.stringify({
          threadId: thread.id,
          operationId: "operation",
          prompt: "hello",
          attachments: [],
        }),
      }),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    vi.useFakeTimers();
    if (heartbeatMs) {
      for (let i = 0; i < 2; i++) {
        const read = reader.read();
        await vi.advanceTimersByTimeAsync(15000);
        expect(new TextDecoder().decode((await read).value)).toBe(": ping\n\n");
      }
    }
    const final = reader.read();
    await vi.advanceTimersByTimeAsync(heartbeatMs ? 10000 : 40000);
    finish();
    expect(new TextDecoder().decode((await final).value)).toContain(
      "run.completed",
    );
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      (await service.getHistory("owner", thread.id)).messages,
    ).toHaveLength(1);
  },
);
it("validates the conversation heartbeat interval", () => {
  const service = new ConversationService({
    store: createInMemoryConversationStore(),
    prepareInput: () => ({}),
    runtime: { getResumeState: async () => null, async *stream() {} },
  });
  expect(() =>
    createConversationHttpHandler({
      service,
      resolveActor: () => "owner",
      heartbeatMs: -1,
    }),
  ).toThrow(/heartbeatMs/);
});
