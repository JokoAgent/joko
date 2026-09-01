import { describe, expect, it, vi } from "vitest";

import { GitSafetyCoordinator, type GitSafetySavepointPort } from "./coordinator.js";
import type { GitCommandRunner } from "./git-command.js";
import { SnapshotBlockedError, type ShadowSavepointResult } from "./shadow-savepoint.js";
import type { GitSafetyGap, SkippedPathFingerprint } from "./types.js";

const UNUSED_RUNNER = {} as GitCommandRunner;

describe("GitSafetyCoordinator", () => {
  it("is default-off and samples the explicit setting at turn start", async () => {
    let enabled = false;
    const port = fakePort();
    const coordinator = new GitSafetyCoordinator({
      runner: UNUSED_RUNNER,
      savepoints: port,
      readAutoSnapshotEnabled: () => enabled,
      resolveRepository: async () => "D:\\repo"
    });

    await expect(coordinator.onTurnStart(turn("session_a", "run_disabled")))
      .resolves.toEqual({ status: "disabled", gaps: [] });
    enabled = true;
    await expect(coordinator.onTurnSettled(turn("session_a", "run_disabled")))
      .resolves.toEqual({ status: "disabled", gaps: [] });
    expect(port.create).not.toHaveBeenCalled();

    await expect(coordinator.onTurnStart(turn("session_a", "run_enabled")))
      .resolves.toMatchObject({ status: "captured", commit: "baseline-session_a-run_enabled" });
    enabled = false;
    await expect(coordinator.onTurnSettled(turn("session_a", "run_enabled")))
      .resolves.toMatchObject({ status: "captured", commit: "after-session_a-run_enabled" });
    expect(port.create).toHaveBeenCalledTimes(2);
  });

  it("degrades every overlapping foreign-session turn in one repository to a typed external-writer gap", async () => {
    const gaps: GitSafetyGap[] = [];
    const port = fakePort();
    const coordinator = new GitSafetyCoordinator({
      runner: UNUSED_RUNNER,
      savepoints: port,
      readAutoSnapshotEnabled: () => true,
      resolveRepository: async () => "D:\\same-repo",
      onGap: (gap) => { gaps.push(gap); }
    });

    await coordinator.onTurnStart(turn("session_a", "run_a"));
    await coordinator.onTurnStart(turn("session_b", "run_b"));
    const [left, right] = await Promise.all([
      coordinator.onTurnSettled(turn("session_a", "run_a")),
      coordinator.onTurnSettled(turn("session_b", "run_b"))
    ]);

    expect(left.gaps[0]).toMatchObject({ kind: "external_writer", reason: "peer_session_overlap" });
    expect(right.gaps[0]).toMatchObject({ kind: "external_writer", reason: "peer_session_overlap" });
    expect(gaps).toHaveLength(2);
    expect(port.create).toHaveBeenCalledTimes(2);
    expect(port.appendGap).toHaveBeenCalledTimes(2);
  });

  it("records a typed unsupported-file gap when a filtered path changes across the turn", async () => {
    const before = fingerprint(".env.local", 1);
    const after = fingerprint(".env.local", 2);
    const port = fakePort({ baselineFingerprints: [before], afterFingerprints: [after] });
    const coordinator = new GitSafetyCoordinator({
      runner: UNUSED_RUNNER,
      savepoints: port,
      readAutoSnapshotEnabled: () => true,
      resolveRepository: async () => "D:\\repo"
    });

    await coordinator.onTurnStart(turn("session_a", "run_a"));
    const outcome = await coordinator.onTurnSettled(turn("session_a", "run_a"));
    expect(outcome).toEqual({
      status: "gap",
      gaps: [{
        kind: "unsupported_file",
        reason: "filtered_path_changed",
        phase: "turn_settled",
        sessionId: "session_a",
        runId: "run_a",
        relativePaths: [".env.local"]
      }]
    });
    expect(port.appendGap).toHaveBeenCalledWith("D:\\repo", expect.objectContaining({
      reason: "filtered_path_changed"
    }));
  });

  it("swallows snapshot and gap-sink failures while retaining a specific blocked-state gap", async () => {
    const port = fakePort();
    port.create.mockRejectedValueOnce(new SnapshotBlockedError("rebase"));
    const coordinator = new GitSafetyCoordinator({
      runner: UNUSED_RUNNER,
      savepoints: port,
      readAutoSnapshotEnabled: () => true,
      resolveRepository: async () => "D:\\repo",
      onGap: () => { throw new Error("sink unavailable"); }
    });

    await expect(coordinator.onTurnStart(turn("session_a", "run_a"))).resolves.toMatchObject({
      status: "gap",
      gaps: [expect.objectContaining({ reason: "git_operation_in_progress" })]
    });
    await expect(coordinator.onTurnSettled(turn("session_a", "run_a"))).resolves.toMatchObject({
      status: "gap",
      gaps: [expect.objectContaining({ reason: "git_operation_in_progress" })]
    });
  });

  it("creates a missing-baseline marker after recovery and removes hidden refs when a session closes", async () => {
    const port = fakePort();
    const coordinator = new GitSafetyCoordinator({
      runner: UNUSED_RUNNER,
      savepoints: port,
      readAutoSnapshotEnabled: () => true,
      resolveRepository: async () => "D:\\repo"
    });

    const recovered = await coordinator.onTurnSettled(turn("session_a", "recovered_run"));
    expect(recovered.gaps[0]).toMatchObject({ kind: "missing_baseline", reason: "baseline_unavailable" });
    expect(port.appendGap).toHaveBeenCalledTimes(1);

    await coordinator.onTurnStart(turn("session_a", "run_a"));
    await coordinator.closeSession("session_a");
    expect(coordinator.hasPendingTurn({ sessionId: "session_a", runId: "run_a" })).toBe(false);
    expect(port.deleteSessionChain).toHaveBeenCalledWith("D:\\repo", "session_a");
  });

  it("reports bounded status and clears every tracked repository namespace only while idle", async () => {
    const port = fakePort();
    const coordinator = new GitSafetyCoordinator({
      runner: UNUSED_RUNNER,
      savepoints: port,
      readAutoSnapshotEnabled: () => true,
      resolveRepository: async (workspaceRoot) => workspaceRoot.endsWith("one") ? "D:\\repo-one" : "D:\\repo-two"
    });

    await coordinator.onTurnStart(turn("session_a", "run_one", "D:\\workspace-one"));
    expect(coordinator.status()).toEqual({
      pendingTurns: 1,
      trackedSessions: 1,
      trackedRepositories: 1,
      cleanupAvailable: false
    });
    await expect(coordinator.cleanupAll()).rejects.toMatchObject({ pendingTurns: 1 });
    await coordinator.onTurnSettled(turn("session_a", "run_one", "D:\\workspace-one"));
    await coordinator.onTurnStart(turn("session_b", "run_two", "D:\\workspace-two"));
    await coordinator.onTurnSettled(turn("session_b", "run_two", "D:\\workspace-two"));

    expect(coordinator.status()).toMatchObject({
      pendingTurns: 0,
      trackedSessions: 2,
      trackedRepositories: 2,
      cleanupAvailable: true
    });
    await expect(coordinator.cleanupAll()).resolves.toEqual({ removedSessions: 2, repositoriesVisited: 2 });
    expect(port.deleteRepositoryNamespace).toHaveBeenCalledTimes(2);
    expect(coordinator.status()).toEqual({
      pendingTurns: 0,
      trackedSessions: 0,
      trackedRepositories: 0,
      cleanupAvailable: false
    });
  });
});

