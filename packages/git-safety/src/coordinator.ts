import { resolve } from "node:path";

import { detectRepositoryRoot, type GitCommandRunner } from "./git-command.js";
import {
  InvalidSavepointIdentifierError,
  ShadowSavepointService,
  SnapshotBlockedError,
  type ShadowSavepointResult
} from "./shadow-savepoint.js";
import type {
  GitSafetyBoundaryOutcome,
  GitSafetyCleanupResult,
  GitSafetyCoordinatorStatus,
  GitSafetyGap,
  GitSafetyGapReason,
  GitSafetyLogger,
  GitSafetyTurnBoundaryInput,
  SkippedPathFingerprint
} from "./types.js";

interface TurnRecord {
  readonly input: GitSafetyTurnBoundaryInput;
  readonly enabled: boolean;
  startPromise: Promise<GitSafetyBoundaryOutcome>;
  repositoryRoot?: string;
  baselineCommit?: string;
  baselineFingerprints?: readonly SkippedPathFingerprint[];
  startGap?: GitSafetyGap;
  overlappedWithPeer?: boolean;
  gapPublished?: boolean;
}

export interface GitSafetyCoordinatorOptions {
  readonly runner: GitCommandRunner;
  readonly savepoints?: GitSafetySavepointPort;
  readonly readAutoSnapshotEnabled: () => boolean;
  readonly resolveRepository?: (workspaceRoot: string) => Promise<string | null>;
  readonly onGap?: (gap: GitSafetyGap) => Promise<void> | void;
  readonly logger?: GitSafetyLogger;
}

export interface GitSafetySavepointPort {
  create(repositoryRoot: string, input: Parameters<ShadowSavepointService["create"]>[1]): Promise<ShadowSavepointResult>;
  appendGap(repositoryRoot: string, input: Parameters<ShadowSavepointService["appendGap"]>[1]): Promise<string | null>;
  deleteSessionChain(repositoryRoot: string, sessionId: string): Promise<void>;
  deleteRepositoryNamespace?(repositoryRoot: string): Promise<number>;
}

export class GitSafetyCleanupBusyError extends Error {
  constructor(readonly pendingTurns: number) {
    super("Workspace savepoints cannot be cleaned while turns are active.");
    this.name = "GitSafetyCleanupBusyError";
  }
}

const SILENT_LOGGER: GitSafetyLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined
});

export class GitSafetyCoordinator {
  readonly #savepoints: GitSafetySavepointPort;
  readonly #readAutoSnapshotEnabled: () => boolean;
  readonly #resolveRepository: (workspaceRoot: string) => Promise<string | null>;
  readonly #onGap: ((gap: GitSafetyGap) => Promise<void> | void) | undefined;
  readonly #logger: GitSafetyLogger;
  readonly #records = new Map<string, TurnRecord>();
  readonly #activeByRepository = new Map<string, Set<TurnRecord>>();
  readonly #sessionRepositories = new Map<string, Set<string>>();
  readonly #closedSessions = new Set<string>();

  constructor(options: GitSafetyCoordinatorOptions) {
    this.#savepoints = options.savepoints ?? new ShadowSavepointService(options.runner);
    this.#readAutoSnapshotEnabled = options.readAutoSnapshotEnabled;
    this.#resolveRepository = options.resolveRepository ?? ((workspaceRoot) => detectRepositoryRoot(workspaceRoot, options.runner));
    this.#onGap = options.onGap;
    this.#logger = options.logger ?? SILENT_LOGGER;
  }

  onTurnStart(input: GitSafetyTurnBoundaryInput): Promise<GitSafetyBoundaryOutcome> {
    if (this.#closedSessions.has(input.sessionId)) {
      return Promise.resolve({ status: "disabled", gaps: [] });
    }
    const key = turnKey(input);
    const existing = this.#records.get(key);
    if (existing !== undefined) return existing.startPromise;
    const enabled = this.#readAutoSnapshotEnabled();
    const record: TurnRecord = {
      input,
      enabled,
      startPromise: Promise.resolve({ status: "disabled", gaps: [] })
    };
    record.startPromise = this.#captureTurnStart(record);
    this.#records.set(key, record);
    return record.startPromise;
  }

