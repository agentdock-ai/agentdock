import assert from "node:assert/strict";
import { get } from "node:http";
import { createServer } from "node:http";
import { test } from "vitest";
import { NodeHttpAdapter } from "../../src/transports/node/http-adapter.js";

test("bridges request and response streams and preserves multiple cookies", async ({
  skip,
}) => {
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
  const server = createAdapterServer(adapter);
  const baseUrl = await listen(server, skip);

  try {
    const response = await fetch(`${baseUrl}/conversations?cursor=next`, {
      method: "POST",
      body: "request body",
      headers: { "content-type": "text/plain" },
    });

    assert.equal(response.status, 201);
    assert.equal(await response.text(), "streamed response");
    assert.deepEqual(response.headers.getSetCookie(), [
      "first=one; Path=/",
      "second=two; Path=/",
    ]);
    assert.deepEqual(observedRequest, {
      method: "POST",
      url: `${baseUrl}/conversations?cursor=next`,
      body: "request body",
    });
  } finally {
    await close(server);
  }
});

test("filters hop-by-hop headers and headers nominated by Connection", async ({
  skip,
}) => {
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
  const server = createServer((request, response) => {
    void adapter.handle(request, response).catch((error) => {
      response.destroy(error);
    });
  });
  const baseUrl = await listen(server, skip);

  try {
    const response = await fetch(baseUrl, {
      headers: {
        connection: "x-request-private",
        "x-request-private": "secret",
        "x-end-to-end": "visible",
      },
    });

    assert.equal(requestHeaders.has("connection"), false);
    assert.equal(requestHeaders.has("x-request-private"), false);
    assert.equal(requestHeaders.get("x-end-to-end"), "visible");
    assert.equal(response.headers.has("connection"), false);
    assert.equal(response.headers.has("x-response-private"), false);
    assert.equal(response.headers.get("x-end-to-end"), "visible");
  } finally {
    await close(server);
  }
});

test("cancels the Fetch response body for a HEAD request", async ({ skip }) => {
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
  const server = createAdapterServer(adapter);
  const baseUrl = await listen(server, skip);

  try {
    const response = await fetch(baseUrl, { method: "HEAD" });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
    assert.equal(cancelled, true);
  } finally {
    await close(server);
  }
});

test("aborts the Fetch request when the client disconnects", async ({
  skip,
}) => {
  let markStarted;
  let markAborted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise((resolve) => {
    markAborted = resolve;
  });
  const adapter = new NodeHttpAdapter(
    (request) =>
      new Promise((resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => {
            markAborted(request.signal.reason);
            reject(request.signal.reason);
          },
          { once: true },
        );
        markStarted();
      }),
  );
  const server = createAdapterServer(adapter);
  const baseUrl = await listen(server, skip);
  const clientRequest = get(baseUrl);

  try {
    await started;
    clientRequest.destroy();
    const reason = await Promise.race([
      aborted,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Abort was not propagated")), 1_000),
      ),
    ]);
    assert.equal(reason.message, "Client disconnected.");
  } finally {
    clientRequest.destroy();
    await close(server);
  }
});

function createAdapterServer(adapter) {
  return createServer((request, response) => {
    void adapter.handle(request, response).catch((error) => {
      if (!response.headersSent) response.statusCode = 500;
      response.end(error.message);
    });
  });
}

async function listen(server, skip) {
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM")
      skip("The environment blocks loopback sockets.");
    throw error;
  }
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
