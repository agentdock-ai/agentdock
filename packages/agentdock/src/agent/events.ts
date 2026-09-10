import { AgentEventType as AgentEventTypeValue } from "@agentdock/contracts";

export {
  AGENT_EVENT_PROTOCOL_VERSION,
  assertAgentEventInput,
  cloneAgentEvent,
  cloneAgentEventInput,
} from "@agentdock/contracts";

export const AgentEventType = AgentEventTypeValue;
export type {
  AgentEvent,
  AgentEventBase,
  AgentEventInput,
  AgentReducerState,
  ContentPart,
  AgentInterrupt,
  AgentUsage,
} from "@agentdock/contracts";
export type AgentEventType = import("@agentdock/contracts").AgentEventType;
