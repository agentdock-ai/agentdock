import type { ToolCallRecord, ToolResultRecord } from "./types.js";

export type Message =
  | { role: "user"; content: string; id?: string; userId?: string | null; active?: boolean; compacted?: boolean }
  | { role: "assistant"; content: string; toolCalls?: ToolCallRecord[]; id?: string; active?: boolean; compacted?: boolean }
  | { role: "tool"; content: string; toolResults: ToolResultRecord[]; id?: string; active?: boolean; compacted?: boolean }
  | { role: "system"; content: string; id?: string; active?: boolean; compacted?: boolean };

export interface MemoryProvider {
  add(message: Message): void;
  getAll(): Message[];
  clear(): void;
}

export class InMemoryProvider implements MemoryProvider {
  private messages: Message[] = [];

  add(message: Message): void {
    this.messages.push(message);
  }

  getAll(): Message[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
  }
}
