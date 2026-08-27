import {
  type AgentRunStore,
  InMemoryAgentRunStore,
} from "../runs/store.js";
import {
  type AgentSessionStore,
  InMemoryAgentSessionStore,
} from "../sessions/store.js";

export interface AgentStore {
  readonly runs: AgentRunStore;
  readonly sessions: AgentSessionStore;
}

export class InMemoryAgentStore implements AgentStore {
  readonly runs: AgentRunStore = new InMemoryAgentRunStore();
  readonly sessions: AgentSessionStore = new InMemoryAgentSessionStore();
}
