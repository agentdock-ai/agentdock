import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { test } from "vitest";
import { Agentdock } from "../../src/index.js";

test("a silent graph survives an HTTP proxy inactivity deadline with SSE heartbeats", async ({
  skip,
}) => {
  const runtime = new Agentdock(
    {
      async getState() {
        return { values: {} };
      },
      async *stream() {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      },
    },
    { heartbeatMs: 100 },
  );
  const upstream = createServer((_request, response) => {
    void runtime.pipe(response, { threadId: "proxy", input: {} });
  });
  try {
    await new Promise((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      skip("Loopback sockets are blocked.");
      return;
    }
    throw error;
  }
  const proxy = createServer((_request, response) => {
    const request = get(
      `http://127.0.0.1:${upstream.address().port}`,
      (source) => {
        response.writeHead(source.statusCode, source.headers);
        source.pipe(response);
      },
    );
    request.setTimeout(500, () =>
      request.destroy(new Error("Proxy inactivity deadline")),
    );
    request.on("error", (error) => response.destroy(error));
  });
  try {
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /run.completed/);
    assert.ok(body.split(": ping\n\n").length > 10);
  } finally {
    if (proxy.listening) await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
}, 10000);
