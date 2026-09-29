import { Agentdock } from "@agentdock-ai/agentdock";
import type {
  GraphContext,
  GraphInput,
  GraphRunConfig,
  Run,
  ServableCompiledGraph,
} from "@agentdock-ai/agentdock";
import type { JsonValue } from "@agentdock-ai/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface Authorization<Context extends Record<string, unknown>> {
  context: Context;
  config?: GraphRunConfig;
}

export interface AgentdockServerOptions<Graph extends ServableCompiledGraph> {
  agent: Agentdock<Graph>;
  basePath?: string;
  authorize: (
    request: Request,
    threadId: string,
  ) => Promise<Authorization<GraphContext<Graph>> | null>;
  threads?: {
    listThreads: (options: { request: Request }) => unknown | Promise<unknown>;
  };
}

type NodeHandler = (request: IncomingMessage, response: ServerResponse) => void;

type Route =
  | { kind: "list-threads" }
  | { kind: "run" | "resume" | "messages" | "resume-state"; threadId: string };

/** HTTP routes and transport adapters for an Agentdock instance. */
export class AgentdockServer<Graph extends ServableCompiledGraph> {
  readonly agent: Agentdock<Graph>;
  private readonly basePath: string;
  private readonly authorize: AgentdockServerOptions<Graph>["authorize"];
  private readonly threads: AgentdockServerOptions<Graph>["threads"];

  constructor(options: AgentdockServerOptions<Graph>) {
    this.agent = options.agent;
    this.basePath = normalizeBasePath(options.basePath ?? "/agent");
    this.authorize = options.authorize;
    this.threads = options.threads;
  }

  toHttp(): (request: Request) => Promise<Response> {
    return (request) => this.handle(request);
  }

  toNode(): NodeHandler {
    return (request, response) => {
      void import("./node-bridge.js")
        .then(({ handleNodeRequest }) =>
          handleNodeRequest(request, response, (webRequest) =>
            this.handle(webRequest),
          ),
        )
        .catch(() => {
          sendNodeError(response);
        });
    };
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const route = this.matchRoute(request);
      if (!route) return errorResponse(404, "not_found", "Route not found.");

      if (route.kind === "list-threads") {
        if (!this.threads) {
          return errorResponse(
            501,
            "not_implemented",
            "Thread listing is not configured.",
          );
        }
        const threads = await this.threads.listThreads({ request });
        return Response.json({ threads: toJsonValue(threads) });
      }

      const authorization = await this.authorize(request, route.threadId);
      if (!authorization) {
        return errorResponse(403, "forbidden", "Thread access is forbidden.");
      }

      if (route.kind === "messages") {
        const messages = await this.agent.getMessages(route.threadId);
        if (messages === null) {
          return errorResponse(404, "thread_not_found", "Thread not found.");
        }
        return Response.json({
          threadId: route.threadId,
          messages: toJsonValue(messages),
        });
      }

      if (route.kind === "resume-state") {
        return Response.json({
          threadId: route.threadId,
          state: await this.agent.getResumeState(route.threadId),
        });
      }

      const body = await readObjectBody(request);
      const key = route.kind === "run" ? "input" : "resume";
      if (!hasOnlyKey(body, key)) {
        return errorResponse(
          400,
          "invalid_request",
          `Request body must contain only "${key}".`,
        );
      }
      const run = this.makeRun(route, body[key], authorization, request);
      return await this.agent.toResponse(run);
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        return errorResponse(400, "invalid_request", error.message);
      }
      return errorResponse(500, "internal_error", "Request failed.");
    }
  }

  private matchRoute(request: Request): Route | null {
    const pathname = new URL(request.url).pathname;
    const basePath = this.basePath === "/" ? "" : this.basePath;
    if (pathname === `${basePath}/threads` && request.method === "GET") {
      return { kind: "list-threads" };
    }
    const prefix = `${basePath}/threads/`;
    if (!pathname.startsWith(prefix)) return null;
    const segments = pathname.slice(prefix.length).split("/");
    if (segments.length !== 2) return null;
    let threadId: string;
    try {
      threadId = decodeURIComponent(segments[0]);
    } catch {
      throw new InvalidRequestError("Thread ID is not valid URL encoding.");
    }
    if (!threadId.trim()) return null;
    const [resource] = segments.slice(1);
    if (resource === "runs" && request.method === "POST") {
      return { kind: "run", threadId };
    }
    if (resource === "resume" && request.method === "POST") {
      return { kind: "resume", threadId };
    }
    if (resource === "messages" && request.method === "GET") {
      return { kind: "messages", threadId };
    }
    if (resource === "resume-state" && request.method === "GET") {
      return { kind: "resume-state", threadId };
    }
    return null;
  }

  private makeRun(
    route: Extract<Route, { threadId: string }>,
    bodyValue: unknown,
    authorization: Authorization<GraphContext<Graph>>,
    request: Request,
  ): Run<GraphInput<Graph>, GraphContext<Graph>> {
    const shared = {
      threadId: route.threadId,
      context: authorization.context,
      config: authorization.config,
      signal: request.signal,
    };
    if (route.kind === "run") {
      // The graph owns the input schema; HTTP input is validated as JSON here.
      return { ...shared, input: bodyValue as GraphInput<Graph> };
    }
    return { ...shared, resume: bodyValue };
  }
}

class InvalidRequestError extends Error {}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("?")) {
    throw new Error("basePath must be an absolute URL path.");
  }
  const normalized = trimmed.replace(/\/+$/, "");
  return normalized || "/";
}

async function readObjectBody(
  request: Request,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new InvalidRequestError("Request body must be valid JSON.");
  }
  if (!isRecord(value)) {
    throw new InvalidRequestError("Request body must be a JSON object.");
  }
  return value;
}

function hasOnlyKey(value: Record<string, unknown>, key: string): boolean {
  return (
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function toJsonValue(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") {
    throw new Error("Response data is not JSON-safe.");
  }
  if (ancestors.has(value)) throw new Error("Response data is circular.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => toJsonValue(item, ancestors));
    }
    const toJSON = "toJSON" in value ? value.toJSON : undefined;
    if (typeof toJSON === "function") {
      return toJsonValue(toJSON.call(value), ancestors);
    }
    if (!isRecord(value)) throw new Error("Response data is not JSON-safe.");
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = toJsonValue(item, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

function sendNodeError(response: ServerResponse): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  response.writeHead(500, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(
    JSON.stringify({
      error: { code: "internal_error", message: "Request failed." },
    }),
  );
}
