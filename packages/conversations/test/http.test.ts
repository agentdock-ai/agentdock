import { expect, it } from "vitest";
import { cloneConversationAttachment } from "@agentdock-ai/contracts";
import {
  ConversationService,
  createInMemoryConversationStore,
  createConversationHttpHandler,
} from "../src/index.js";

it("validates multipart requests and enforces ownership, bytes, references and deletion", async () => {
  const files = new Map<string, Uint8Array>();
  const service = new ConversationService({
    store: createInMemoryConversationStore(),
    prepareInput: ({ prompt }) => prompt,
    runtime: { getResumeState: async () => null, async *stream() {} },
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
  });
  let actor = "owner";
  const handler = createConversationHttpHandler({
    service,
    resolveActor: () => actor,
  });
  const thread = await service.createThread(actor);
  const root = `http://test/conversations/${thread.id}/attachments`;
  expect(
    (await handler(new Request(root, { method: "POST", body: "wrong" })))
      .status,
  ).toBe(400);
  expect(
    (
      await handler(
        new Request(root, {
          method: "POST",
          headers: { "content-type": "multipart/form-data; boundary=bad" },
          body: "broken",
        }),
      )
    ).status,
  ).toBe(400);
  const empty = new FormData();
  empty.set("text", "file missing");
  expect(
    (await handler(new Request(root, { method: "POST", body: empty }))).status,
  ).toBe(400);
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzUAAAAASUVORK5CYII=",
    "base64",
  );
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: "image/png" }), "image'one.png");
  const response = await handler(
    new Request(root, { method: "POST", body: form }),
  );
  expect(response.status).toBe(201);
  const body = await response.json();
  const saved = cloneConversationAttachment(body);
  expect(body).toMatchObject({ content: { url: saved.url } });
  actor = "other";
  expect((await handler(new Request(`http://test${saved.url}`))).status).toBe(
    404,
  );
  actor = "owner";
  const image = await handler(new Request(`http://test${saved.url}`));
  expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
  expect(image.headers.get("content-disposition")).toContain("%27");
  expect(
    (
      await handler(
        new Request(`http://test${saved.url}`, { method: "DELETE" }),
      )
    ).status,
  ).toBe(204);
  expect(files.size).toBe(0);
  expect((await handler(new Request(`http://test${saved.url}`))).status).toBe(
    404,
  );
  expect(
    (
      await handler(
        new Request(`http://test${saved.url}`, { method: "DELETE" }),
      )
    ).status,
  ).toBe(204);
});

it("fails closed on unavailable storage and validates route/body boundaries", async () => {
  const service = new ConversationService({
    store: createInMemoryConversationStore(),
    prepareInput: ({ prompt }) => prompt,
    runtime: { async *stream() {}, getResumeState: async () => null },
  });
  const handler = createConversationHttpHandler({
    service,
    resolveActor: () => "owner",
  });
  expect(() =>
    createConversationHttpHandler({
      service,
      resolveActor: () => "owner",
      maxBodyBytes: 1,
    }),
  ).toThrow("maxBodyBytes");
  for (const [path, method, body, status] of [
    ["/conversations", "POST", "[]", 400],
    ["/conversations", "POST", JSON.stringify({ title: 42 }), 400],
    ["/conversations/%broken/history", "GET", undefined, 400],
    ["/conversations/missing", "PATCH", "{}", 400],
    ["/conversations/missing/start", "POST", "null", 400],
    ["/unknown", "GET", undefined, 404],
  ] as const) {
    expect(
      (await handler(new Request(`http://test${path}`, { method, body })))
        .status,
    ).toBe(status);
  }
  const thread = await service.createThread("owner");
  expect(
    (
      await handler(
        new Request(
          `http://test/conversations/${thread.id}/attachments/missing`,
        ),
      )
    ).status,
  ).toBe(503);
  await expect(
    service.renameThread("owner", thread.id, " "),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    service.createThread("owner", "x".repeat(201)),
  ).rejects.toMatchObject({ status: 400 });
  await expect(service.getHistory("owner", " ")).rejects.toMatchObject({
    status: 400,
  });
});

it("rejects history cursors past the transcript end with 400", async () => {
  const service = new ConversationService({
    store: createInMemoryConversationStore(),
    prepareInput: ({ prompt }) => prompt,
    runtime: { getResumeState: async () => null, async *stream() {} },
  });
  const handler = createConversationHttpHandler({
    service,
    resolveActor: () => "owner",
  });
  const thread = await service.createThread("owner");
  const cursor = Buffer.from(JSON.stringify(999)).toString("base64url");
  const response = await handler(
    new Request(
      `http://test/conversations/${thread.id}/history?cursor=${cursor}`,
    ),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    code: "invalid_request",
    message: "Pagination cursor is invalid.",
  });
});

it.each([
  ["thread_busy", "thread_busy"],
  ["approval_expired", "approval_expired"],
  ["internal_detail", "conflict"],
  [undefined, "conflict"],
])(
  "maps a 409 with core code %s to the API code %s",
  async (coreCode, apiCode) => {
    const failure = Object.assign(new Error("Conflict from the core."), {
      status: 409,
      ...(coreCode === undefined ? {} : { code: coreCode }),
    });
    const service = new ConversationService({
      store: createInMemoryConversationStore(),
      prepareInput: ({ prompt }) => prompt,
      runtime: {
        getResumeState: async () => null,
        stream: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(failure),
          }),
        }),
      },
    });
    const handler = createConversationHttpHandler({
      service,
      resolveActor: () => "owner",
    });
    const thread = await service.createThread("owner");
    const response = await handler(
      new Request(`http://test/conversations/${thread.id}/start`, {
        method: "POST",
        body: JSON.stringify({
          threadId: thread.id,
          operationId: crypto.randomUUID(),
          prompt: "Hello",
          attachments: [],
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: apiCode,
      message: "Conflict from the core.",
    });
  },
);
