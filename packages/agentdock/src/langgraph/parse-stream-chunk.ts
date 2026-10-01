export type StreamMode = "messages" | "tools" | "updates";

export interface StreamChunk {
  mode: StreamMode;
  value: unknown;
  namespace?: string[];
}

export function parseStreamChunk(value: unknown): StreamChunk {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) {
    throw new Error("LangGraph emitted an unsupported stream chunk.");
  }
  const namespaced = value.length === 3;
  const namespace = namespaced ? value[0] : undefined;
  if (
    namespaced &&
    (!Array.isArray(namespace) ||
      !namespace.every((part) => typeof part === "string"))
  )
    throw new Error("LangGraph emitted an invalid stream namespace.");
  const mode = value[namespaced ? 1 : 0];
  const chunk = value[namespaced ? 2 : 1];
  if (mode !== "messages" && mode !== "tools" && mode !== "updates") {
    throw new Error("LangGraph emitted an unsupported stream mode.");
  }
  return { mode, value: chunk, ...(namespaced ? { namespace } : {}) };
}
