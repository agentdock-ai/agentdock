import { AgentEventType as AgentEventTypeValue } from "@agentdock-ai/contracts";

export {
  AGENT_EVENT_PROTOCOL_VERSION,
  assertAgentEventInput,
  cloneAgentEvent,
  cloneAgentEventInput,
} from "@agentdock-ai/contracts";

export const AgentEventType = AgentEventTypeValue;
export type {
  AgentEvent,
  AgentEventBase,
  AgentEventInput,
  AgentReducerState,
  ContentPart,
  AgentInterrupt,
  AgentUsage,
} from "@agentdock-ai/contracts";
export type AgentEventType = import("@agentdock-ai/contracts").AgentEventType;