function turn(sessionId: string, runId: string, workspaceRoot = "D:\\repo") {
  return { sessionId, runId, workspaceRoot };
}

function fingerprint(relativePath: string, version: number): SkippedPathFingerprint {
  return {
    relativePath,
    sizeBytes: version,
    modifiedAtMs: version,
    changedAtMs: version,
    inode: version
  };
}

function result(commit: string, fingerprints: readonly SkippedPathFingerprint[] = []): ShadowSavepointResult {
  return {
    commit,
    tree: `tree-${commit}`,
    includedPaths: [],
    skippedPaths: [],
    skippedFingerprints: fingerprints
  };
}

function fakePort(options: {
  readonly baselineFingerprints?: readonly SkippedPathFingerprint[];
  readonly afterFingerprints?: readonly SkippedPathFingerprint[];
} = {}) {
  const port = {
    create: vi.fn(async (_repositoryRoot, input) => input.kind === "turn_start"
      ? result(`baseline-${input.sessionId}-${input.runId}`, options.baselineFingerprints)
      : result(`after-${input.sessionId}-${input.runId}`, options.afterFingerprints)),
    appendGap: vi.fn(async () => "gap-commit"),
    deleteSessionChain: vi.fn(async () => undefined),
    deleteRepositoryNamespace: vi.fn(async () => 1)
  } satisfies GitSafetySavepointPort;
  return port;
}