  async onTurnSettled(input: GitSafetyTurnBoundaryInput): Promise<GitSafetyBoundaryOutcome> {
    if (this.#closedSessions.has(input.sessionId)) return { status: "disabled", gaps: [] };
    const key = turnKey(input);
    let record = this.#records.get(key);
    if (record === undefined) {
      const enabled = this.#readAutoSnapshotEnabled();
      if (!enabled) return { status: "disabled", gaps: [] };
      record = {
        input,
        enabled,
        startPromise: Promise.resolve({ status: "gap", gaps: [] })
      };
      const repositoryRoot = await this.#resolveRepository(input.workspaceRoot).catch(() => null);
      if (repositoryRoot !== null) {
        record.repositoryRoot = repositoryRoot;
        this.#rememberRepository(input.sessionId, repositoryRoot);
        record.startGap = gapFor(record, "baseline_unavailable", "turn_settled");
      }
      this.#records.set(key, record);
    }

    try {
      await record.startPromise;
      if (!record.enabled) return { status: "disabled", gaps: [] };
      if (record.repositoryRoot === undefined) {
        if (record.startGap !== undefined) return { status: "gap", gaps: [record.startGap] };
        return { status: "not_repository", gaps: [] };
      }

      const currentRepository = await this.#resolveRepository(input.workspaceRoot).catch(() => null);
      if (currentRepository === null || repositoryKey(currentRepository) !== repositoryKey(record.repositoryRoot)) {
        return await this.#finishWithGap(record, gapFor(record, "repository_changed", "turn_settled"));
      }
      if (record.startGap !== undefined) return await this.#finishWithGap(record, record.startGap);
      if (record.baselineCommit === undefined) {
        return await this.#finishWithGap(record, gapFor(record, "baseline_unavailable", "turn_settled"));
      }
      if (record.overlappedWithPeer === true) {
        return await this.#finishWithGap(record, gapFor(record, "peer_session_overlap", "turn_settled"));
      }

      let after: ShadowSavepointResult;
      try {
        after = await this.#savepoints.create(record.repositoryRoot, {
          sessionId: input.sessionId,
          runId: input.runId,
          kind: "after_edit",
          baselineCommit: record.baselineCommit,
          skipIfTreeEquals: record.baselineCommit
        });
      } catch (error) {
        return await this.#finishWithGap(record, gapFor(record, reasonForSnapshotError(error), "turn_settled"));
      }

      const filteredChanges = changedFingerprintPaths(record.baselineFingerprints ?? [], after.skippedFingerprints);
      if (filteredChanges.length > 0) {
        return await this.#finishWithGap(
          record,
          gapFor(record, "filtered_path_changed", "turn_settled", filteredChanges)
        );
      }
      this.#logger.debug("Git safety turn-settled savepoint completed.", {
        sessionId: input.sessionId,
        runId: input.runId,
        changed: after.commit !== null
      });
      return {
        status: after.commit === null ? "unchanged" : "captured",
        ...(after.commit === null ? {} : { commit: after.commit }),
        gaps: []
      };
    } catch {
      const gap = gapFor(record, "savepoint_failed", "turn_settled");
      await this.#publishGap(record, gap);
      return { status: "gap", gaps: [gap] };
    } finally {
      this.#records.delete(key);
      this.#unregisterActive(record);
    }
  }

  abortTurn(input: Pick<GitSafetyTurnBoundaryInput, "sessionId" | "runId">): void {
    const key = `${input.sessionId}\0${input.runId}`;
    const record = this.#records.get(key);
    if (record === undefined) return;
    this.#records.delete(key);
    this.#unregisterActive(record);
  }

  hasPendingTurn(input: Pick<GitSafetyTurnBoundaryInput, "sessionId" | "runId">): boolean {
    return this.#records.has(`${input.sessionId}\0${input.runId}`);
  }

  status(): GitSafetyCoordinatorStatus {
    const repositories = new Set<string>();
    for (const values of this.#sessionRepositories.values()) {
      for (const repository of values) repositories.add(repositoryKey(repository));
    }
    return {
      pendingTurns: this.#records.size,
      trackedSessions: this.#sessionRepositories.size,
      trackedRepositories: repositories.size,
      cleanupAvailable: this.#records.size === 0 && repositories.size > 0
    };
  }

  async cleanupAll(): Promise<GitSafetyCleanupResult> {
    if (this.#records.size > 0) throw new GitSafetyCleanupBusyError(this.#records.size);
    const repositories = new Map<string, string>();
    for (const values of this.#sessionRepositories.values()) {
      for (const repository of values) repositories.set(repositoryKey(repository), repository);
    }
    const removedSessions = this.#sessionRepositories.size;
    if (this.#savepoints.deleteRepositoryNamespace !== undefined) {
      await Promise.all([...repositories.values()].map((repository) =>
        this.#savepoints.deleteRepositoryNamespace!(repository).catch(() => 0)));
    } else {
      const jobs: Promise<void>[] = [];
      for (const [sessionId, values] of this.#sessionRepositories) {
        for (const repository of values) {
          jobs.push(this.#savepoints.deleteSessionChain(repository, sessionId).catch(() => undefined));
        }
      }
      await Promise.all(jobs);
    }
    this.#sessionRepositories.clear();
    this.#closedSessions.clear();
    return { removedSessions, repositoriesVisited: repositories.size };
  }

  async closeSession(sessionId: string): Promise<void> {
    this.#closedSessions.add(sessionId);
    const records = [...this.#records.entries()].filter(([, record]) => record.input.sessionId === sessionId);
    await Promise.allSettled(records.map(([, record]) => record.startPromise));
    for (const [key, record] of records) {
      this.#records.delete(key);
      this.#unregisterActive(record);
    }
    const repositories = [...(this.#sessionRepositories.get(sessionId) ?? [])];
    this.#sessionRepositories.delete(sessionId);
    await Promise.all(repositories.map((repositoryRoot) => this.#savepoints
      .deleteSessionChain(repositoryRoot, sessionId)
      .catch(() => undefined)));
  }

  async #captureTurnStart(record: TurnRecord): Promise<GitSafetyBoundaryOutcome> {
    if (!record.enabled) return { status: "disabled", gaps: [] };
    try {
      const repositoryRoot = await this.#resolveRepository(record.input.workspaceRoot);
      if (repositoryRoot === null) return { status: "not_repository", gaps: [] };
      record.repositoryRoot = repositoryRoot;
      this.#rememberRepository(record.input.sessionId, repositoryRoot);
      this.#registerActive(record);
      try {
        const baseline = await this.#savepoints.create(repositoryRoot, {
          sessionId: record.input.sessionId,
          runId: record.input.runId,
          kind: "turn_start"
        });
        if (baseline.commit === null) {
          const gap = gapFor(record, "baseline_unavailable", "turn_start");
          record.startGap = gap;
          await this.#publishGap(record, gap);
          return { status: "gap", gaps: [gap] };
        }
        record.baselineCommit = baseline.commit;
        record.baselineFingerprints = baseline.skippedFingerprints;
        this.#logger.debug("Git safety turn-start savepoint completed.", {
          sessionId: record.input.sessionId,
          runId: record.input.runId
        });
        return { status: "captured", commit: baseline.commit, gaps: [] };
      } catch (error) {
        const gap = gapFor(record, reasonForSnapshotError(error), "turn_start");
        record.startGap = gap;
        await this.#publishGap(record, gap);
        return { status: "gap", gaps: [gap] };
      }
    } catch {
      const gap = gapFor(record, "savepoint_failed", "turn_start");
      record.startGap = gap;
      await this.#publishGap(record, gap);
      return { status: "gap", gaps: [gap] };
    }
  }

  async #finishWithGap(record: TurnRecord, gap: GitSafetyGap): Promise<GitSafetyBoundaryOutcome> {
    if (record.repositoryRoot !== undefined) {
      await this.#savepoints.appendGap(record.repositoryRoot, {
        sessionId: record.input.sessionId,
        runId: record.input.runId,
        reason: gap.reason
      }).catch(() => null);
    }
    await this.#publishGap(record, gap);
    return { status: "gap", gaps: [gap] };
  }

  async #publishGap(record: TurnRecord, gap: GitSafetyGap): Promise<void> {
    if (record.gapPublished === true) return;
    record.gapPublished = true;
    this.#logger.warn("Git safety recorded a typed rewind gap.", {
      sessionId: gap.sessionId,
      runId: gap.runId,
      reason: gap.reason,
      phase: gap.phase,
      pathCount: gap.relativePaths.length
    });
    try {
      await this.#onGap?.(gap);
    } catch {
      this.#logger.warn("Git safety gap publication failed without blocking the turn.", {
        sessionId: gap.sessionId,
        runId: gap.runId,
        reason: gap.reason
      });
    }
  }

  #registerActive(record: TurnRecord): void {
    const repositoryRoot = record.repositoryRoot;
    if (repositoryRoot === undefined) return;
    const key = repositoryKey(repositoryRoot);
    const active = this.#activeByRepository.get(key);
    if (active === undefined) {
      this.#activeByRepository.set(key, new Set([record]));
      return;
    }
    const peers = [...active].filter((candidate) => candidate.input.sessionId !== record.input.sessionId);
    if (peers.length > 0) {
      record.overlappedWithPeer = true;
      for (const peer of peers) peer.overlappedWithPeer = true;
    }
    active.add(record);
  }

  #unregisterActive(record: TurnRecord): void {
    const repositoryRoot = record.repositoryRoot;
    if (repositoryRoot === undefined) return;
    const key = repositoryKey(repositoryRoot);
    const active = this.#activeByRepository.get(key);
    if (active === undefined) return;
    active.delete(record);
    if (active.size === 0) this.#activeByRepository.delete(key);
  }

  #rememberRepository(sessionId: string, repositoryRoot: string): void {
    const existing = this.#sessionRepositories.get(sessionId);
    if (existing === undefined) this.#sessionRepositories.set(sessionId, new Set([repositoryRoot]));
    else existing.add(repositoryRoot);
  }
}

