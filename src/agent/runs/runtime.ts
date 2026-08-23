const controllers = new Map<string, AbortController>();

export function registerRunController(runId: string): AbortSignal {
  const controller = new AbortController();
  controllers.set(runId, controller);
  return controller.signal;
}

export function stopRunController(runId: string): boolean {
  const controller = controllers.get(runId);
  if (!controller) return false;
  controller.abort(new Error("Agent run cancelled"));
  controllers.delete(runId);
  return true;
}

export function clearRunController(runId: string): void {
  controllers.delete(runId);
}
