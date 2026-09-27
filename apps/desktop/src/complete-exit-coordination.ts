import type { SourceAwareVoiceLease } from "./dedicated-hardware-action/voice-lease.js";

export type CompleteExitOperation = () => void | Promise<void>;

/**
 * Starts every complete-exit leg and waits for all of them to settle before
 * surfacing the first failure. Recovery must not overlap a still-running stop.
 */
export async function settleCompleteExitOperations(
  operations: readonly CompleteExitOperation[]
): Promise<void> {
  const results = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation))
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure !== undefined) throw failure.reason;
}

/**
 * Cancels the currently owned generation through its normal exact-generation
 * stop protocol. A failed or timed-out stop remains uncertain and blocks a new
 * generation after an aborted exit.
 */
export async function settleGlobalVoiceForExit<Source>(
  lease: Pick<SourceAwareVoiceLease<Source>, "snapshot" | "cancelAll" | "settle">
): Promise<void> {
  if (lease.snapshot().state === "idle") return;
  lease.cancelAll();
  await lease.settle();
  if (lease.snapshot().state !== "idle") {
    throw new Error("Global voice cancellation was not acknowledged.");
  }
}
