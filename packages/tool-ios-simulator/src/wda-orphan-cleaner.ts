import { inspectWdaOrphanProcesses, verifyWdaOrphanGroup,
  type WdaOrphanInspectionInput } from "./wda-orphan-inspector.js";

const EXIT_BUDGET_MS = 5_000;
const EXIT_POLL_MS = 25;

export type WdaOrphanCleanupErrorCode = "CONFLICT" | "TERMINATION_FAILED" | "CANCELLED";

export class WdaOrphanCleanupError extends Error {
  constructor(readonly code: WdaOrphanCleanupErrorCode, message: string) { super(message); }
}

export interface WdaOrphanGroupControl {
  signal(groupId: number, signal: NodeJS.Signals): void;
  isAlive(groupId: number): boolean;
}

export interface WdaOrphanCleanupInput extends WdaOrphanInspectionInput {
  readonly groupControl?: WdaOrphanGroupControl;
  readonly clock?: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
}

function defaultGroupControl(): WdaOrphanGroupControl {
  return {
    signal(groupId, signal) { process.kill(-groupId, signal); },
    isAlive(groupId) {
      try { process.kill(-groupId, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    }
  };
}

function defaultClock(): NonNullable<WdaOrphanCleanupInput["clock"]> {
  return { now: () => Date.now(), sleep: (ms, signal) => new Promise((resolveSleep, reject) => {
    if (signal?.aborted) { reject(new WdaOrphanCleanupError("CANCELLED", "Driver cleanup was cancelled.")); return; }
    const onAbort = (): void => { clearTimeout(timer);
      reject(new WdaOrphanCleanupError("CANCELLED", "Driver cleanup was cancelled.")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolveSleep(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  }) };
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WdaOrphanCleanupError("CANCELLED", "Driver cleanup was cancelled.");
}

/** Recover only exact v1-owned detached groups; the caller must hold durable instance admission. */
export async function cleanupWdaOrphanProcesses(input: WdaOrphanCleanupInput): Promise<void> {
  const group = input.groupControl ?? defaultGroupControl();
  const clock = input.clock ?? defaultClock();
  const initial = await inspectWdaOrphanProcesses(input);
  if (initial.conflict) throw new WdaOrphanCleanupError("CONFLICT", "Another driver owns this simulator.");
  for (const groupId of initial.ownedGroupIds) {
    cancelled(input.signal);
    if (!await verifyWdaOrphanGroup(input, groupId)) continue;
    cancelled(input.signal);
    let vanished = false;
    try { group.signal(groupId, "SIGKILL"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ESRCH") vanished = true;
      else throw new WdaOrphanCleanupError("TERMINATION_FAILED", "Owned driver process could not be terminated.");
    }
    if (vanished) continue;
    const deadline = clock.now() + EXIT_BUDGET_MS;
    try {
      while (group.isAlive(groupId)) {
        cancelled(input.signal);
        const remaining = deadline - clock.now();
        if (remaining <= 0) throw new WdaOrphanCleanupError("TERMINATION_FAILED", "Owned driver process is still running.");
        await clock.sleep(Math.min(EXIT_POLL_MS, remaining), input.signal);
      }
    } catch (error) {
      if (error instanceof WdaOrphanCleanupError) throw error;
      throw new WdaOrphanCleanupError("TERMINATION_FAILED", "Owned driver process exit could not be verified.");
    }
  }
  const final = await inspectWdaOrphanProcesses(input);
  if (final.conflict) throw new WdaOrphanCleanupError("CONFLICT", "Another driver owns this simulator.");
  if (final.ownedGroupIds.length > 0) {
    throw new WdaOrphanCleanupError("TERMINATION_FAILED", "Owned driver process is still running.");
  }
}
