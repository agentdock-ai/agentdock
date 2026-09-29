import type { ServerResponse } from "node:http";

export function sendNodeError(response: ServerResponse): void {
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
