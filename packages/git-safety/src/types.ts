export const SAVEPOINT_REF_NAMESPACE = "refs/joko/savepoints/";

export const DEFAULT_GIT_SAFETY_SETTINGS: GitSafetySettings = Object.freeze({
  autoSnapshotEnabled: false
});

export interface GitSafetySettings {
  readonly autoSnapshotEnabled: boolean;
}

export type GitSafetyGapKind =
  | "missing_baseline"
  | "capture_failed"
  | "unsupported_file"
  | "external_writer"
  | "concurrent_change";

export type GitSafetyGapReason =
  | "baseline_unavailable"
  | "repository_changed"
  | "peer_session_overlap"
  | "git_operation_in_progress"
  | "conflicted_paths"
  | "filtered_path_changed"
  | "status_unavailable"
  | "savepoint_failed";

export interface GitSafetyGap {
  readonly kind: GitSafetyGapKind;
  readonly reason: GitSafetyGapReason;
  readonly phase: "turn_start" | "turn_settled";
  readonly sessionId: string;
  readonly runId: string;
  readonly relativePaths: readonly string[];
}

export type GitSafetyBoundaryStatus =
  | "disabled"
  | "not_repository"
  | "captured"
  | "unchanged"
  | "gap";

export interface GitSafetyBoundaryOutcome {
  readonly status: GitSafetyBoundaryStatus;
  readonly commit?: string;
  readonly gaps: readonly GitSafetyGap[];
}

export interface GitSafetyTurnBoundaryInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly workspaceRoot: string;
}

export interface GitSafetyCoordinatorStatus {
  readonly pendingTurns: number;
  readonly trackedSessions: number;
  readonly trackedRepositories: number;
  readonly cleanupAvailable: boolean;
}

export interface GitSafetyCleanupResult {
  readonly removedSessions: number;
  readonly repositoriesVisited: number;
}

export interface GitSafetyLogger {
  readonly debug: (message: string, metadata?: Readonly<Record<string, unknown>>) => void;
  readonly info: (message: string, metadata?: Readonly<Record<string, unknown>>) => void;
  readonly warn: (message: string, metadata?: Readonly<Record<string, unknown>>) => void;
}

export interface SkippedPathFingerprint {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
  readonly inode: number;
}
