import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import {
  createAgentReducerState,
  type AgentEvent,
  type AgentReducerState,
  type AgentInterrupt,
  type JsonValue,
  assertConversationThread,
  cloneConversationHistory,
} from "@agentdock-ai/contracts";
import {
  ConversationService,
  createInMemoryConversationStore,
  ConversationRecords,
  type ConversationFileStorage,
} from "../src/index.js";
import type { Run } from "@agentdock-ai/agentdock";
import { createConversationHttpHandler } from "../src/http.js";

describe("ConversationService", () => {
  it.each([1, 2, 3, 4, 5, 6])(
    "recovers an admission failure at write %s without running the graph",
    async (failAt) => {
      class FailingAdmissionStore extends InMemoryStore {
        armed = false;
        writes = 0;
        override async put(...args: Parameters<InMemoryStore["put"]>) {
          if (this.armed && ++this.writes === failAt) {
            this.armed = false;
            throw new Error("temporary admission outage");
          }
          return super.put(...args);
        }
      }
      const store = new FailingAdmissionStore();
      let executions = 0;
      const service = createService({
        store,
        stream: async function* () {
          executions++;
          yield* completedStream();
        },
      });
      const thread = await service.createThread("alice");
      store.armed = true;
      await expect(
        collect(
          service.start("alice", {
            operationId: "failed",
            threadId: thread.id,
            prompt: "first",
            attachments: [],
          }),
        ),
      ).rejects.toThrow("temporary admission outage");
      expect(executions).toBe(0);
      const history = await service.getHistory("alice", thread.id);
      expect(history.actions.canStart).toBe(true);
      expect(
        history.messages.every((message) => message.outcome === "complete"),
      ).toBe(true);
      expect(
        (
          await new ConversationRecords(store, "alice").getOperation(
            thread.id,
            "failed",
          )
        )?.outcome,
      ).toBe("error");
      await collect(
        service.start("alice", {
          operationId: "retry",
          threadId: thread.id,
          prompt: "second",
          attachments: [],
        }),
      );
      expect(executions).toBe(1);
      expect(
        (await service.getHistory("alice", thread.id)).messages.at(-1)?.content,
      ).toEqual([{ type: "text", text: "Hello back" }]);
    },
  );

  it("retries file cleanup after a transient adapter failure", async () => {
    const files = new Map<string, Uint8Array>();
    let calls = 0;
    const store = new InMemoryStore();
    const service = new ConversationService({
      store,
      prepareInput: ({ prompt }) => prompt,
      runtime: { stream: completedStream, getResumeState: async () => null },
      fileStorage: {
        async put({ id, bytes }) {
          files.set(id, bytes);
          return id;
        },
        async get(id) {
          return files.get(id) ?? null;
        },
        async delete(id) {
          if (++calls === 1) throw new Error("temporary storage outage");
          files.delete(id);
        },
      },
    });
    const thread = await service.createThread("alice");
    const attachment = await service.uploadAttachment("alice", thread.id, {
      name: "image.png",
      mimeType: "image/png",
      bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    await expect(
      service.deleteAttachment("alice", thread.id, attachment.id),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      await new ConversationRecords(store, "alice").getAttachment(
        thread.id,
        attachment.id,
      ),
    ).not.toBeNull();
    await service.deleteAttachment("alice", thread.id, attachment.id);
    expect(calls).toBe(2);
    expect(files.size).toBe(0);
    expect(
      await new ConversationRecords(store, "alice").getAttachment(
        thread.id,
        attachment.id,
      ),
    ).toBeNull();
    await service.deleteAttachment("alice", thread.id, attachment.id);
    expect(calls).toBe(2);
  });

  it("retries reference cleanup after bytes were already deleted", async () => {
    const files = new Map<string, Uint8Array>();
    let calls = 0;
    const store = new InMemoryStore();
    const remove = store.delete.bind(store);
    let failures = 1;
    store.delete = async (...args) => {
      if (failures-- > 0) throw new Error("temporary reference outage");
      return remove(...args);
    };
    const service = new ConversationService({
      store,
      prepareInput: ({ prompt }) => prompt,
      runtime: { stream: completedStream, getResumeState: async () => null },
      fileStorage: {
        async put({ id, bytes }) {
          files.set(id, bytes);
          return id;
        },
        async get(id) {
          return files.get(id) ?? null;
        },
        async delete(id) {
          calls++;
          files.delete(id);
        },
      },
    });
    const thread = await service.createThread("alice");
    const attachment = await service.uploadAttachment("alice", thread.id, {
      name: "image.png",
      mimeType: "image/png",
      bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    await expect(
      service.deleteAttachment("alice", thread.id, attachment.id),
    ).rejects.toThrow("temporary reference outage");
    expect(
      await new ConversationRecords(store, "alice").getAttachment(
        thread.id,
        attachment.id,
      ),
    ).not.toBeNull();
    await service.deleteAttachment("alice", thread.id, attachment.id);
    expect(calls).toBe(2);
    expect(files.size).toBe(0);
    expect(
      await new ConversationRecords(store, "alice").getAttachment(
        thread.id,
        attachment.id,
      ),
    ).toBeNull();
    await service.deleteAttachment("alice", thread.id, attachment.id);
    expect(calls).toBe(2);
  });

  it("excludes starts and competing renames throughout asynchronous title writes", async () => {
    const store = new InMemoryStore();
    const put = store.put.bind(store);
    let release!: () => void;
    const blockedWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.put = async (...args) => {
      if (args[2].title === "Preserved title") await blockedWrite;
      return put(...args);
    };
    const service = createService({ store });
    const thread = await service.createThread("alice");
    const rename = service.renameThread("alice", thread.id, "Preserved title");
    await expect(
      service.renameThread("alice", thread.id, "Conflicting title"),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      collect(
        service.start("alice", {
          operationId: "during-rename",
          threadId: thread.id,
          prompt: "work",
          attachments: [],
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    release();
    await rename;
    await collect(
      service.start("alice", {
        operationId: "after-rename",
        threadId: thread.id,
        prompt: "work",
        attachments: [],
      }),
    );
    expect((await service.getHistory("alice", thread.id)).thread.title).toBe(
      "Preserved title",
    );
  });

  it("creates empty threads, pages records, and isolates trusted actors", async () => {
    const service = createService();
    const created = await service.createThread("alice", "  First thread  ");
    expect(created.title).toBe("First thread");
    expect((await service.listThreads("alice")).threads).toEqual([created]);
    expect((await service.listThreads("bob")).threads).toEqual([]);
    await expect(service.getHistory("bob", created.id)).rejects.toMatchObject({
      status: 404,
    });
    const history = await service.getHistory("alice", created.id);
    expect(history.messages).toEqual([]);
    expect(history.actions.canStart).toBe(true);
  });

  it("serves validated thread/history/action routes with trusted actor context", async () => {
    const service = createService();
    const actor = "server-authenticated-user";
    const handler = createConversationHttpHandler({
      service,
      resolveActor: () => actor,
    });
    const request = (path: string, method = "GET", body?: unknown) =>
      new Request(`http://agentdock.test${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      });

    expect((await handler(request("/conversations/other"))).status).toBe(404);
    const created = await handler(
      request("/conversations", "POST", { title: "HTTP thread" }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    if (
      typeof createdBody !== "object" ||
      createdBody === null ||
      !("thread" in createdBody)
    )
      throw new Error("Missing thread response");
    assertConversationThread(createdBody.thread);
    const thread = createdBody.thread;
    expect((await handler(request("/conversations"))).status).toBe(200);
    expect(
      (
        await handler(
          request(`/conversations/${thread.id}`, "PATCH", { title: "Renamed" }),
        )
      ).status,
    ).toBe(200);
    const historyResponse = await handler(
      request(`/conversations/${thread.id}/history`),
    );
    expect(
      cloneConversationHistory(await historyResponse.json()).thread.title,
    ).toBe("Renamed");

    const start = await handler(
      request(`/conversations/${thread.id}/start`, "POST", {
        operationId: "http-operation",
        threadId: thread.id,
        prompt: "HTTP prompt",
        attachments: [],
      }),
    );
    expect(start.headers.get("content-type")).toContain("text/event-stream");
    expect(await start.text()).toContain('"operationId":"http-operation"');
    const stop = await handler(
      request(`/conversations/${thread.id}/stop`, "POST", {
        operationId: "http-stop",
        targetOperationId: "http-operation",
        threadId: thread.id,
      }),
    );
    expect(stop.status).toBe(409);
    const mismatch = await handler(
      request(`/conversations/${thread.id}/start`, "POST", {
        operationId: "mismatch",
        threadId: "other-thread",
        prompt: "No execution",
        attachments: [],
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      message: "threadId must match the URL.",
    });
  });

  it("persists each published event before returning it and restores the transcript", async () => {
    const store = new InMemoryStore();
    const service = createService({ store });
    const thread = await service.createThread("alice");
    const events = await collect(
      service.start("alice", {
        operationId: "operation-1",
        threadId: thread.id,
        prompt: "Hello",
        attachments: [],
      }),
    );
    expect(events.map((item) => item.event.type)).toEqual([
      "run.started",
      "message.started",
      "message.part.delta",
      "message.completed",
      "run.completed",
    ]);
    const history = await service.getHistory("alice", thread.id);
    expect(history.messages.map((item) => [item.role, item.outcome])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(history.messages[1]?.content).toEqual([
      { type: "text", text: "Hello back" },
    ]);
    expect((await service.listThreads("alice")).threads[0]?.id).toBe(thread.id);
  });

  it("returns a single safe image source for uploaded transcript attachments", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzUAAAAASUVORK5CYII=",
      "base64",
    );
    const files = new Map<string, Uint8Array>();
    const fileStorage: ConversationFileStorage = {
      async put({ id, bytes: content }) {
        files.set(id, content);
        return id;
      },
      async get(id) {
        return files.get(id) ?? null;
      },
      async delete(id) {
        files.delete(id);
      },
    };
    const service = new ConversationService({
      store: createInMemoryConversationStore(),
      fileStorage,
      prepareInput: ({ prompt }) => prompt,
      runtime: {
        stream: () => completedStream(),
        getResumeState: async () => null,
      },
    });
    const thread = await service.createThread("alice");
    const attachment = await service.uploadAttachment("alice", thread.id, {
      name: "picture.png",
      mimeType: "image/png",
      bytes,
    });
    await collect(
      service.start("alice", {
        operationId: "image-operation",
        threadId: thread.id,
        prompt: "Describe this image",
        attachments: [attachment.id],
      }),
    );

    const history = await service.getHistory("alice", thread.id);
    expect(history.messages[0]?.content[1]).toEqual({
      type: "image",
      url: attachment.url,
      mimeType: "image/png",
    });
    expect((await service.listThreads("alice")).threads[0]?.id).toBe(thread.id);
  });

  it("does not create an empty assistant message when stopped before the first token", async () => {
    const service = createService({
      stream: async function* (run) {
        yield event("run.started", 1, { runId: "run-1" });
        await untilAborted(run.signal);
        yield event("run.cancelled", 2, {
          runId: "run-1",
          reason: "user_stop",
        });
      },
    });
    const thread = await service.createThread("alice");
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const consumed = (async () => {
      const events: unknown[] = [];
      for await (const item of service.start("alice", {
        operationId: "stop-me",
        threadId: thread.id,
        prompt: "Stop before a token",
        attachments: [],
      })) {
        events.push(item);
        if ((item as { event: AgentEvent }).event.type === "run.started")
          notifyStarted();
      }
      return events;
    })();
    await started;
    await service.stop("alice", {
      operationId: "stop-request",
      threadId: thread.id,
      targetOperationId: "stop-me",
    });
    await consumed;
    const history = await service.getHistory("alice", thread.id);
    expect(history.messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("rejects Stop when terminal persistence fails instead of reporting durable success", async () => {
    class FailingStore extends InMemoryStore {
      failTerminal = false;
      override async put(
        namespace: string[],
        key: string,
        value: Record<string, unknown>,
        index?: false | string[],
        _options?: { ttl?: number },
      ) {
        if (this.failTerminal && value.status === "settled")
          throw new Error("simulated operation write failure");
        return super.put(namespace, key, value, index);
      }
    }
    const store = new FailingStore();
    const service = createService({
      store,
      stream: async function* (run) {
        yield event("run.started", 1, { runId: "failing-stop" });
        await untilAborted(run.signal);
        store.failTerminal = true;
        yield event("run.cancelled", 2, {
          runId: "failing-stop",
          reason: "user_stop",
        });
      },
    });
    const thread = await service.createThread("alice");
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const consuming = collect(
      (async function* () {
        for await (const item of service.start("alice", {
          operationId: "faulted-stop",
          threadId: thread.id,
          prompt: "Work",
          attachments: [],
        })) {
          if ((item as { event: AgentEvent }).event.type === "run.started")
            started();
          yield item;
        }
      })(),
    );
    await began;
    await expect(
      service.stop("alice", {
        operationId: "stop-fault",
        threadId: thread.id,
        targetOperationId: "faulted-stop",
      }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(consuming).rejects.toBeDefined();
  });

  it("rejects operation ID reuse with different input", async () => {
    const service = createService();
    const thread = await service.createThread("alice");
    await collect(
      service.start("alice", {
        operationId: "same-id",
        threadId: thread.id,
        prompt: "one",
        attachments: [],
      }),
    );
    await expect(
      collect(
        service.start("alice", {
          operationId: "same-id",
          threadId: thread.id,
          prompt: "different",
          attachments: [],
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("allows native Continue after Stop only when the latest native snapshot still has pending work", async () => {
    const pending = {
      ...createAgentReducerState(),
      threadId: "thread",
      status: "waiting" as const,
      pausedNodes: ["model_request"],
    };
    let currentState: AgentReducerState | null = pending;
    const service = createService({
      resumeState: () => currentState,
      stream: async function* (run) {
        if (run.continue) {
          expect(run.continue).toBe(true);
          yield event("run.started", 1, { runId: "run-continued" });
          yield event("run.completed", 2, {
            runId: "run-continued",
            finishReason: "stop",
            content: [],
          });
          currentState = null;
          return;
        }
        yield event("run.started", 1, { runId: "run-stopped" });
        await untilAborted(run.signal);
        yield event("run.cancelled", 2, {
          runId: "run-stopped",
          reason: "user_stop",
        });
      },
    });
    const thread = await service.createThread("alice");
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const consuming = collect(
      (async function* () {
        for await (const envelope of service.start("alice", {
          operationId: "stopped-op",
          threadId: thread.id,
          prompt: "Make progress",
          attachments: [],
        })) {
          if ((envelope as { event: AgentEvent }).event.type === "run.started")
            started();
          yield envelope;
        }
      })(),
    );
    await began;
    await service.stop("alice", {
      operationId: "stop-1",
      threadId: thread.id,
      targetOperationId: "stopped-op",
    });
    await consuming;
    const events = await collect(
      service.continue("alice", {
        operationId: "continue-1",
        threadId: thread.id,
        pendingOperationId: "stopped-op",
      }),
    );
    expect(events).toHaveLength(2);
    expect(
      await service
        .getHistory("alice", thread.id)
        .then((result) => result.actions.canContinue),
    ).toBe(false);
  });

  it("rejects Continue when native pending work has disappeared", async () => {
    const service = createService({ resumeState: () => null });
    const thread = await service.createThread("alice");
    await expect(
      collect(
        service.continue("alice", {
          operationId: "continue-1",
          threadId: thread.id,
          pendingOperationId: "missing",
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("pages the newest transcript positions first and loads older messages by explicit position", async () => {
    let runNumber = 0;
    const service = createService({
      stream: async function* () {
        const runId = `page-run-${++runNumber}`;
        const messageId = `assistant-${runNumber}`;
        yield event("run.started", 1, { runId });
        yield event("message.started", 2, {
          runId,
          messageId,
          role: "assistant",
        });
        yield event("message.part.delta", 3, {
          runId,
          messageId,
          part: { type: "text", text: `reply ${runNumber}` },
        });
        yield event("message.completed", 4, {
          runId,
          messageId,
          role: "assistant",
          content: [{ type: "text", text: `reply ${runNumber}` }],
        });
        yield event("run.completed", 5, {
          runId,
          finishReason: "stop",
          content: [],
        });
      },
    });
    const thread = await service.createThread("alice");
    for (let index = 0; index < 22; index++) {
      await collect(
        service.start("alice", {
          operationId: `page-operation-${index}`,
          threadId: thread.id,
          prompt: `prompt ${index}`,
          attachments: [],
        }),
      );
    }
    const latest = await service.getHistory("alice", thread.id);
    expect(latest.messages).toHaveLength(40);
    expect(latest.messages[0]?.position).toBe(4);
    expect(latest.messages.at(-1)?.position).toBe(43);
    expect(latest.nextCursor).not.toBeNull();
    const older = await service.getHistory(
      "alice",
      thread.id,
      latest.nextCursor,
    );
    expect(older.messages.map((message) => message.position)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(older.nextCursor).toBeNull();
  });

  it("submits ordered native approval decisions only for the current interrupt", async () => {
    const interrupt: AgentInterrupt = {
      kind: "tool-approval" as const,
      interruptId: "approval-1",
      prompt: "Approve these actions",
      actions: [
        {
          id: "action-1",
          toolCallId: "call-1",
          name: "write_file",
          input: { path: "a.txt" },
        },
        {
          id: "action-2",
          toolCallId: "call-2",
          name: "run_command",
          input: { file: "check.mjs" },
        },
      ],
    };
    let nativeState: AgentReducerState | null = null;
    const decisions: JsonValue[] = [
      { type: "approve" },
      {
        type: "edit",
        editedAction: {
          name: "write_file",
          args: { path: "safe.txt", content: "ok" },
        },
      },
    ];
    const service = createService({
      resumeState: () => nativeState,
      stream: async function* (run) {
        if (run.resume) {
          expect(run.resume).toEqual({ "approval-1": { decisions } });
          nativeState = null;
          yield event("run.started", 1, { runId: "approved-run" });
          yield event("interrupt.resolved", 2, {
            runId: "approved-run",
            interruptId: interrupt.interruptId,
            decisions,
          });
          yield event("run.completed", 3, {
            runId: "approved-run",
            finishReason: "stop",
            content: [],
          });
          return;
        }
        yield event("run.started", 1, { runId: "paused-run" });
        yield event("run.paused", 2, { runId: "paused-run", next: ["tools"] });
        nativeState = {
          ...createAgentReducerState(),
          threadId: "thread",
          status: "waiting",
          interrupts: [interrupt],
          interrupt,
        };
      },
    });
    const thread = await service.createThread("alice");
    await collect(
      service.start("alice", {
        operationId: "approval-source",
        threadId: thread.id,
        prompt: "Make changes",
        attachments: [],
      }),
    );
    await expect(
      collect(
        service.start("alice", {
          operationId: "bypass-attempt",
          threadId: thread.id,
          prompt: "Do something else",
          attachments: [],
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await collect(
      service.respondToInterrupt("alice", {
        operationId: "approval-response",
        threadId: thread.id,
        interruptId: interrupt.interruptId,
        decisions,
      }),
    );
    await expect(
      collect(
        service.respondToInterrupt("alice", {
          operationId: "stale-approval",
          threadId: thread.id,
          interruptId: interrupt.interruptId,
          decisions,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("admits only one of two simultaneous starts and keeps complete prompts complete after Stop", async () => {
    const service = createService({
      stream: async function* (run) {
        yield event("run.started", 1, { runId: "race-run" });
        await untilAborted(run.signal);
        yield event("run.cancelled", 2, {
          runId: "race-run",
          reason: "user_stop",
        });
      },
    });
    const thread = await service.createThread("alice");
    const input = { threadId: thread.id, prompt: "one", attachments: [] };
    const first = service
      .start("alice", { ...input, operationId: "race-a" })
      [Symbol.asyncIterator]();
    const second = service
      .start("alice", { ...input, operationId: "race-b" })
      [Symbol.asyncIterator]();
    const results = await Promise.allSettled([first.next(), second.next()]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure).toMatchObject({ reason: { status: 409 } });
    const winner = results[0]?.status === "fulfilled" ? "race-a" : "race-b";
    await service.stop("alice", {
      operationId: "stop-race",
      threadId: thread.id,
      targetOperationId: winner,
    });
    await first.return?.();
    await second.return?.();
    const history = await service.getHistory("alice", thread.id);
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]?.outcome).toBe("complete");
  });

  it("settles Stop even if its consumer stops reading after the first event", async () => {
    const service = createService({
      stream: async function* (run) {
        yield event("run.started", 1, { runId: "slow-reader" });
        yield event("message.started", 2, {
          runId: "slow-reader",
          messageId: "partial",
          role: "assistant",
        });
        yield event("message.part.delta", 3, {
          runId: "slow-reader",
          messageId: "partial",
          part: { type: "text", text: "saved partial" },
        });
        await untilAborted(run.signal);
        yield event("run.cancelled", 4, {
          runId: "slow-reader",
          reason: "user_stop",
        });
      },
    });
    const thread = await service.createThread("alice");
    const iterator = service
      .start("alice", {
        operationId: "slow-reader",
        threadId: thread.id,
        prompt: "work",
        attachments: [],
      })
      [Symbol.asyncIterator]();
    await iterator.next();
    await service.stop("alice", {
      operationId: "stop",
      threadId: thread.id,
      targetOperationId: "slow-reader",
    });
    const history = await service.getHistory("alice", thread.id);
    expect(history.messages[0]?.outcome).toBe("complete");
    expect(history.messages[1]).toMatchObject({
      outcome: "stopped",
      content: [{ type: "text", text: "saved partial" }],
    });
    await iterator.return?.();
  });

  it("returns an HTTP conflict before SSE headers and rejects malformed requests as 400", async () => {
    const service = createService();
    const handler = createConversationHttpHandler({
      service,
      resolveActor: () => "alice",
    });
    const thread = await service.createThread("alice");
    const req = (path: string, body: unknown) =>
      new Request(`http://local/conversations/${thread.id}/${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    expect((await handler(req("start", { threadId: thread.id }))).status).toBe(
      400,
    );
    expect(
      (
        await handler(
          req("continue", {
            threadId: thread.id,
            operationId: "no-pending",
            pendingOperationId: "missing",
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await handler(
          req("start", {
            threadId: thread.id,
            operationId: "missing-image",
            prompt: "work",
            attachments: ["missing"],
          }),
        )
      ).status,
    ).toBe(503);
  });

  it("aborts native work on request disconnect without waiting for another reader pull", async () => {
    const abort = new AbortController();
    const service = createService({
      stream: async function* (run) {
        yield event("run.started", 1, { runId: "disconnect" });
        await untilAborted(run.signal);
        yield event("run.cancelled", 2, {
          runId: "disconnect",
          reason: "user_stop",
        });
      },
    });
    const thread = await service.createThread("alice");
    const iterator = service
      .start(
        "alice",
        {
          operationId: "disconnect",
          threadId: thread.id,
          prompt: "work",
          attachments: [],
        },
        abort.signal,
      )
      [Symbol.asyncIterator]();
    await iterator.next();
    abort.abort();
    await iterator.return?.();
    const history = await service.getHistory("alice", thread.id);
    expect(history.actions.canStart).toBe(true);
    await service.shutdown();
    await expect(
      collect(
        service.start("alice", {
          operationId: "after-shutdown",
          threadId: thread.id,
          prompt: "work",
          attachments: [],
        }),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("assigns separate logical turns to sequential prompts", async () => {
    const service = createService();
    const thread = await service.createThread("alice");
    await collect(
      service.start("alice", {
        operationId: "first",
        threadId: thread.id,
        prompt: "one",
        attachments: [],
      }),
    );
    await collect(
      service.start("alice", {
        operationId: "second",
        threadId: thread.id,
        prompt: "two",
        attachments: [],
      }),
    );
    expect(
      (await service.getHistory("alice", thread.id)).messages.map(
        (m) => m.turnId,
      ),
    ).toEqual([
      `${thread.id}:1`,
      `${thread.id}:1`,
      `${thread.id}:2`,
      `${thread.id}:2`,
    ]);
  });
  it.each(["a.b", "a:b", "a%b", "a_b", "a\\b", "用户", "user", " user"])(
    "isolates adversarial actor identity %s",
    async (actor) => {
      const service = createService();
      const thread = await service.createThread(actor);
      expect((await service.listThreads(actor)).threads).toHaveLength(1);
      await expect(
        service.getHistory(`${actor}:other`, thread.id),
      ).rejects.toMatchObject({ status: 404 });
    },
  );

  it("keeps uncertain native execution quarantined when cancellation is not acknowledged", async () => {
    const service = new ConversationService({
      store: createInMemoryConversationStore(),
      settlementTimeoutMs: 20,
      prepareInput: ({ prompt }) => prompt,
      runtime: {
        getResumeState: async () => null,
        stream: async function* () {
          yield event("run.started", 1, {});
          await new Promise(() => {});
        },
      },
    });
    const thread = await service.createThread("alice");
    const iterator = service
      .start("alice", {
        operationId: "uncooperative",
        threadId: thread.id,
        prompt: "work",
        attachments: [],
      })
      [Symbol.asyncIterator]();
    await iterator.next();
    await expect(
      service.stop("alice", {
        operationId: "stop",
        threadId: thread.id,
        targetOperationId: "uncooperative",
      }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      collect(
        service.start("alice", {
          operationId: "replacement",
          threadId: thread.id,
          prompt: "work",
          attachments: [],
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await iterator.return?.();
    await expect(service.shutdown()).rejects.toMatchObject({ status: 503 });
  });

  it("cleans up bytes when attachment reference persistence fails", async () => {
    class FailingStore extends InMemoryStore {
      override async put(
        namespace: string[],
        key: string,
        value: Record<string, unknown>,
      ) {
        if (namespace.at(-1) === "attachments")
          throw new Error("reference failure");
        return super.put(namespace, key, value);
      }
    }
    const files = new Map<string, Uint8Array>();
    const service = new ConversationService({
      store: new FailingStore(),
      prepareInput: ({ prompt }) => prompt,
      fileStorage: {
        async put({ id, bytes }) {
          files.set(id, bytes);
          return id;
        },
        async get(id) {
          return files.get(id) ?? null;
        },
        async delete(id) {
          files.delete(id);
        },
      },
      runtime: {
        stream: () => completedStream(),
        getResumeState: async () => null,
      },
    });
    const thread = await service.createThread("alice");
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzUAAAAASUVORK5CYII=",
      "base64",
    );
    await expect(
      service.uploadAttachment("alice", thread.id, {
        name: "test.png",
        mimeType: "image/png",
        bytes,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(files.size).toBe(0);
    await expect(
      service.uploadAttachment("bob", thread.id, {
        name: "test.png",
        mimeType: "image/png",
        bytes,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.uploadAttachment("alice", thread.id, {
        name: "test.svg",
        mimeType: "image/png",
        bytes: new TextEncoder().encode("<svg/>"),
      }),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("shows a lost producer as uncertain after restart without executing it again", async () => {
    const store = new InMemoryStore();
    const { ConversationRecords } = await import("../src/store.js");
    const service = createService({ store });
    const thread = await service.createThread("alice");
    const records = new ConversationRecords(store, "alice");
    const saved = (await records.getThread(thread.id))!;
    const operation = {
      id: "lost",
      action: "start" as const,
      requestHash: "hash",
      turnId: "turn",
      status: "running" as const,
      runId: "run",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      publishedPosition: 0,
    };
    saved.lastOperation = operation;
    await records.putOperation(thread.id, operation);
    await records.putThread(saved);
    const restarted = createService({ store });
    const history = await restarted.getHistory("alice", thread.id);
    expect(history.execution?.status).toBe("uncertain");
    expect(history.actions.canStart).toBe(false);
    await expect(
      collect(
        restarted.start("alice", {
          operationId: "unsafe-retry",
          threadId: thread.id,
          prompt: "work",
          attachments: [],
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects bad cursors and oversized JSON before calling a workflow", async () => {
    const service = createService();
    const handler = createConversationHttpHandler({
      service,
      resolveActor: () => "alice",
      maxBodyBytes: 1024,
    });
    expect(
      (await handler(new Request("http://local/conversations?cursor=broken")))
        .status,
    ).toBe(400);
    expect(
      (
        await handler(
          new Request("http://local/conversations", {
            method: "POST",
            body: "invalid-json",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handler(
          new Request("http://local/conversations", {
            method: "POST",
            body: JSON.stringify({ title: "x".repeat(2048) }),
          }),
        )
      ).status,
    ).toBe(413);
  });
});

function createService(
  input: {
    store?: InMemoryStore;
    stream?: (
      run: Run<string, Record<string, unknown>>,
    ) => AsyncIterable<AgentEvent>;
    resumeState?: () => AgentReducerState | null;
  } = {},
) {
  return new ConversationService({
    store: createInMemoryConversationStore(input.store ?? new InMemoryStore()),
    prepareInput: ({ prompt }) => prompt,
    runtime: {
      stream: (run) => (input.stream ? input.stream(run) : completedStream()),
      getResumeState: async () => input.resumeState?.() ?? null,
    },
  });
}

async function* completedStream(): AsyncIterable<AgentEvent> {
  yield event("run.started", 1, { runId: "run-1" });
  yield event("message.started", 2, {
    runId: "run-1",
    messageId: "assistant-1",
    role: "assistant",
  });
  yield event("message.part.delta", 3, {
    runId: "run-1",
    messageId: "assistant-1",
    part: { type: "text", text: "Hello back" },
  });
  yield event("message.completed", 4, {
    runId: "run-1",
    messageId: "assistant-1",
    role: "assistant",
    content: [{ type: "text", text: "Hello back" }],
  });
  yield event("run.completed", 5, {
    runId: "run-1",
    finishReason: "stop",
    content: [{ type: "text", text: "Hello back" }],
  });
}

function event(
  type: string,
  sequence: number,
  data: Record<string, unknown>,
): AgentEvent {
  return {
    protocolVersion: 3,
    eventId: `event-${sequence}`,
    runId: "run-1",
    logicalSequence: sequence,
    phaseId: "phase-1",
    sequence,
    timestamp: new Date(sequence * 1000).toISOString(),
    type,
    ...data,
  } as AgentEvent;
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}

function untilAborted(signal?: AbortSignal): Promise<void> {
  if (!signal) return Promise.resolve();
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
