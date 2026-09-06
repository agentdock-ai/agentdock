import { AgentEventType as AgentEventTypeValue } from "@agentdock/contracts";

export const AgentEventType = AgentEventTypeValue;
export type {
  AgentError,
  AgentEvent,
  AgentEventBase,
  AgentEventPayload,
} from "@agentdock/contracts";
export type AgentEventType = import("@agentdock/contracts").AgentEventType;
