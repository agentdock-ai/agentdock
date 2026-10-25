export class ThreadBusyError extends Error {
  readonly status = 409;
  readonly code = "thread_busy";
  constructor() {
    super("A run is already active on this thread.");
    this.name = "ThreadBusyError";
  }
}
export type ReleaseThread = () => void | Promise<void>;
/** Shared lock implementations must reject conflicts before returning a lease. */
export interface ThreadLock {
  acquire(threadId: string): ReleaseThread | Promise<ReleaseThread>;
}
class InProcessThreadLock implements ThreadLock {
  private readonly active = new Set<string>();
  acquire(threadId: string): ReleaseThread {
    if (this.active.has(threadId)) throw new ThreadBusyError();
    this.active.add(threadId);
    return () => {
      this.active.delete(threadId);
    };
  }
}
const locks = new WeakMap<object, ThreadLock>();
export function resolveThreadLock(
  owner: object,
  option: "none" | "in-process" | ThreadLock = "in-process",
): ThreadLock | undefined {
  if (option === "none") return undefined;
  if (option !== "in-process") {
    if (!option || typeof option.acquire !== "function")
      throw new Error(
        "threadLock must be none, in-process, or a lock with acquire().",
      );
    return option;
  }
  let lock = locks.get(owner);
  if (!lock) {
    lock = new InProcessThreadLock();
    locks.set(owner, lock);
  }
  return lock;
}
