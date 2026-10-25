import {
  assertConversationApprovalRequest,
  assertConversationContinueRequest,
  assertConversationStartRequest,
  assertConversationStopRequest,
  type ConversationEventEnvelope,
} from "@agentdock-ai/contracts";
import { openApiDocument, swaggerUiHtml } from "./openapi.js";
import { type ConversationService } from "./service.js";
import { createEventResponse } from "@agentdock-ai/agentdock";

export interface ConversationHttpOptions<Input> {
  service: ConversationService<Input>;
  resolveActor(request: Request): string | Promise<string>;
  maxBodyBytes?: number;
  /** SSE comment interval. Defaults to 15000; 0 disables. */
  heartbeatMs?: number;
}

/** Fetch-compatible Node handler. Authentication and authorization remain host-owned. */
export function createConversationHttpHandler<Input>(
  options: ConversationHttpOptions<Input>,
): (request: Request) => Promise<Response> {
  const maxBodyBytes = options.maxBodyBytes ?? 128 * 1024;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0)
    throw new Error("heartbeatMs must be a non-negative safe integer.");
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1024 ||
    maxBodyBytes > 1024 * 1024
  )
    throw new Error("maxBodyBytes must be between 1024 and 1048576.");

  return async (request) => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname
        .split("/")
        .filter(Boolean)
        .map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            throw httpError(400, "Request path is invalid.");
          }
        });
      if (request.method === "GET" && parts.length === 1) {
        if (parts[0] === "openapi.json") return json(openApiDocument);
        if (parts[0] === "docs")
          return new Response(swaggerUiHtml, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
      }

      const actorId = await options.resolveActor(request);
      if (parts[0] !== "conversations")
        return json({ code: "not_found", message: "Route not found." }, 404);
      if (parts.length === 1 && request.method === "GET") {
        return json(
          await options.service.listThreads(
            actorId,
            url.searchParams.get("cursor"),
          ),
        );
      }
      if (parts.length === 1 && request.method === "POST") {
        const body = await readJson(request, maxBodyBytes);
        if (
          !isObject(body) ||
          (body.title !== undefined && typeof body.title !== "string")
        )
          throw httpError(400, "title must be a string.");
        const title =
          typeof body.title === "string" ? body.title : "New conversation";
        return json(
          { thread: await options.service.createThread(actorId, title) },
          201,
        );
      }
      if (parts.length === 2 && request.method === "PATCH") {
        const body = await readJson(request, maxBodyBytes);
        if (!isObject(body) || typeof body.title !== "string")
          throw httpError(400, "title is required.");
        return json({
          thread: await options.service.renameThread(
            actorId,
            parts[1],
            body.title,
          ),
        });
      }
      if (
        parts.length === 3 &&
        parts[2] === "attachments" &&
        request.method === "POST"
      ) {
        const upload = await readUpload(
          request,
          options.service.maxAttachmentSizeBytes,
        );
        const attachment = await options.service.uploadAttachment(
          actorId,
          parts[1],
          upload,
        );
        return json(
          {
            ...attachment,
            content: {
              type: "image",
              url: attachment.url,
              mimeType: attachment.mimeType,
            },
          },
          201,
        );
      }
      if (
        parts.length === 4 &&
        parts[2] === "attachments" &&
        request.method === "GET"
      ) {
        const result = await options.service.readAttachment(
          actorId,
          parts[1],
          parts[3],
        );
        return new Response(result.bytes, {
          headers: {
            "content-type": result.attachment.mimeType,
            "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(result.attachment.name).replace(/'/g, "%27")}`,
            "x-content-type-options": "nosniff",
            "cache-control": "private, max-age=3600",
          },
        });
      }
      if (
        parts.length === 4 &&
        parts[2] === "attachments" &&
        request.method === "DELETE"
      ) {
        await options.service.deleteAttachment(actorId, parts[1], parts[3]);
        return new Response(null, { status: 204 });
      }
      if (
        parts.length === 3 &&
        parts[2] === "history" &&
        request.method === "GET"
      ) {
        return json(
          await options.service.getHistory(
            actorId,
            parts[1],
            url.searchParams.get("cursor"),
          ),
        );
      }
      if (parts.length === 3 && request.method === "POST") {
        const body = await readJson(request, maxBodyBytes);
        if (!isObject(body))
          throw httpError(400, "Request body must be an object.");
        if (body.threadId !== parts[1])
          throw httpError(400, "threadId must match the URL.");
        if (parts[2] === "start") {
          validateRequest(body, assertConversationStartRequest);
          return await createEventResponse(
            (signal) => options.service.start(actorId, body, signal),
            {
              signal: request.signal,
              heartbeatMs,
              isTerminal: terminalEnvelope,
            },
          );
        }
        if (parts[2] === "continue") {
          validateRequest(body, assertConversationContinueRequest);
          return await createEventResponse(
            (signal) => options.service.continue(actorId, body, signal),
            {
              signal: request.signal,
              heartbeatMs,
              isTerminal: terminalEnvelope,
            },
          );
        }
        if (parts[2] === "approvals") {
          validateRequest(body, assertConversationApprovalRequest);
          return await createEventResponse(
            (signal) =>
              options.service.respondToInterrupt(actorId, body, signal),
            {
              signal: request.signal,
              heartbeatMs,
              isTerminal: terminalEnvelope,
            },
          );
        }
        if (parts[2] === "stop") {
          validateRequest(body, assertConversationStopRequest);
          await options.service.stop(actorId, body);
          return new Response(null, { status: 204 });
        }
      }
      return json({ code: "not_found", message: "Route not found." }, 404);
    } catch (error) {
      const tagged = isObject(error) && typeof error.status === "number";
      const status = tagged ? (error.status as number) : 503;
      const message =
        tagged && error instanceof Error
          ? error.message
          : status === 503
            ? "Conversation persistence is unavailable."
            : "Invalid request.";
      // Keep specific core codes so clients can explain the conflict.
      const specific =
        tagged &&
        typeof error.code === "string" &&
        passthroughCodes.has(error.code)
          ? error.code
          : undefined;
      const code =
        specific ??
        (status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : status === 503
              ? "persistence_failed"
              : "invalid_request");
      return json({ code, message }, status);
    }
  };
}

