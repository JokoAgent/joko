import { randomUUID } from "node:crypto";

import { isWorktreeServiceError } from "./errors.js";
import type { WorktreeRecyclePolicy, WorktreeRecycleReason } from "./types.js";

export const MAXIMUM_RECYCLE_FAILURES = 3;
export const MAXIMUM_RECYCLE_FAILED_WORK_MS = 30 * 60_000;

export function newRecyclePolicy(retainForRestore: boolean): WorktreeRecyclePolicy {
  return {
    generation: randomUUID(), retainForRestore, state: "retrying", reason: "pending",
    failures: 0, failedWorkMs: 0, nextAttemptAt: 0
  };
}

export function deferRecycle(
  previous: WorktreeRecyclePolicy,
  reason: WorktreeRecycleReason,
  elapsedMs: number,
  now: number
): WorktreeRecyclePolicy {
  if (reason === "in_use" || reason === "changed" || reason === "kept") {
    return { ...previous, state: reason === "kept" ? "kept" : "waiting", reason, nextAttemptAt: 0 };
  }
  const failures = previous.failures + 1;
  const failedWorkMs = previous.failedWorkMs + Math.max(0, elapsedMs);
  const paused = ["identity", "integrity", "storage"].includes(reason)
    || failures >= MAXIMUM_RECYCLE_FAILURES || failedWorkMs >= MAXIMUM_RECYCLE_FAILED_WORK_MS;
  return {
    ...previous, state: paused ? "paused" : "retrying", reason, failures, failedWorkMs,
    nextAttemptAt: paused ? 0 : now + Math.min(30 * 60_000, 5_000 * 2 ** failures)
  };
}

export function recycleFailureReason(error: unknown): WorktreeRecycleReason {
  const code = isWorktreeServiceError(error) ? error.code : (error as NodeJS.ErrnoException | null)?.code;
  if (code === "STATE_CORRUPT") return "integrity";
  if (code === "PATH_UNSAFE" || code === "STORAGE_UNSAFE" || code === "REPOSITORY_UNSAFE") return "identity";
  if (code === "ENOSPC" || code === "EACCES" || code === "EPERM") return "storage";
  return "failed";
}
