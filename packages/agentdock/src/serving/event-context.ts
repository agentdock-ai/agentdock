import {
  AGENT_EVENT_PROTOCOL_VERSION,
  type AgentEvent,
  type AgentEventInput,
} from "@agentdock-ai/contracts";

export class EventContext {
  private logicalSequence: number;
  private phaseSequence = 0;
  readonly phaseId = crypto.randomUUID();

  constructor(
    readonly runId: string,
    readonly sessionId: string,
    logicalSequence: number,
  ) {
    this.logicalSequence = logicalSequence;
  }

  emit(input: AgentEventInput): AgentEvent {
    this.logicalSequence += 1;
    this.phaseSequence += 1;
    return {
      ...input,
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      eventId: `${this.runId}:${this.logicalSequence}`,
      runId: this.runId,
      sessionId: this.sessionId,
      logicalSequence: this.logicalSequence,
      phaseId: this.phaseId,
      sequence: this.phaseSequence,
      timestamp: new Date().toISOString(),
    } as AgentEvent;
  }

  get lastLogicalSequence(): number {
    return this.logicalSequence;
  }
}