const passthroughCodes = new Set(["approval_expired", "thread_busy"]);

async function readJson(
  request: Request,
  maxBodyBytes: number,
): Promise<unknown> {
  const bytes = await readBoundedBody(request, maxBodyBytes);
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }
}

async function readUpload(request: Request, maxFileBytes: number) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;"))
    throw httpError(400, "Upload must use multipart form data.");
  const bytes = await readBoundedBody(request, maxFileBytes + 64 * 1024);
  const copy = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: bytes,
  });
  let form: FormData;
  try {
    form = await copy.formData();
  } catch {
    throw httpError(400, "Upload must contain valid multipart form data.");
  }
  if (form.getAll("file").length !== 1)
    throw httpError(400, "Upload exactly one image.");
  const file = form.get("file");
  if (!(file instanceof Blob))
    throw httpError(400, "Choose an image to upload.");
  if (file.size > maxFileBytes)
    throw httpError(413, "Image exceeds the configured size limit.");
  return {
    name:
      typeof File !== "undefined" && file instanceof File ? file.name : "image",
    mimeType: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

async function readBoundedBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array> {
  const statedLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(statedLength) && statedLength > maximum)
    throw httpError(413, "Request body is too large.");
  if (!request.body) throw httpError(400, "Request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw httpError(413, "Request body is too large.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function json(value: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ protocolVersion: 1, ...asObject(value) }),
    {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>;
  return { data: value };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpError(
  status: number,
  message: string,
): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function validateRequest<T>(
  value: unknown,
  validate: (value: unknown) => asserts value is T,
): asserts value is T {
  try {
    validate(value);
  } catch (error) {
    throw httpError(
      400,
      error instanceof Error ? error.message : "Invalid request.",
    );
  }
}

function terminalEnvelope(envelope: ConversationEventEnvelope): boolean {
  return (
    envelope.event.type === "run.completed" ||
    envelope.event.type === "run.failed" ||
    envelope.event.type === "run.cancelled"
  );
}
