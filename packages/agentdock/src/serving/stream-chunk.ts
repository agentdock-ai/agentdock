export type StreamMode = "messages" | "tools" | "updates";

export interface StreamChunk {
  mode: StreamMode;
  value: unknown;
}

export function parseStreamChunk(value: unknown): StreamChunk | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [mode, chunk] = value;
  if (mode !== "messages" && mode !== "tools" && mode !== "updates") {
    return null;
  }
  return { mode, value: chunk };
}
