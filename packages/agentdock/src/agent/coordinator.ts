export interface RunCoordinator {
  acquire(input: { sessionKey: string; runId: string }): Promise<{
    release(): Promise<void> | void;
  }>;
}

class InProcessRunCoordinator implements RunCoordinator {
  private readonly sessions = new Map<string, string>();
  private readonly runs = new Set<string>();

  acquire(input: { sessionKey: string; runId: string }): Promise<{
    release(): void;
  }> {
    if (this.runs.has(input.runId)) {
      throw new Error(`Agent run is already active: ${input.runId}`);
    }
    if (this.sessions.has(input.sessionKey)) {
      throw new Error(
        `Agent session already has an active run: ${input.sessionKey}`,
      );
    }

    this.runs.add(input.runId);
    this.sessions.set(input.sessionKey, input.runId);
    let released = false;
    return Promise.resolve({
      release: () => {
        if (released) return;
        released = true;
        this.runs.delete(input.runId);
        if (this.sessions.get(input.sessionKey) === input.runId) {
          this.sessions.delete(input.sessionKey);
        }
      },
    });
  }
}

export const defaultRunCoordinator: RunCoordinator =
  new InProcessRunCoordinator();

export function createSessionKey(
  sessionId: string,
  sessionNamespace: string | undefined,
): string {
  return encodeURIComponent(
    JSON.stringify([sessionNamespace ?? null, sessionId]),
  ).replace(/\*/g, "%2A");
}

export function createThreadId(
  sessionId: string,
  sessionNamespace: string | undefined,
): string {
  return createSessionKey(sessionId, sessionNamespace);
}
