import { Agentdock } from "@agentdock-ai/agentdock";
import type {
  GraphContext,
  GraphInput,
  Run,
  ServableCompiledGraph,
} from "@agentdock-ai/agentdock";
import type { IncomingMessage, ServerResponse } from "node:http";
import { InvalidRequestError, hasOnlyKey, readObjectBody } from "./request.js";
import { matchRoute, normalizeBasePath } from "./routes.js";
import { errorResponse, toJsonValue } from "./responses.js";
import type { AgentdockServerOptions, Authorization, Route } from "./types.js";
import { sendNodeError } from "../transports/node/send-error.js";

type NodeHandler = (request: IncomingMessage, response: ServerResponse) => void;

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
      void import("../transports/node/node-bridge.js")
        .then(({ handleNodeRequest }) =>
          handleNodeRequest(request, response, (webRequest) =>
            this.handle(webRequest),
          ),
        )
        .catch(() => sendNodeError(response));
    };
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const route = matchRoute(request, this.basePath);
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
      return await this.agent.toResponse(
        this.makeRun(route, body[key], authorization, request),
      );
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        return errorResponse(400, "invalid_request", error.message);
      }
      return errorResponse(500, "internal_error", "Request failed.");
    }
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
      return { ...shared, input: bodyValue as GraphInput<Graph> };
    }
    return { ...shared, resume: bodyValue };
  }
}
