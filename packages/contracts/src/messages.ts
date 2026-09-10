import type { ContentPart } from "./events.js";

export interface Message {
  role: "user" | "assistant" | "tool" | "system";
  content: ContentPart[];
  id?: string;
}
