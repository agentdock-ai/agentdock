import { InvalidRequestError } from "./request.js";
import type { Route } from "./types.js";

export function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("?")) {
    throw new Error("basePath must be an absolute URL path.");
  }
  const normalized = trimmed.replace(/\/+$/, "");
  return normalized || "/";
}

export function matchRoute(
  request: Request,
  basePathValue: string,
): Route | null {
  const pathname = new URL(request.url).pathname;
  const basePath = basePathValue === "/" ? "" : basePathValue;
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
