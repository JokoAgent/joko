import type { SessionView, TimelineItemView } from "./model.js";

const ACTIVE_RUNTIME_RECOVERY_STATES = new Set<NonNullable<TimelineItemView["runtimeRecovery"]>["state"]>([
  "waiting",
  "running"
]);

const ERROR_OWNING_RUNTIME_RECOVERY_STATES = new Set<NonNullable<TimelineItemView["runtimeRecovery"]>["state"]>([
  "waiting",
  "running",
  "succeeded",
  "failed"
]);

export function activeRuntimeRecovery(
  items: readonly TimelineItemView[]
): NonNullable<TimelineItemView["runtimeRecovery"]> | undefined {
  let active: TimelineItemView | undefined;
  for (const item of items) {
    if (
      item.runtimeRecovery === undefined
      || !ACTIVE_RUNTIME_RECOVERY_STATES.has(item.runtimeRecovery.state)
    ) continue;
    if (active === undefined || item.sequence >= active.sequence) active = item;
  }
  return active?.runtimeRecovery;
}

/**
 * Internal continuation prompts and their claimed terminal errors are product
 * bookkeeping. The durable recovery row is the single user-facing owner.
 */
export function projectRuntimeRecoveryTimeline(
  items: readonly TimelineItemView[]
): readonly TimelineItemView[] {
  const claimedErrorRunIds = new Set<string>();
  for (const item of items) {
    const recovery = item.runtimeRecovery;
    if (recovery !== undefined && ERROR_OWNING_RUNTIME_RECOVERY_STATES.has(recovery.state)) {
      claimedErrorRunIds.add(recovery.sourceRunId);
    }
  }
  return items.filter((item) => {
    if (item.automaticContinuation !== undefined) return false;
    if (item.runtimeRecovery?.state === "cancelled") return false;
    return item.kind !== "error" || item.runId === undefined || !claimedErrorRunIds.has(item.runId);
  });
}

/** During a bounded reconnect, stale error state and attention must not compete with live progress. */
export function projectSessionRuntimeRecovery(
  session: SessionView,
  items: readonly TimelineItemView[]
): SessionView {
  if (activeRuntimeRecovery(items) === undefined) return session;
  const { attention: _attention, retryRunId: _retryRunId, ...rest } = session;
  return { ...rest, state: "retrying" };
}
