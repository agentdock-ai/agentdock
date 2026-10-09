import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface NodeHttpAdapterOptions {
  /** Base URL used when resolving relative request URLs. Defaults to localhost. */
  baseUrl?: string | URL;
}

/** Bridges Node HTTP streams to and from any Fetch-compatible request handler. */
export class NodeHttpAdapter {
  private readonly baseUrl: URL;

  constructor(
    private readonly handler: FetchHandler,
    options: NodeHttpAdapterOptions = {},
  ) {
    this.baseUrl = new URL(options.baseUrl ?? "http://localhost");
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: string | URL = request.url ?? "/",
  ): Promise<void> {
    if (response.destroyed || (request.destroyed && !request.complete)) return;

    const controller = new AbortController();
    const onRequestClose = () => {
      if (!request.complete)
        controller.abort(new Error("Client closed the request."));
    };
    const onResponseClose = () => {
      if (!response.writableEnded)
        controller.abort(new Error("Client disconnected."));
    };

    request.once("close", onRequestClose);
    response.once("close", onResponseClose);

    try {
      const webRequest = this.createRequest(
        request,
        new URL(url, this.baseUrl),
        controller.signal,
      );
      const webResponse = await this.handler(webRequest);
      await this.writeResponse(
        request,
        response,
        webResponse,
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      request.off("close", onRequestClose);
      response.off("close", onResponseClose);
    }
  }

  private createRequest(
    request: IncomingMessage,
    url: URL,
    signal: AbortSignal,
  ): Request {
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers: toWebHeaders(request.headers),
      signal,
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }
    return new Request(url, init);
  }

  private async writeResponse(
    request: IncomingMessage,
    response: ServerResponse,
    webResponse: Response,
    signal: AbortSignal,
  ): Promise<void> {
    response.statusCode = webResponse.status;
    if (webResponse.statusText) response.statusMessage = webResponse.statusText;
    setResponseHeaders(response, webResponse.headers);

    if (!webResponse.body || request.method === "HEAD") {
      await webResponse.body?.cancel();
      response.end();
      return;
    }

    await pipeline(Readable.fromWeb(webResponse.body), response, { signal });
  }
}

function toWebHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  const excluded = getExcludedHeaders(headers.connection);
  for (const [name, value] of Object.entries(headers)) {
    if (excluded.has(name)) continue;
    if (typeof value === "string") {
      result.set(name, value);
    } else if (Array.isArray(value)) {
      if (name === "set-cookie") {
        for (const cookie of value) result.append(name, cookie);
      } else {
        result.set(name, value.join(", "));
      }
    }
  }
  return result;
}

function setResponseHeaders(response: ServerResponse, headers: Headers): void {
  const excluded = getExcludedHeaders(headers.get("connection"));
  for (const [name, value] of headers) {
    if (name !== "set-cookie" && !excluded.has(name))
      response.setHeader(name, value);
  }
  const cookies = headers.getSetCookie();
  if (cookies.length > 0 && !excluded.has("set-cookie"))
    response.setHeader("set-cookie", cookies);
}

function getExcludedHeaders(
  connection: string | string[] | null | undefined,
): Set<string> {
  const excluded = new Set(hopByHopHeaders);
  const values = Array.isArray(connection) ? connection : [connection];
  for (const value of values) {
    for (const name of value?.split(",") ?? []) {
      const normalized = name.trim().toLowerCase();
      if (normalized) excluded.add(normalized);
    }
  }
  return excluded;
}
