import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { test } from "vitest";
import { NodeHttpAdapter } from "../../src/transports/node/http-adapter.js";

test("bridges request and response streams and preserves multiple cookies", async () => {
  let observedRequest;
  const adapter = new NodeHttpAdapter(async (request) => {
    observedRequest = {
      method: request.method,
      url: request.url,
      body: await request.text(),
    };
    const headers = new Headers({ "content-type": "text/plain" });
    headers.append("set-cookie", "first=one; Path=/");
    headers.append("set-cookie", "second=two; Path=/");
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed "));
          controller.enqueue(new TextEncoder().encode("response"));
          controller.close();
        },
      }),
      { status: 201, headers },
    );
  });
  const request = createIncoming({
    method: "POST",
    url: "/conversations?cursor=next",
    headers: { "content-type": "text/plain" },
    body: "request body",
  });
  const response = new MemoryResponse();

  await adapter.handle(request, response);

  assert.equal(response.statusCode, 201);
  assert.equal(response.body(), "streamed response");
  assert.deepEqual(
    response.chunks.map((chunk) => chunk.toString()),
    ["streamed ", "response"],
  );
  assert.deepEqual(response.getHeader("set-cookie"), [
    "first=one; Path=/",
    "second=two; Path=/",
  ]);
  assert.deepEqual(observedRequest, {
    method: "POST",
    url: "http://localhost/conversations?cursor=next",
    body: "request body",
  });
});

test("filters hop-by-hop headers and headers nominated by Connection", async () => {
  let requestHeaders;
  const adapter = new NodeHttpAdapter(async (request) => {
    requestHeaders = request.headers;
    return new Response("ok", {
      headers: {
        connection: "x-response-private",
        "x-response-private": "secret",
        "x-end-to-end": "visible",
      },
    });
  });
  const request = createIncoming({
    headers: {
      connection: "x-request-private",
      "x-request-private": "secret",
      "x-end-to-end": "visible",
    },
  });
  const response = new MemoryResponse();

  await adapter.handle(request, response);

  assert.equal(requestHeaders.has("connection"), false);
  assert.equal(requestHeaders.has("x-request-private"), false);
  assert.equal(requestHeaders.get("x-end-to-end"), "visible");
  assert.equal(response.getHeader("connection"), undefined);
  assert.equal(response.getHeader("x-response-private"), undefined);
  assert.equal(response.getHeader("x-end-to-end"), "visible");
});

test("cancels the Fetch response body for a HEAD request", async () => {
  let cancelled = false;
  const adapter = new NodeHttpAdapter(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const request = createIncoming({ method: "HEAD" });
  const response = new MemoryResponse();

  await adapter.handle(request, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body(), "");
  assert.equal(cancelled, true);
});

test("aborts the Fetch request when the client disconnects", async () => {
  let requestSignal;
  let markAborted;
  const aborted = new Promise((resolve) => {
    markAborted = resolve;
  });
  const adapter = new NodeHttpAdapter(
    (request) =>
      new Promise((resolve, reject) => {
        requestSignal = request.signal;
        request.signal.addEventListener(
          "abort",
          () => {
            markAborted(request.signal.reason);
            reject(request.signal.reason);
          },
          { once: true },
        );
      }),
  );
  const request = createIncoming();
  const response = new MemoryResponse();
  const handling = adapter.handle(request, response);

  response.destroy();
  await handling;

  assert.equal(requestSignal.aborted, true);
  assert.equal((await aborted).message, "Client disconnected.");
  assert.equal(request.listenerCount("close"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("does not invoke the Fetch handler after a transport is already closed", async () => {
  let handlerCalled = false;
  const adapter = new NodeHttpAdapter(() => {
    handlerCalled = true;
    return new Response("unexpected");
  });
  const request = createIncoming();
  const response = new MemoryResponse();
  response.destroy();

  await adapter.handle(request, response);

  assert.equal(handlerCalled, false);
});

test("propagates handler errors and removes transport listeners", async () => {
  const adapter = new NodeHttpAdapter(() => {
    throw new Error("handler failed");
  });
  const request = createIncoming();
  const response = new MemoryResponse();

  await assert.rejects(adapter.handle(request, response), /handler failed/);

  assert.equal(request.listenerCount("close"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

function createIncoming({
  method = "GET",
  url = "/",
  headers = {},
  body = "",
} = {}) {
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  request.method = method;
  request.url = url;
  request.headers = headers;
  request.complete = true;
  return request;
}

class MemoryResponse extends Writable {
  statusCode = 200;
  statusMessage;
  headers = new Map();
  chunks = [];

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  getHeader(name) {
    return this.headers.get(name.toLowerCase());
  }

  body() {
    return Buffer.concat(this.chunks).toString();
  }
}
