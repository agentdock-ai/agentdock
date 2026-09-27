import {
  AGENT_EVENT_PROTOCOL_VERSION,
  assertAgentEventInput,
  type AgentEvent,
  type AgentEventInput,
} from "@agentdock-ai/contracts";

export class EventContext {
  private logicalSequence: number;
  private phaseSequence = 0;
  private currentPhaseId = crypto.randomUUID();

  constructor(
    readonly runId: string,
    readonly sessionId: string,
    logicalSequence: number,
  ) {
    this.logicalSequence = logicalSequence;
  }

  emit(input: AgentEventInput): AgentEvent {
    assertAgentEventInput(input);
    this.logicalSequence += 1;
    this.phaseSequence += 1;
    // The contract assertion checks the event payload before protocol metadata
    // completes the corresponding AgentEvent variant.
    return {
      ...input,
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      eventId: `${this.runId}:${this.logicalSequence}`,
      runId: this.runId,
      sessionId: this.sessionId,
      logicalSequence: this.logicalSequence,
      phaseId: this.currentPhaseId,
      sequence: this.phaseSequence,
      timestamp: new Date().toISOString(),
    } as AgentEvent;
  }

  /** Starts a new LangGraph phase and resets its local event sequence. */
  advancePhase(): void {
    this.currentPhaseId = crypto.randomUUID();
    this.phaseSequence = 0;
  }

  get lastLogicalSequence(): number {
    return this.logicalSequence;
  }
}
