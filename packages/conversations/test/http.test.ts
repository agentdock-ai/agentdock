import { expect, it } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import {
  ConversationService,
  createConversationHttpHandler,
} from "../src/index.js";

it("validates multipart requests and enforces ownership, bytes, references and deletion", async () => {
  const files = new Map<string, Uint8Array>();
  const service = new ConversationService({
    store: new InMemoryStore(),
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
  const saved = await response.json();
  expect(saved.content.url).toBe(saved.url);
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
    store: new InMemoryStore(),
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
