import type { AgentRunResult } from "@agentdock-ai/contracts";

/**
 * Indicates that execution reached a terminal outcome but Core could not
 * persist the corresponding checkpoint snapshot.
 */
export class AgentCheckpointPersistenceError extends Error {
  readonly code = "agent_checkpoint_persistence_failed" as const;
  readonly executionCause: unknown;
  readonly persistenceCause: unknown;
  readonly result: AgentRunResult;
  declare readonly cause: unknown;

  constructor(
    result: AgentRunResult,
    persistenceCause: unknown,
    executionCause: unknown = undefined,
  ) {
    const persistenceMessage =
      persistenceCause instanceof Error
        ? persistenceCause.message
        : String(persistenceCause);
    super(
      `Agent run ${result.runId} reached ${result.status} but checkpoint persistence failed: ${persistenceMessage}`,
    );
    this.name = "AgentCheckpointPersistenceError";
    this.cause = persistenceCause;
    this.executionCause = executionCause;
    this.persistenceCause = persistenceCause;
    this.result = result;
  }
}
