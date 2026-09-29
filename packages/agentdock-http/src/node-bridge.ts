import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

type WebHandler = (request: Request) => Promise<Response>;

export async function handleNodeRequest(
  incoming: IncomingMessage & { originalUrl?: string },
  outgoing: ServerResponse,
  handler: WebHandler,
): Promise<void> {
  const abortController = new AbortController();
  const onClose = () => {
    if (!outgoing.writableEnded) {
      abortController.abort(new Error("Client disconnected."));
    }
  };
  outgoing.on("close", onClose);

  try {
    const host = incoming.headers.host ?? "localhost";
    const path = incoming.originalUrl ?? incoming.url ?? "/";
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else if (value !== undefined) {
        headers.set(name, value);
      }
    }
    const method = incoming.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const init = {
      method,
      headers,
      signal: abortController.signal,
      ...(hasBody
        ? {
            body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
            duplex: "half" as const,
          }
        : {}),
    } as RequestInit & { duplex?: "half" };
    const request = new Request(`http://${host}${path}`, init);
    const response = await handler(request);

    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.flushHeaders();
    if (!response.body) {
      outgoing.end();
      return;
    }
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      outgoing,
    );
  } catch {
    if (outgoing.headersSent || outgoing.destroyed) {
      outgoing.destroy();
    } else {
      outgoing.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
      });
      outgoing.end(
        JSON.stringify({
          error: { code: "internal_error", message: "Request failed." },
        }),
      );
    }
  } finally {
    outgoing.off("close", onClose);
  }
}
