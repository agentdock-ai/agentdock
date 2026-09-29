import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { z } from "zod";
import { runtime } from "./agent.js";

const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    conversationId: z.string().uuid(),
    message: z.string().trim().min(1).max(8_000),
  }),
  z.object({
    action: z.literal("resume"),
    conversationId: z.string().uuid(),
    decisions: z
      .array(
        z.object({
          type: z.enum(["approve", "reject"]),
          message: z.string().optional(),
        }),
      )
      .min(1),
  }),
]);

const demoUserId = process.env.DEMO_USER_ID ?? "local-demo-user";
const maxBodyBytes = 64 * 1024;

createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/agent") {
    response.writeHead(404).end("Not found");
    return;
  }

  try {
    const body = requestSchema.parse(await readJson(request, maxBodyBytes));
    const threadId = deriveThreadId(demoUserId, body.conversationId);
    const context = { userId: demoUserId };

    if (body.action === "start") {
      await runtime.pipe(response, {
        threadId,
        context,
        input: { messages: [{ role: "user", content: body.message }] },
      });
      return;
    }

    await runtime.pipe(response, {
      threadId,
      context,
      resume: { decisions: body.decisions },
    });
  } catch (error) {
    if (response.headersSent || response.destroyed) return;
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof RequestBodyError
          ? error.status
          : 500;
    const message =
      status === 413
        ? "Request body is too large"
        : status === 400
          ? "Invalid request"
          : "Request failed";
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify({ error: message }));
  }
}).listen(Number(process.env.PORT ?? 3000), () => {
  console.info(
    `Agentdock demo listening on http://localhost:${process.env.PORT ?? 3000}`,
  );
});

function deriveThreadId(userId: string, conversationId: string): string {
  return createHash("sha256")
    .update(`${userId}:${conversationId}`)
    .digest("hex");
}

async function readJson(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit)
      throw new RequestBodyError(413, "Request body is too large.");
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestBodyError(400, "Request body must be valid JSON.");
  }
}

class RequestBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}
