export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Agentdock Conversation API",
    version: "1.0.0",
    description:
      "Public HTTP endpoints provided by the @agentdock-ai/conversations handler, commonly bridged into a Node server with Agentdock's NodeHttpAdapter. Includes thread management, streaming turns, approvals, history, and attachments. The host application owns authentication and authorization.",
  },
  servers: [{ url: "/" }],
  tags: [{ name: "Threads" }, { name: "Messages" }, { name: "Attachments" }],
  paths: {
    "/conversations": {
      get: {
        tags: ["Threads"],
        summary: "List threads",
        parameters: [{ $ref: "#/components/parameters/Cursor" }],
        responses: {
          "200": {
            description: "A page of threads and its next cursor, if any.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ThreadPage" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "503": { $ref: "#/components/responses/ServiceUnavailable" },
        },
      },
      post: {
        tags: ["Threads"],
        summary: "Create a thread",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { title: { type: "string", maxLength: 200 } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "The created thread.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    thread: { $ref: "#/components/schemas/Thread" },
                  },
                  required: ["thread"],
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "503": { $ref: "#/components/responses/ServiceUnavailable" },
        },
      },
    },
    "/conversations/{threadId}": {
      parameters: [{ $ref: "#/components/parameters/ThreadId" }],
      patch: {
        tags: ["Threads"],
        summary: "Rename a thread",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { title: { type: "string", maxLength: 200 } },
                required: ["title"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The updated thread.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    thread: { $ref: "#/components/schemas/Thread" },
                  },
                  required: ["thread"],
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/conversations/{threadId}/history": {
      get: {
        tags: ["Messages"],
        summary: "Get thread history and execution state",
        parameters: [
          { $ref: "#/components/parameters/ThreadId" },
          { $ref: "#/components/parameters/Cursor" },
        ],
        responses: {
          "200": {
            description:
              "Messages, pagination cursor, pending approvals, and available actions.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ConversationHistory" },
              },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/conversations/{threadId}/start": {
      post: {
        tags: ["Messages"],
        summary: "Start a prompt and stream conversation events",
        description:
          "Returns Server-Sent Events. Each data line contains a JSON ConversationEvent envelope.",
        parameters: [{ $ref: "#/components/parameters/ThreadId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/StartRequest" },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/EventStream" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { $ref: "#/components/responses/Conflict" },
          "503": { $ref: "#/components/responses/ServiceUnavailable" },
        },
      },
    },
    "/conversations/{threadId}/continue": {
      post: {
        tags: ["Messages"],
        summary: "Continue a paused run and stream events",
        parameters: [{ $ref: "#/components/parameters/ThreadId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ContinueRequest" },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/EventStream" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { $ref: "#/components/responses/Conflict" },
          "503": { $ref: "#/components/responses/ServiceUnavailable" },
        },
      },
    },
    "/conversations/{threadId}/approvals": {
      post: {
        tags: ["Messages"],
        summary: "Submit approval decisions and resume a run",
        parameters: [{ $ref: "#/components/parameters/ThreadId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApprovalRequest" },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/EventStream" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { $ref: "#/components/responses/Conflict" },
          "503": { $ref: "#/components/responses/ServiceUnavailable" },
        },
      },
    },
    "/conversations/{threadId}/stop": {
      post: {
        tags: ["Messages"],
        summary: "Stop an active operation",
        parameters: [{ $ref: "#/components/parameters/ThreadId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/StopRequest" },
            },
          },
        },
        responses: {
          "204": {
            description: "The operation stopped and was durably settled.",
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { $ref: "#/components/responses/Conflict" },
          "503": { $ref: "#/components/responses/ServiceUnavailable" },
        },
      },
    },
    "/conversations/{threadId}/attachments": {
      post: {
        tags: ["Attachments"],
        summary: "Upload an image attachment",
        parameters: [{ $ref: "#/components/parameters/ThreadId" }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: { file: { type: "string", format: "binary" } },
                required: ["file"],
              },
            },
          },
        },
        responses: {
          "201": {
            description:
              "The uploaded attachment and its message content reference.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AttachmentUpload" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
          "413": { $ref: "#/components/responses/BadRequest" },
        },
      },
    },
    "/conversations/{threadId}/attachments/{attachmentId}": {
      parameters: [
        { $ref: "#/components/parameters/ThreadId" },
        { $ref: "#/components/parameters/AttachmentId" },
      ],
      get: {
        tags: ["Attachments"],
        summary: "Download an attachment",
        responses: {
          "200": {
            description:
              "Attachment bytes with the original supported image media type.",
            content: {
              "image/png": { schema: { type: "string", format: "binary" } },
              "image/jpeg": { schema: { type: "string", format: "binary" } },
              "image/gif": { schema: { type: "string", format: "binary" } },
              "image/webp": { schema: { type: "string", format: "binary" } },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["Attachments"],
        summary: "Delete an attachment",
        responses: {
          "204": { description: "The attachment was deleted." },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
  },
  components: {
    parameters: {
      ThreadId: {
        name: "threadId",
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
      AttachmentId: {
        name: "attachmentId",
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
      Cursor: {
        name: "cursor",
        in: "query",
        required: false,
        description: "Opaque cursor returned by the previous page.",
        schema: { type: "string" },
      },
    },
    schemas: {
      Thread: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "title", "createdAt", "updatedAt"],
      },
      ThreadPage: {
        type: "object",
        properties: {
          protocolVersion: { const: 1 },
          threads: {
            type: "array",
            items: { $ref: "#/components/schemas/Thread" },
          },
          nextCursor: { type: ["string", "null"] },
        },
        required: ["protocolVersion", "threads", "nextCursor"],
      },
      ConversationHistory: {
        type: "object",
        description:
          "History includes paginated messages, execution state, pending native controls, and available actions.",
        properties: {
          protocolVersion: { const: 1 },
          thread: { $ref: "#/components/schemas/Thread" },
          messages: { type: "array", items: { type: "object" } },
          nextCursor: { type: ["string", "null"] },
          snapshotId: { type: "string" },
          execution: { type: ["object", "null"] },
          nativeControls: { type: "object" },
          interrupts: { type: "array", items: { type: "object" } },
          actions: { type: "object" },
        },
        required: [
          "protocolVersion",
          "thread",
          "messages",
          "nextCursor",
          "snapshotId",
          "execution",
          "nativeControls",
          "interrupts",
          "actions",
        ],
      },
      StartRequest: {
        type: "object",
        properties: {
          operationId: { type: "string", minLength: 1 },
          threadId: { type: "string", minLength: 1 },
          prompt: { type: "string", maxLength: 100000 },
          attachments: {
            type: "array",
            maxItems: 16,
            items: { type: "string", minLength: 1 },
          },
        },
        required: ["operationId", "threadId", "prompt", "attachments"],
      },
      ContinueRequest: {
        type: "object",
        properties: {
          operationId: { type: "string", minLength: 1 },
          threadId: { type: "string", minLength: 1 },
          pendingOperationId: { type: "string", minLength: 1 },
        },
        required: ["operationId", "threadId", "pendingOperationId"],
      },
      ApprovalRequest: {
        type: "object",
        properties: {
          operationId: { type: "string", minLength: 1 },
          threadId: { type: "string", minLength: 1 },
          interruptId: { type: "string", minLength: 1 },
          decisions: { type: "array", maxItems: 64 },
        },
        required: ["operationId", "threadId", "interruptId", "decisions"],
      },
      StopRequest: {
        type: "object",
        properties: {
          operationId: { type: "string", minLength: 1 },
          threadId: { type: "string", minLength: 1 },
          targetOperationId: { type: "string", minLength: 1 },
        },
        required: ["operationId", "threadId", "targetOperationId"],
      },
      AttachmentUpload: {
        type: "object",
        properties: {
          id: { type: "string" },
          threadId: { type: "string" },
          name: { type: "string" },
          mimeType: {
            type: "string",
            enum: ["image/png", "image/jpeg", "image/gif", "image/webp"],
          },
          size: { type: "integer" },
          url: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          content: { type: "object" },
        },
        required: [
          "id",
          "threadId",
          "name",
          "mimeType",
          "size",
          "url",
          "createdAt",
          "content",
        ],
      },
      ApiError: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
        required: ["code", "message"],
      },
    },
    responses: {
      EventStream: {
        description:
          "Server-Sent Events; each data line is a JSON ConversationEvent envelope containing protocolVersion, operationId, threadId, and event.",
        content: {
          "text/event-stream": {
            schema: { type: "string" },
            example:
              'data: {"protocolVersion":1,"operationId":"...","threadId":"...","event":{"type":"run.started"}}\n\n',
          },
        },
      },
      BadRequest: {
        description: "The request is invalid or its payload is too large.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiError" },
          },
        },
      },
      NotFound: {
        description: "The thread or attachment was not found.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiError" },
          },
        },
      },
      Conflict: {
        description: "The operation conflicts with current thread state.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiError" },
          },
        },
      },
      ServiceUnavailable: {
        description: "Persistence or execution is unavailable.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiError" },
          },
        },
      },
    },
  },
} as const;

export const swaggerUiHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agentdock Conversation API</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.1/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.1/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui" });
    </script>
  </body>
</html>`;
