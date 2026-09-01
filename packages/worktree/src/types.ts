import type { WorktreeErrorShape } from "./errors.js";

export const MAXIMUM_WORKTREE_SESSION_ID_CHARACTERS = 256;
export const MAXIMUM_WORKTREE_SOURCE_REF_CHARACTERS = 1_024;

export interface WorktreeCallOptions {
  readonly signal?: AbortSignal;
  /** Whole-operation wall-clock budget. */
  readonly timeoutMs?: number;
}

export interface WorktreeInitializeOptions extends WorktreeCallOptions {
  /** Live Product Sessions whose existing leases must be restored for use. */
  readonly retainSessionIds?: readonly string[];
  /** Archived Product Sessions whose branch/snapshot ownership remains restorable. */
  readonly preserveSessionIds?: readonly string[];
}

export interface WorktreeSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export interface WorktreeFailure {
  readonly ok: false;
  readonly error: WorktreeErrorShape;
}

export type WorktreeResult<T> = WorktreeSuccess<T> | WorktreeFailure;

export interface WorktreeCwdDetection {
  readonly cwd: string;
  readonly repositoryRoot: string;
  readonly gitCommonDirectory: string;
  readonly currentBranch?: string;
  readonly headCommit: string;
  readonly isLinkedWorktree: boolean;
}

export interface WorktreeSourceResolution {
  readonly ref: string;
  readonly commit: string;
  readonly refreshed: boolean;
  readonly strategy:
    | "explicit"
    | "remote_default_refreshed"
    | "remote_default_local"
    | "current_branch"
    | "local_default"
    | "head";
  readonly remote?: string;
  readonly reason?: string;
}

export interface WorktreeLease {
  readonly id: string;
  readonly sessionId: string;
  readonly path: string;
  readonly repositoryRoot: string;
  readonly branch: string;
  readonly source: WorktreeSourceResolution;
  readonly acquiredAt: number;
}

export interface WorktreeAcquireRequest {
  readonly sessionId: string;
  /** Repository root or an ordinary directory inside its primary checkout. */
  readonly cwd: string;
  /** Optional commit-ish. Omit to resolve the repository's preferred task base. */
  readonly sourceRef?: string;
  /** Bounded best-effort refresh of the remote default branch. */
  readonly refreshRemote?: boolean;
}

export interface WorktreeAcquisition {
  readonly lease: WorktreeLease;
  readonly existing: boolean;
}

export interface WorktreeRelease {
  readonly status: "destroyed" | "not_found" | "preserved";
  readonly reason?: "branch_changed" | "dirty" | "keep" | "restorable";
  readonly pathRemoved?: boolean;
  readonly branchPreserved?: boolean;
}

export interface WorktreeReleaseOptions extends WorktreeCallOptions {
  /** Retain the exact owner record so the same Session can rebuild this checkout. */
  readonly retainForRestore?: boolean;
}

export interface WorktreeSourceOption {
  readonly ref: string;
  readonly commit: string;
  readonly name: string;
  readonly kind: "local" | "remote";
  readonly current: boolean;
}

export interface WorktreeSweepRecord {
  readonly id: string;
  readonly path: string;
  readonly repositoryRoot: string;
  readonly status: "preserved" | "removed";
  readonly reason?: string;
}

export interface WorktreeInitialization {
  readonly storageRoot: string;
  readonly removed: number;
  readonly preserved: number;
  readonly records: readonly WorktreeSweepRecord[];
}

export interface WorktreeServiceSnapshot {
  readonly initialized: boolean;
  readonly active: readonly WorktreeLease[];
  readonly residualCount: number;
}