function turnKey(input: Pick<GitSafetyTurnBoundaryInput, "sessionId" | "runId">): string {
  return `${input.sessionId}\0${input.runId}`;
}

function repositoryKey(repositoryRoot: string): string {
  const absolute = resolve(repositoryRoot);
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

function reasonForSnapshotError(error: unknown): GitSafetyGapReason {
  if (error instanceof SnapshotBlockedError) {
    if (error.reason === "conflict") return "conflicted_paths";
    if (error.reason === "status_unavailable") return "status_unavailable";
    return "git_operation_in_progress";
  }
  if (error instanceof InvalidSavepointIdentifierError) return "savepoint_failed";
  return "savepoint_failed";
}

function gapFor(
  record: TurnRecord,
  reason: GitSafetyGapReason,
  phase: GitSafetyGap["phase"],
  relativePaths: readonly string[] = []
): GitSafetyGap {
  const kind = reason === "baseline_unavailable"
    ? "missing_baseline"
    : reason === "peer_session_overlap"
      ? "external_writer"
      : reason === "filtered_path_changed"
        ? "unsupported_file"
        : reason === "repository_changed"
          ? "concurrent_change"
          : "capture_failed";
  return {
    kind,
    reason,
    phase,
    sessionId: record.input.sessionId,
    runId: record.input.runId,
    relativePaths
  };
}

function changedFingerprintPaths(
  before: readonly SkippedPathFingerprint[],
  after: readonly SkippedPathFingerprint[]
): readonly string[] {
  const beforeByPath = new Map(before.map((item) => [item.relativePath, item]));
  const afterByPath = new Map(after.map((item) => [item.relativePath, item]));
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  return [...paths].filter((pathValue) => {
    const left = beforeByPath.get(pathValue);
    const right = afterByPath.get(pathValue);
    return left === undefined || right === undefined ||
      left.sizeBytes !== right.sizeBytes ||
      left.modifiedAtMs !== right.modifiedAtMs ||
      left.changedAtMs !== right.changedAtMs ||
      left.inode !== right.inode;
  }).sort();
}
