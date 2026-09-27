export type StreamMode = "messages" | "tools" | "updates";

export interface StreamChunk {
  mode: StreamMode;
  value: unknown;
}

export function parseStreamChunk(value: unknown): StreamChunk | null {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("LangGraph emitted an unsupported stream chunk.");
  }
  const [mode, chunk] = value;
  if (mode !== "messages" && mode !== "tools" && mode !== "updates") {
    throw new Error("LangGraph emitted an unsupported stream mode.");
  }
  return { mode, value: chunk };
}
