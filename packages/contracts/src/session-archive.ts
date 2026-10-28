export interface SessionArchivePreview {
  readonly hasWorktree: boolean;
  readonly dirty: boolean;
  readonly activeBoundScheduleCount: number;
  readonly activeBoundScheduleNames: readonly string[];
  readonly archiveConfirmation: string;
}

/** Reject incomplete projections: a failed automation query never means zero bindings. */
export function readSessionArchivePreview(value: SessionArchivePreview): SessionArchivePreview {
  if (typeof value.hasWorktree !== "boolean" || typeof value.dirty !== "boolean"
    || (!value.hasWorktree && value.dirty)
    || !Number.isSafeInteger(value.activeBoundScheduleCount) || value.activeBoundScheduleCount < 0
    || !Array.isArray(value.activeBoundScheduleNames) || value.activeBoundScheduleNames.length > 20
    || value.activeBoundScheduleNames.length > value.activeBoundScheduleCount
    || value.activeBoundScheduleNames.some((name) => typeof name !== "string" || name.length > 160)
    || !/^[a-f0-9]{64}$/u.test(value.archiveConfirmation)) {
    throw new Error("The task archive preview is incomplete. Refresh it before continuing.");
  }
  return Object.freeze({
    hasWorktree: value.hasWorktree, dirty: value.dirty,
    activeBoundScheduleCount: value.activeBoundScheduleCount,
    activeBoundScheduleNames: Object.freeze([...value.activeBoundScheduleNames]),
    archiveConfirmation: value.archiveConfirmation
  });
}
