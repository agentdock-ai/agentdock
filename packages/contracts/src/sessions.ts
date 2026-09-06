import type { Message } from "./messages.js";

export interface AgentSessionRecord {
  sessionId: string;
  messages: Message[];
}
