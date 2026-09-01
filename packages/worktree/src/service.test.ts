import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { EphemeralWorktreeService } from "./service.js";
import type { WorktreeErrorCode } from "./errors.js";
import type { WorktreeResult } from "./types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe("EphemeralWorktreeService", () => {
  test("detects a primary checkout, resolves its source, and gives a session an idempotent lease", async () => {
    const fixture = await createRepositoryFixture();
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });

    const initialized = unwrap(await service.initialize());
    expect(initialized).toMatchObject({ removed: 0, preserved: 0 });
    expect(initialized.storageRoot).toBe(resolve(fixture.storageRoot));

    const detection = unwrap(await service.detectCwd(join(fixture.repositoryRoot, "src")));
    expect(detection).toMatchObject({
      repositoryRoot: resolve(fixture.repositoryRoot),
      currentBranch: "main",
      isLinkedWorktree: false
    });
    expect(detection.headCommit).toMatch(/^[a-f0-9]{40,64}$/u);

    const source = unwrap(await service.resolveSource({ cwd: fixture.repositoryRoot }));
    expect(source).toMatchObject({ strategy: "current_branch", ref: "refs/heads/main" });
    expect(unwrap(await service.listSources(fixture.repositoryRoot))).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: "refs/heads/main", name: "main", kind: "local", current: true })
    ]));

    const first = unwrap(await service.acquire({ sessionId: "session-a", cwd: fixture.repositoryRoot }));
    expect(first).toMatchObject({ existing: false });
    expect(relative(fixture.storageRoot, first.lease.path)).not.toMatch(/^\.\./u);
    expect(first.lease.branch).toMatch(/^joko\/ephemeral\/[a-f0-9]{12}-[a-f0-9]{8}$/u);
    expect((await readFile(join(first.lease.path, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("initial\n");

    const again = unwrap(await service.acquire({ sessionId: "session-a", cwd: fixture.repositoryRoot }));
    expect(again.existing).toBe(true);
    expect(again.lease.path).toBe(first.lease.path);
    expect(service.snapshot()).toMatchObject({ initialized: true, residualCount: 0 });
    expect(service.snapshot().active).toHaveLength(1);
  });

  test("retains every valid worktree source after the thousandth local branch", { timeout: 15_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const head = (await git(fixture.repositoryRoot, ["rev-parse", "HEAD"])).trim();
    const branchNames = Array.from(
      { length: 1_001 },
      (_, index) => `branch-${String(index + 1).padStart(4, "0")}`
    );
    await git(
      fixture.repositoryRoot,
      ["update-ref", "--stdin"],
      `${branchNames.map((name) => `create refs/heads/${name} ${head}`).join("\n")}\n`
    );
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());

    const sources = unwrap(await service.listSources(fixture.repositoryRoot));
    const localSources = sources.filter((source) => source.kind === "local");

    expect(localSources).toHaveLength(branchNames.length + 1);
    expect(localSources[0]).toMatchObject({ ref: "refs/heads/main", name: "main", current: true });
    expect(new Set(localSources.map((source) => source.ref)).size).toBe(localSources.length);
    expect(localSources.slice(1).map((source) => source.name)).toEqual(branchNames);
    expect(localSources.at(-1)).toMatchObject({
      ref: "refs/heads/branch-1001",
      name: "branch-1001",
      current: false
    });
  });

  test("serializes concurrent acquisition, removes clean checkouts, and preserves ignored content", { timeout: 15_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());

    const [leftResult, rightResult] = await Promise.all([
      service.acquire({ sessionId: "left", cwd: fixture.repositoryRoot }),
      service.acquire({ sessionId: "right", cwd: fixture.repositoryRoot })
    ]);
    const left = unwrap(leftResult);
    const right = unwrap(rightResult);
    expect(left.lease.path).not.toBe(right.lease.path);
    expect(left.lease.branch).not.toBe(right.lease.branch);

    expect(unwrap(await service.release("left"))).toMatchObject({
      status: "destroyed",
      pathRemoved: true,
      branchPreserved: true
    });
    await writeFile(join(right.lease.path, "runtime.ignored"), "must make the slot dirty\n", "utf8");
    const dirtyRelease = unwrap(await service.release("right"));
    expect(dirtyRelease).toMatchObject({ status: "preserved", reason: "dirty", pathRemoved: false });
    expect(await readFile(join(right.lease.path, "runtime.ignored"), "utf8")).toContain("must make the slot dirty");
    expect(await gitBranchExists(fixture.repositoryRoot, right.lease.branch)).toBe(true);

    const next = unwrap(await service.acquire({ sessionId: "next", cwd: fixture.repositoryRoot }));
    expect(next).toMatchObject({ existing: false });
    expect(next.lease.path).not.toBe(left.lease.path);
    expect(next.lease.branch).not.toBe(left.lease.branch);
    expect(unwrap(await service.release("next"))).toMatchObject({ status: "destroyed", pathRemoved: true });
    expect(unwrap(await service.release("missing"))).toEqual({ status: "not_found" });
  });

  test("destroys clean worktrees while preserving their branches", async () => {
    const fixture = await createRepositoryFixture();
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());
    const acquired = unwrap(await service.acquire({ sessionId: "one-shot", cwd: fixture.repositoryRoot }));

    expect(unwrap(await service.release("one-shot"))).toMatchObject({
      status: "destroyed",
      pathRemoved: true,
      branchPreserved: true
    });
    await expect(lstat(acquired.lease.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await gitBranchExists(fixture.repositoryRoot, acquired.lease.branch)).toBe(true);
  });

  test("removes committed checkouts while preserving their branch and honors explicit keep markers", { timeout: 15_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());

    const committed = unwrap(await service.acquire({ sessionId: "committed", cwd: fixture.repositoryRoot }));
    await writeFile(join(committed.lease.path, "completed.txt"), "retained\n", "utf8");
    await git(committed.lease.path, ["add", "completed.txt"]);
    await git(committed.lease.path, ["commit", "-m", "retain completed task"]);
    expect(unwrap(await service.release("committed"))).toMatchObject({
      status: "destroyed",
      pathRemoved: true,
      branchPreserved: true
    });
    await expect(lstat(committed.lease.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(fixture.repositoryRoot, ["show", `${committed.lease.branch}:completed.txt`])).toBe("retained\n");

    const marked = unwrap(await service.acquire({ sessionId: "marked", cwd: fixture.repositoryRoot }));
    await writeFile(join(marked.lease.path, ".worktree-keep"), "owner requested recovery\n", "utf8");
    expect(unwrap(await service.release("marked"))).toMatchObject({
      status: "preserved",
      reason: "keep",
      pathRemoved: false
    });
    expect(await readFile(join(marked.lease.path, ".worktree-keep"), "utf8")).toContain("owner requested");
  });

  test("restores a live dirty worktree and removes already released checkouts after restart", { timeout: 15_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const firstService = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await firstService.initialize());
    const active = unwrap(await firstService.acquire({ sessionId: "active", cwd: fixture.repositoryRoot }));
    const released = unwrap(await firstService.acquire({ sessionId: "released", cwd: fixture.repositoryRoot }));
    expect(unwrap(await firstService.release("released"))).toMatchObject({ status: "destroyed", pathRemoved: true });
    await writeFile(join(active.lease.path, "unfinished.txt"), "uncommitted\n", "utf8");
    firstService.dispose();

    const restarted = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    const sweep = unwrap(await restarted.initialize({ retainSessionIds: ["active"] }));
    expect(sweep).toMatchObject({ removed: 0, preserved: 1 });
    expect(sweep.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: active.lease.id, status: "preserved", reason: "live_session" })
    ]));
    expect(await readFile(join(active.lease.path, "unfinished.txt"), "utf8")).toBe("uncommitted\n");
    await expect(lstat(released.lease.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await gitBranchExists(fixture.repositoryRoot, active.lease.branch)).toBe(true);
    expect(await gitBranchExists(fixture.repositoryRoot, released.lease.branch)).toBe(true);
    expect(restarted.snapshot()).toMatchObject({ residualCount: 0 });
    expect(restarted.snapshot().active).toHaveLength(1);

    const state = JSON.parse(await readFile(join(fixture.storageRoot, "state.json"), "utf8")) as {
      readonly entries: readonly unknown[];
    };
    expect(state.entries).toHaveLength(1);
  });

  test("archives tracked, staged, and untracked changes without polluting the shared stash", { timeout: 15_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());
    const acquired = unwrap(await service.acquire({ sessionId: "restorable-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "changed while archived\n", "utf8");
    await writeFile(join(acquired.lease.path, "new-file.txt"), "untracked content\n", "utf8");
    await git(acquired.lease.path, ["add", "tracked.txt"]);

    expect(unwrap(await service.release("restorable-owner", { retainForRestore: true }))).toMatchObject({
      status: "preserved",
      reason: "restorable",
      pathRemoved: true,
      branchPreserved: true
    });
    await expect(lstat(acquired.lease.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await gitBranchExists(fixture.repositoryRoot, acquired.lease.branch)).toBe(true);
    const cleanupStash = await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"]);
    expect(cleanupStash).toBe("");

    const restored = unwrap(await service.acquire({ sessionId: "restorable-owner", cwd: fixture.repositoryRoot }));
    expect(restored).toMatchObject({ existing: true });
    expect(restored.lease.id).toBe(acquired.lease.id);
    expect(restored.lease.path).toBe(acquired.lease.path);
    expect((await readFile(join(restored.lease.path, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("changed while archived\n");
    expect((await readFile(join(restored.lease.path, "new-file.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("untracked content\n");
    expect(await git(restored.lease.path, ["diff", "--cached", "--name-only"])).toBe("tracked.txt\n");
    expect(await git(fixture.repositoryRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/joko/worktree-snapshots"
    ])).toBe("");
    expect(await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"])).toBe(cleanupStash);
  });

  test("fails closed when a dirty archive loses its required owner ref", { timeout: 20_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());
    const acquired = unwrap(await service.acquire({ sessionId: "missing-required-ref", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "required staged state\n", "utf8");
    await writeFile(join(acquired.lease.path, "required-new.txt"), "required untracked state\n", "utf8");
    await git(acquired.lease.path, ["add", "tracked.txt"]);
    unwrap(await service.release("missing-required-ref", { retainForRestore: true }));
    const snapshotSha = await snapshotRefSha(fixture.repositoryRoot, "missing-required-ref");
    expect(snapshotSha).toMatch(/^[a-f0-9]{40,64}$/u);
    await git(fixture.repositoryRoot, [
      "update-ref", "-d", `refs/joko/worktree-snapshots/${ownerKey("missing-required-ref")}`, snapshotSha
    ]);

    expectFailure(
      await service.acquire({ sessionId: "missing-required-ref", cwd: fixture.repositoryRoot }),
      "STATE_CORRUPT"
    );
    await expect(lstat(acquired.lease.path)).rejects.toMatchObject({ code: "ENOENT" });
    const state = await persistedEntries(fixture.storageRoot);
    expect(state[0]?.["archiveSnapshot"]).toMatchObject({ kind: "dirty", sha: snapshotSha });
  });

  test("records a clean archive explicitly and restores it without an owner ref", { timeout: 15_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());
    const acquired = unwrap(await service.acquire({ sessionId: "clean-owner", cwd: fixture.repositoryRoot }));

    expect(unwrap(await service.release("clean-owner", { retainForRestore: true }))).toMatchObject({
      status: "preserved",
      reason: "restorable",
      pathRemoved: true
    });
    expect((await persistedEntries(fixture.storageRoot))[0]?.["archiveSnapshot"]).toMatchObject({ kind: "clean" });
    expect(await snapshotRefSha(fixture.repositoryRoot, "clean-owner")).toBe("");

    const restored = unwrap(await service.acquire({ sessionId: "clean-owner", cwd: fixture.repositoryRoot }));
    expect((await readFile(join(restored.lease.path, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("initial\n");
    expect((await persistedEntries(fixture.storageRoot))[0]?.["archiveSnapshot"]).toBeUndefined();
  });

  test("recovers exact tracked, index, and untracked state from the post-reset crash boundary", { timeout: 30_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await first.initialize());
    const acquired = unwrap(await first.acquire({ sessionId: "cleanup-exit-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "unstaged at exit\n", "utf8");
    await writeFile(join(acquired.lease.path, "src", "index.ts"), "export const value = 2;\n", "utf8");
    await writeFile(join(acquired.lease.path, "exit-new.txt"), "untracked at exit\n", "utf8");
    await git(acquired.lease.path, ["add", "src/index.ts"]);
    await writeFile(join(fixture.repositoryRoot, "tracked.txt"), "forged stash content\n", "utf8");
    await git(fixture.repositoryRoot, ["stash", "push", "-m", `joko-worktree-clean:${ownerKey("cleanup-exit-owner")}:forged`]);
    unwrap(await first.release("cleanup-exit-owner", { retainForRestore: true }));
    const archived = (await persistedEntries(fixture.storageRoot))[0]?.["archiveSnapshot"] as Readonly<Record<string, unknown>>;
    expect(archived).toMatchObject({ kind: "dirty" });
    const snapshotSha = String(archived["sha"]);
    expect(await snapshotRefSha(fixture.repositoryRoot, "cleanup-exit-owner")).toBe(snapshotSha);
    await git(fixture.repositoryRoot, ["worktree", "add", acquired.lease.path, acquired.lease.branch]);
    await git(acquired.lease.path, ["stash", "apply", "--index", snapshotSha]);
    await rewriteOnlyEntry(fixture.storageRoot, (entry) => ({
      ...entry,
      checkoutCleanup: { sha: snapshotSha },
      updatedAt: Date.now()
    }));
    await git(acquired.lease.path, ["reset", "--hard", "HEAD"]);
    expect(await readFile(join(acquired.lease.path, "exit-new.txt"), "utf8")).toContain("untracked at exit");
    expect(await git(acquired.lease.path, ["diff", "--cached", "--name-only"])).toBe("");
    const stashAfterExit = await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"]);
    expect(stashAfterExit).toContain(`joko-worktree-clean:${ownerKey("cleanup-exit-owner")}:forged`);
    first.dispose();

    const restarted = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await restarted.initialize({ retainSessionIds: ["cleanup-exit-owner"] }));
    expect((await readFile(join(acquired.lease.path, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("unstaged at exit\n");
    expect((await readFile(join(acquired.lease.path, "src", "index.ts"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("export const value = 2;\n");
    expect((await readFile(join(acquired.lease.path, "exit-new.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("untracked at exit\n");
    expect(await git(acquired.lease.path, ["diff", "--name-only"])).toBe("tracked.txt\n");
    expect(await git(acquired.lease.path, ["diff", "--cached", "--name-only"])).toBe("src/index.ts\n");
    expect(await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"])).toBe(stashAfterExit);
  });

  test("finishes an exact deletion transfer from the post-owner-ref-retirement crash boundary", { timeout: 30_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await first.initialize());
    const acquired = unwrap(await first.acquire({ sessionId: "delete-exit-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "deleted unstaged\n", "utf8");
    await writeFile(join(acquired.lease.path, "src", "index.ts"), "export const value = 3;\n", "utf8");
    await writeFile(join(acquired.lease.path, "deleted-new.txt"), "deleted untracked\n", "utf8");
    await git(acquired.lease.path, ["add", "src/index.ts"]);
    await writeFile(join(fixture.repositoryRoot, "tracked.txt"), "forged deletion stash\n", "utf8");
    await git(fixture.repositoryRoot, ["stash", "push", "-m", `joko-worktree-deleted:${ownerKey("delete-exit-owner")}`]);
    unwrap(await first.release("delete-exit-owner", { retainForRestore: true }));
    await expect(lstat(acquired.lease.path)).rejects.toMatchObject({ code: "ENOENT" });
    const snapshotSha = await snapshotRefSha(fixture.repositoryRoot, "delete-exit-owner");
    await git(fixture.repositoryRoot, [
      "stash", "store", "-m", `joko-worktree-deleted:${ownerKey("delete-exit-owner")}`, snapshotSha
    ]);
    await rewriteOnlyEntry(fixture.storageRoot, (entry) => ({
      ...entry,
      deletionTransfer: { stashSha: snapshotSha },
      updatedAt: Date.now()
    }));
    await git(fixture.repositoryRoot, [
      "update-ref", "-d", `refs/joko/worktree-snapshots/${ownerKey("delete-exit-owner")}`, snapshotSha
    ]);
    first.dispose();

    const stateAfterExit = await persistedEntries(fixture.storageRoot);
    const transfer = stateAfterExit[0]?.["deletionTransfer"] as Readonly<Record<string, unknown>>;
    const transferredSha = String(transfer["stashSha"]);
    expect(transferredSha).toMatch(/^[a-f0-9]{40,64}$/u);
    expect(await snapshotRefSha(fixture.repositoryRoot, "delete-exit-owner")).toBe("");
    const stashAfterExit = await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"]);
    expect(stashAfterExit).toContain(`joko-worktree-deleted:${ownerKey("delete-exit-owner")}`);
    expect(stashAfterExit.split(/\r?\n/u).some((line) => line.startsWith(`${transferredSha}\t`))).toBe(true);

    const restarted = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    const sweep = unwrap(await restarted.initialize());
    expect(sweep).toMatchObject({ removed: 1, preserved: 0 });
    expect(await persistedEntries(fixture.storageRoot)).toHaveLength(0);
    expect(await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"])).toBe(stashAfterExit);

    const recoveryPath = join(fixture.root, "deleted-recovery");
    await git(fixture.repositoryRoot, ["worktree", "add", recoveryPath, acquired.lease.branch]);
    await git(recoveryPath, ["stash", "apply", "--index", transferredSha]);
    expect((await readFile(join(recoveryPath, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("deleted unstaged\n");
    expect((await readFile(join(recoveryPath, "src", "index.ts"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("export const value = 3;\n");
    expect((await readFile(join(recoveryPath, "deleted-new.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("deleted untracked\n");
    expect(await git(recoveryPath, ["diff", "--name-only"])).toBe("tracked.txt\n");
    expect(await git(recoveryPath, ["diff", "--cached", "--name-only"])).toBe("src/index.ts\n");
    expect(await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"])).toBe(stashAfterExit);
  });

  test.each(["clean", "dirty"] as const)(
    "fails closed when an archived %s branch moves to a different commit with the same tree",
    { timeout: 20_000 },
    async (mode) => {
      const fixture = await createRepositoryFixture();
      const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
      unwrap(await first.initialize());
      const sessionId = `same-tree-move-${mode}`;
      const acquired = unwrap(await first.acquire({ sessionId, cwd: fixture.repositoryRoot }));
      if (mode === "dirty") {
        await writeFile(join(acquired.lease.path, "tracked.txt"), "dirty archive state\n", "utf8");
      }
      unwrap(await first.release(sessionId, { retainForRestore: true }));
      const archivedTip = (await git(fixture.repositoryRoot, ["rev-parse", acquired.lease.branch])).trim();
      const archivedTree = (await git(fixture.repositoryRoot, ["rev-parse", `${archivedTip}^{tree}`])).trim();
      const movedTip = (await git(fixture.repositoryRoot, [
        "commit-tree", archivedTree, "-p", archivedTip, "-m", "same tree different commit"
      ])).trim();
      expect(movedTip).not.toBe(archivedTip);
      expect((await git(fixture.repositoryRoot, ["rev-parse", `${movedTip}^{tree}`])).trim()).toBe(archivedTree);
      await git(fixture.repositoryRoot, [
        "update-ref", `refs/heads/${acquired.lease.branch}`, movedTip, archivedTip
      ]);
      first.dispose();

      const restarted = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
      const sweep = unwrap(await restarted.initialize({ retainSessionIds: [sessionId] }));
      expect(sweep.records).toContainEqual(expect.objectContaining({
        id: acquired.lease.id,
        status: "preserved",
        reason: "SESSION_CONFLICT"
      }));
      expect(restarted.snapshot()).toMatchObject({ active: [], residualCount: 1 });
      await expect(lstat(acquired.lease.path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  test("never treats a forged user stash subject as archive authority or consumes it", { timeout: 20_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());
    const acquired = unwrap(await service.acquire({ sessionId: "forged-stash-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(fixture.repositoryRoot, "tracked.txt"), "user stash content\n", "utf8");
    await git(fixture.repositoryRoot, [
      "stash", "push", "-m", `joko-worktree-deleted:${ownerKey("forged-stash-owner")}`
    ]);
    const userStash = await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"]);

    unwrap(await service.release("forged-stash-owner", { retainForRestore: true }));
    const restored = unwrap(await service.acquire({ sessionId: "forged-stash-owner", cwd: fixture.repositoryRoot }));
    expect((await readFile(join(restored.lease.path, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("initial\n");
    expect(await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"])).toBe(userStash);
  });

  test.each(["--skip-worktree", "--assume-unchanged"])(
    "preserves hidden tracked changes fenced by %s",
    { timeout: 20_000 },
    async (flag) => {
      const fixture = await createRepositoryFixture();
      const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
      unwrap(await first.initialize());
      const acquired = unwrap(await first.acquire({ sessionId: `hidden-${flag}`, cwd: fixture.repositoryRoot }));
      await git(acquired.lease.path, ["update-index", flag, "tracked.txt"]);
      await writeFile(join(acquired.lease.path, "tracked.txt"), "hidden tracked content\n", "utf8");
      expect(await git(acquired.lease.path, ["status", "--porcelain=v1"])).toBe("");

      expect(unwrap(await first.release(`hidden-${flag}`, { retainForRestore: true }))).toMatchObject({
        status: "preserved",
        reason: "dirty",
        pathRemoved: false
      });
      expect(await readFile(join(acquired.lease.path, "tracked.txt"), "utf8")).toBe("hidden tracked content\n");
      first.dispose();

      const restarted = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
      expect(unwrap(await restarted.initialize({ retainSessionIds: [`hidden-${flag}`] })))
        .toMatchObject({ removed: 0, preserved: 1 });
      expect(await readFile(join(acquired.lease.path, "tracked.txt"), "utf8")).toBe("hidden tracked content\n");
      expect(restarted.snapshot().active).toHaveLength(1);
    }
  );

  test("keeps an archived owner record across restart and rebuilds the exact branch on activation", { timeout: 15_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await first.initialize());
    const acquired = unwrap(await first.acquire({ sessionId: "archived-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "restart recovery\n", "utf8");
    unwrap(await first.release("archived-owner", { retainForRestore: true }));
    first.dispose();

    const archived = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    const archivedSweep = unwrap(await archived.initialize({ preserveSessionIds: ["archived-owner"] }));
    expect(archivedSweep).toMatchObject({ removed: 0, preserved: 1 });
    expect(archived.snapshot()).toMatchObject({ active: [], residualCount: 1 });
    archived.dispose();

    const live = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    const liveSweep = unwrap(await live.initialize({ retainSessionIds: ["archived-owner"] }));
    expect(liveSweep).toMatchObject({ removed: 0, preserved: 1 });
    expect(live.snapshot().active).toHaveLength(1);
    expect(live.snapshot().active[0]).toMatchObject({
      id: acquired.lease.id,
      sessionId: "archived-owner",
      path: acquired.lease.path,
      branch: acquired.lease.branch
    });
    expect((await readFile(join(acquired.lease.path, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("restart recovery\n");
  });

  test("moves a deleted dirty checkout to the user stash and removes its owner ref", { timeout: 15_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());
    const acquired = unwrap(await service.acquire({ sessionId: "deleted-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "deleted tracked content\n", "utf8");
    await writeFile(join(acquired.lease.path, "deleted-new.txt"), "deleted untracked content\n", "utf8");

    expect(unwrap(await service.release("deleted-owner"))).toMatchObject({
      status: "destroyed",
      pathRemoved: true,
      branchPreserved: true
    });
    await expect(lstat(acquired.lease.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await snapshotRefSha(fixture.repositoryRoot, "deleted-owner")).toBe("");
    const stash = await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"]);
    expect(stash).toContain(`joko-worktree-deleted:${ownerKey("deleted-owner")}`);
    const stashSha = stash.split("\t", 1)[0]?.trim();
    expect(stashSha).toMatch(/^[a-f0-9]{40,64}$/u);
    expect(await git(fixture.repositoryRoot, ["stash", "show", "--include-untracked", "--name-only", stashSha!]))
      .toContain("deleted-new.txt");
    expect((await persistedEntries(fixture.storageRoot))).toHaveLength(0);
  });

  test("transfers an archived snapshot to stash when the owner is later deleted", { timeout: 15_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());
    const acquired = unwrap(await service.acquire({ sessionId: "archived-then-deleted", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "archive then delete\n", "utf8");

    unwrap(await service.release("archived-then-deleted", { retainForRestore: true }));
    expect(await snapshotRefSha(fixture.repositoryRoot, "archived-then-deleted")).toMatch(/^[a-f0-9]{40,64}$/u);
    expect(await git(fixture.repositoryRoot, ["stash", "list", "--format=%gs"])).toBe("");

    expect(unwrap(await service.release("archived-then-deleted"))).toMatchObject({
      status: "destroyed",
      pathRemoved: true
    });
    expect(await snapshotRefSha(fixture.repositoryRoot, "archived-then-deleted")).toBe("");
    expect(await git(fixture.repositoryRoot, ["stash", "list", "--format=%gs"]))
      .toContain(`joko-worktree-deleted:${ownerKey("archived-then-deleted")}`);
    expect((await persistedEntries(fixture.storageRoot))).toHaveLength(0);
  });

  test("leaves the checkout byte-for-byte recoverable when owner-ref creation fails", { timeout: 15_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());
    const acquired = unwrap(await service.acquire({ sessionId: "blocked-ref-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "must remain in checkout\n", "utf8");
    await writeFile(join(acquired.lease.path, "new-file.txt"), "must also remain\n", "utf8");
    await git(acquired.lease.path, ["add", "tracked.txt"]);
    const head = (await git(fixture.repositoryRoot, ["rev-parse", "HEAD"])).trim();
    await git(fixture.repositoryRoot, ["update-ref", "refs/joko/worktree-snapshots", head]);

    expectFailure(
      await service.release("blocked-ref-owner", { retainForRestore: true }),
      "GIT_FAILED"
    );
    expect((await readFile(join(acquired.lease.path, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("must remain in checkout\n");
    expect(await readFile(join(acquired.lease.path, "new-file.txt"), "utf8")).toBe("must also remain\n");
    expect(await git(acquired.lease.path, ["diff", "--cached", "--name-only"])).toBe("tracked.txt\n");
    expect(await git(fixture.repositoryRoot, ["stash", "list", "--format=%gs"])).toBe("");
    expect((await git(fixture.repositoryRoot, ["rev-parse", "refs/joko/worktree-snapshots"])).trim()).toBe(head);
  });

  test("finishes a restore that crashed after applying the snapshot and preserves the index", { timeout: 20_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await first.initialize());
    const acquired = unwrap(await first.acquire({ sessionId: "restore-crash-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "applied before crash\n", "utf8");
    await writeFile(join(acquired.lease.path, "restore-new.txt"), "untracked before crash\n", "utf8");
    await git(acquired.lease.path, ["add", "tracked.txt"]);
    unwrap(await first.release("restore-crash-owner", { retainForRestore: true }));
    const snapshotSha = await snapshotRefSha(fixture.repositoryRoot, "restore-crash-owner");
    expect(snapshotSha).toMatch(/^[a-f0-9]{40,64}$/u);
    first.dispose();

    await git(fixture.repositoryRoot, ["worktree", "add", acquired.lease.path, acquired.lease.branch]);
    await git(acquired.lease.path, ["stash", "apply", "--index", snapshotSha]);
    await rewriteOnlyEntry(fixture.storageRoot, (entry) => ({
      ...entry,
      status: "restoring",
      updatedAt: Date.now()
    }));

    const restarted = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    expect(unwrap(await restarted.initialize({ retainSessionIds: ["restore-crash-owner"] })))
      .toMatchObject({ removed: 0, preserved: 1 });
    expect(restarted.snapshot().active).toHaveLength(1);
    expect((await readFile(join(acquired.lease.path, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("applied before crash\n");
    expect((await readFile(join(acquired.lease.path, "restore-new.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("untracked before crash\n");
    expect(await git(acquired.lease.path, ["diff", "--cached", "--name-only"])).toBe("tracked.txt\n");
    expect(await snapshotRefSha(fixture.repositoryRoot, "restore-crash-owner")).toBe("");
    expect(await git(fixture.repositoryRoot, ["stash", "list", "--format=%gs"])).toBe("");
  });

  test("finishes an exact restored checkout after owner-ref deletion precedes the active state commit", { timeout: 20_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await first.initialize());
    const acquired = unwrap(await first.acquire({ sessionId: "restored-ref-gap", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "restored exact staged\n", "utf8");
    await writeFile(join(acquired.lease.path, "restored-gap-new.txt"), "restored exact untracked\n", "utf8");
    await git(acquired.lease.path, ["add", "tracked.txt"]);
    unwrap(await first.release("restored-ref-gap", { retainForRestore: true }));
    const snapshotSha = await snapshotRefSha(fixture.repositoryRoot, "restored-ref-gap");
    first.dispose();

    await git(fixture.repositoryRoot, ["worktree", "add", acquired.lease.path, acquired.lease.branch]);
    await git(acquired.lease.path, ["stash", "apply", "--index", snapshotSha]);
    await rewriteOnlyEntry(fixture.storageRoot, (entry) => ({
      ...entry,
      status: "restored",
      updatedAt: Date.now()
    }));
    await git(fixture.repositoryRoot, [
      "update-ref", "-d", `refs/joko/worktree-snapshots/${ownerKey("restored-ref-gap")}`, snapshotSha
    ]);

    const restarted = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    expect(unwrap(await restarted.initialize({ retainSessionIds: ["restored-ref-gap"] })))
      .toMatchObject({ removed: 0, preserved: 1 });
    expect(restarted.snapshot().active).toHaveLength(1);
    expect((await readFile(join(acquired.lease.path, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("restored exact staged\n");
    expect((await readFile(join(acquired.lease.path, "restored-gap-new.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("restored exact untracked\n");
    expect(await git(acquired.lease.path, ["diff", "--cached", "--name-only"])).toBe("tracked.txt\n");
    expect(await snapshotRefSha(fixture.repositoryRoot, "restored-ref-gap")).toBe("");
  });

  test("keeps the snapshot and checkout when a restored phase gains later edits", { timeout: 20_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await first.initialize());
    const acquired = unwrap(await first.acquire({ sessionId: "restored-race-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "applied snapshot\n", "utf8");
    unwrap(await first.release("restored-race-owner", { retainForRestore: true }));
    const snapshotSha = await snapshotRefSha(fixture.repositoryRoot, "restored-race-owner");
    first.dispose();

    await git(fixture.repositoryRoot, ["worktree", "add", acquired.lease.path, acquired.lease.branch]);
    await git(acquired.lease.path, ["stash", "apply", "--index", snapshotSha]);
    await rewriteOnlyEntry(fixture.storageRoot, (entry) => ({
      ...entry,
      status: "restored",
      updatedAt: Date.now()
    }));
    await writeFile(join(acquired.lease.path, "later.txt"), "must remain recoverable\n", "utf8");

    const restarted = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    const sweep = unwrap(await restarted.initialize({ retainSessionIds: ["restored-race-owner"] }));
    expect(sweep.records).toContainEqual(expect.objectContaining({
      id: acquired.lease.id,
      status: "preserved",
      reason: "SESSION_CONFLICT"
    }));
    expect(await snapshotRefSha(fixture.repositoryRoot, "restored-race-owner")).toBe(snapshotSha);
    expect((await readFile(join(acquired.lease.path, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("applied snapshot\n");
    expect(await readFile(join(acquired.lease.path, "later.txt"), "utf8"))
      .toBe("must remain recoverable\n");
  });

  test("keeps the owner ref and checkout absent when restore detects a moved branch", { timeout: 20_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await first.initialize());
    const acquired = unwrap(await first.acquire({ sessionId: "moved-branch-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "archived edit\n", "utf8");
    unwrap(await first.release("moved-branch-owner", { retainForRestore: true }));
    const snapshotSha = await snapshotRefSha(fixture.repositoryRoot, "moved-branch-owner");
    const archivedHead = (await git(fixture.repositoryRoot, ["rev-parse", acquired.lease.branch])).trim();
    first.dispose();

    await writeFile(join(fixture.repositoryRoot, "base-shift.txt"), "new branch base\n", "utf8");
    await git(fixture.repositoryRoot, ["add", "base-shift.txt"]);
    await git(fixture.repositoryRoot, ["commit", "-m", "move archived branch base"]);
    const movedHead = (await git(fixture.repositoryRoot, ["rev-parse", "HEAD"])).trim();
    await git(fixture.repositoryRoot, [
      "update-ref", `refs/heads/${acquired.lease.branch}`, movedHead, archivedHead
    ]);

    const restarted = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    const sweep = unwrap(await restarted.initialize({ retainSessionIds: ["moved-branch-owner"] }));
    expect(sweep.records).toContainEqual(expect.objectContaining({
      id: acquired.lease.id,
      status: "preserved",
      reason: "SESSION_CONFLICT"
    }));
    expect(await snapshotRefSha(fixture.repositoryRoot, "moved-branch-owner")).toBe(snapshotSha);
    await expect(lstat(acquired.lease.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(restarted.snapshot()).toMatchObject({ active: [], residualCount: 1 });
  });

  test("ignores an unrecorded late-edit stash subject without changing it", { timeout: 25_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await first.initialize());
    const acquired = unwrap(await first.acquire({ sessionId: "late-edit-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "original archived edit\n", "utf8");
    unwrap(await first.release("late-edit-owner", { retainForRestore: true }));
    const originalSha = await snapshotRefSha(fixture.repositoryRoot, "late-edit-owner");
    first.dispose();

    await git(fixture.repositoryRoot, ["worktree", "add", acquired.lease.path, acquired.lease.branch]);
    await git(acquired.lease.path, ["stash", "apply", "--index", originalSha]);
    await writeFile(join(acquired.lease.path, "late-edit.txt"), "arrived after the owner snapshot\n", "utf8");
    await git(acquired.lease.path, [
      "stash",
      "push",
      "--include-untracked",
      "-m",
      `joko-worktree-clean:${ownerKey("late-edit-owner")}:simulated-crash`
    ]);

    const archived = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    const stashBefore = await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"]);
    const sweep = unwrap(await archived.initialize({ preserveSessionIds: ["late-edit-owner"] }));
    expect(sweep.records).toContainEqual(expect.objectContaining({
      id: acquired.lease.id,
      status: "preserved",
      reason: "restorable"
    }));
    expect(await snapshotRefSha(fixture.repositoryRoot, "late-edit-owner")).toBe(originalSha);
    expect(await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"])).toBe(stashBefore);
    await expect(lstat(acquired.lease.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails closed when the owner ref SHA moves without a matching state CAS", { timeout: 25_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await first.initialize());
    const acquired = unwrap(await first.acquire({ sessionId: "promoted-crash-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "original archived edit\n", "utf8");
    unwrap(await first.release("promoted-crash-owner", { retainForRestore: true }));
    const originalSha = await snapshotRefSha(fixture.repositoryRoot, "promoted-crash-owner");
    first.dispose();

    await git(fixture.repositoryRoot, ["worktree", "add", acquired.lease.path, acquired.lease.branch]);
    await git(acquired.lease.path, ["stash", "apply", "--index", originalSha]);
    await git(acquired.lease.path, [
      "stash", "push", "--include-untracked", "-m",
      `joko-worktree-clean:${ownerKey("promoted-crash-owner")}:older`
    ]);
    await git(acquired.lease.path, ["stash", "apply", "--index", originalSha]);
    await writeFile(join(acquired.lease.path, "late-edit.txt"), "durable after promotion\n", "utf8");
    await git(acquired.lease.path, [
      "stash", "push", "--include-untracked", "-m",
      `joko-worktree-clean:${ownerKey("promoted-crash-owner")}:selected`
    ]);
    const promotedSha = (await git(fixture.repositoryRoot, ["rev-parse", "stash@{0}"])).trim();
    await git(fixture.repositoryRoot, [
      "update-ref",
      `refs/joko/worktree-snapshots/${ownerKey("promoted-crash-owner")}`,
      promotedSha,
      originalSha
    ]);

    const stashBefore = await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"]);
    const archived = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    const sweep = unwrap(await archived.initialize({ preserveSessionIds: ["promoted-crash-owner"] }));
    expect(sweep.records).toContainEqual(expect.objectContaining({
      id: acquired.lease.id,
      status: "preserved",
      reason: "SESSION_CONFLICT"
    }));
    expect(await snapshotRefSha(fixture.repositoryRoot, "promoted-crash-owner")).toBe(promotedSha);
    expect(await git(fixture.repositoryRoot, ["stash", "list", "--format=%H%x09%gs"])).toBe(stashBefore);
    const state = await persistedEntries(fixture.storageRoot) as Array<{ archiveSnapshot?: { kind: string; sha?: string } }>;
    expect(state[0]?.archiveSnapshot).toMatchObject({ kind: "dirty", sha: originalSha });
    expect((await lstat(acquired.lease.path)).isDirectory()).toBe(true);
  });

  test("never reverts a selected snapshot after its stash selector disappears", { timeout: 20_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await first.initialize());
    const acquired = unwrap(await first.acquire({ sessionId: "missing-selector-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "original archived edit\n", "utf8");
    unwrap(await first.release("missing-selector-owner", { retainForRestore: true }));
    const originalSha = await snapshotRefSha(fixture.repositoryRoot, "missing-selector-owner");
    first.dispose();

    await git(fixture.repositoryRoot, ["worktree", "add", acquired.lease.path, acquired.lease.branch]);
    await git(acquired.lease.path, ["stash", "apply", "--index", originalSha]);
    await git(acquired.lease.path, [
      "stash", "push", "--include-untracked", "-m",
      `joko-worktree-clean:${ownerKey("missing-selector-owner")}:older`
    ]);
    await git(acquired.lease.path, ["stash", "apply", "--index", originalSha]);
    await writeFile(join(acquired.lease.path, "later.txt"), "selected late edit\n", "utf8");
    await git(acquired.lease.path, [
      "stash", "push", "--include-untracked", "-m",
      `joko-worktree-clean:${ownerKey("missing-selector-owner")}:selected`
    ]);
    const selectedSha = (await git(fixture.repositoryRoot, ["rev-parse", "stash@{0}"])).trim();
    await git(fixture.repositoryRoot, [
      "update-ref",
      `refs/joko/worktree-snapshots/${ownerKey("missing-selector-owner")}`,
      selectedSha,
      originalSha
    ]);
    await git(fixture.repositoryRoot, ["stash", "drop", "stash@{0}"]);

    const restarted = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    const sweep = unwrap(await restarted.initialize({ preserveSessionIds: ["missing-selector-owner"] }));
    expect(sweep.records).toContainEqual(expect.objectContaining({
      id: acquired.lease.id,
      status: "preserved",
      reason: "SESSION_CONFLICT"
    }));
    expect(await snapshotRefSha(fixture.repositoryRoot, "missing-selector-owner")).toBe(selectedSha);
    expect((await git(fixture.repositoryRoot, ["stash", "list", "--format=%gs"]))
      .split(/\r?\n/u)
      .filter((line) => line.includes(`joko-worktree-clean:${ownerKey("missing-selector-owner")}:`)).length)
      .toBe(1);
    expect((await lstat(acquired.lease.path)).isDirectory()).toBe(true);
  });

  test("fails closed when temporary snapshots lose their owner ref", { timeout: 20_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await first.initialize());
    const acquired = unwrap(await first.acquire({ sessionId: "orphan-temp-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "orphan-safe content\n", "utf8");
    unwrap(await first.release("orphan-temp-owner", { retainForRestore: true }));
    const snapshotSha = await snapshotRefSha(fixture.repositoryRoot, "orphan-temp-owner");
    first.dispose();

    await git(fixture.repositoryRoot, ["worktree", "add", acquired.lease.path, acquired.lease.branch]);
    await git(acquired.lease.path, ["stash", "apply", "--index", snapshotSha]);
    await git(acquired.lease.path, [
      "stash", "push", "--include-untracked", "-m",
      `joko-worktree-clean:${ownerKey("orphan-temp-owner")}:orphaned`
    ]);
    await git(fixture.repositoryRoot, [
      "update-ref", "-d", `refs/joko/worktree-snapshots/${ownerKey("orphan-temp-owner")}`, snapshotSha
    ]);

    const restarted = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    const sweep = unwrap(await restarted.initialize({ preserveSessionIds: ["orphan-temp-owner"] }));
    expect(sweep.records).toContainEqual(expect.objectContaining({
      id: acquired.lease.id,
      status: "preserved",
      reason: "STATE_CORRUPT"
    }));
    expect(restarted.snapshot()).toMatchObject({ active: [], residualCount: 1 });
    expect((await git(fixture.repositoryRoot, ["stash", "list", "--format=%gs"]))
      .split(/\r?\n/u)
      .filter((line) => line.includes(`joko-worktree-clean:${ownerKey("orphan-temp-owner")}:`)).length)
      .toBeGreaterThanOrEqual(1);
    expect((await lstat(acquired.lease.path)).isDirectory()).toBe(true);
  });

  test("ignores multiple subject-only temporary snapshots and leaves them untouched", { timeout: 20_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await first.initialize());
    const acquired = unwrap(await first.acquire({ sessionId: "ambiguous-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "owner snapshot\n", "utf8");
    unwrap(await first.release("ambiguous-owner", { retainForRestore: true }));
    const ownerSha = await snapshotRefSha(fixture.repositoryRoot, "ambiguous-owner");
    first.dispose();

    await git(fixture.repositoryRoot, ["worktree", "add", acquired.lease.path, acquired.lease.branch]);
    await git(acquired.lease.path, ["stash", "apply", "--index", ownerSha]);
    await writeFile(join(acquired.lease.path, "late-one.txt"), "first late edit\n", "utf8");
    await git(acquired.lease.path, [
      "stash", "push", "--include-untracked", "-m",
      `joko-worktree-clean:${ownerKey("ambiguous-owner")}:first`
    ]);
    await writeFile(join(acquired.lease.path, "late-two.txt"), "second late edit\n", "utf8");
    await git(acquired.lease.path, [
      "stash", "push", "--include-untracked", "-m",
      `joko-worktree-clean:${ownerKey("ambiguous-owner")}:second`
    ]);

    const restarted = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    const sweep = unwrap(await restarted.initialize({ preserveSessionIds: ["ambiguous-owner"] }));
    expect(sweep.records).toContainEqual(expect.objectContaining({
      id: acquired.lease.id,
      status: "preserved",
      reason: "restorable"
    }));
    expect(await snapshotRefSha(fixture.repositoryRoot, "ambiguous-owner")).toBe(ownerSha);
    expect((await git(fixture.repositoryRoot, ["stash", "list", "--format=%gs"]))
      .split(/\r?\n/u)
      .filter((line) => line.includes(`joko-worktree-clean:${ownerKey("ambiguous-owner")}:`)).length)
      .toBe(2);
    await expect(lstat(acquired.lease.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses removal when the checkout no longer equals its owner snapshot", { timeout: 15_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());
    const acquired = unwrap(await service.acquire({ sessionId: "raced-owner", cwd: fixture.repositoryRoot }));
    await writeFile(join(acquired.lease.path, "tracked.txt"), "captured edit\n", "utf8");
    unwrap(await service.release("raced-owner", { retainForRestore: true }));
    const snapshotSha = await snapshotRefSha(fixture.repositoryRoot, "raced-owner");

    await git(fixture.repositoryRoot, ["worktree", "add", acquired.lease.path, acquired.lease.branch]);
    await git(acquired.lease.path, ["stash", "apply", "--index", snapshotSha]);
    await writeFile(join(acquired.lease.path, "late-race.txt"), "must not be removed\n", "utf8");

    expect(unwrap(await service.release("raced-owner", { retainForRestore: true }))).toMatchObject({
      status: "preserved",
      reason: "dirty",
      pathRemoved: false
    });
    expect(await readFile(join(acquired.lease.path, "late-race.txt"), "utf8")).toBe("must not be removed\n");
    expect(await snapshotRefSha(fixture.repositoryRoot, "raced-owner")).toBe(snapshotSha);
  });

  test("uses the refreshed remote default when one is available", async () => {
    const fixture = await createRepositoryFixture();
    const remoteRoot = join(fixture.root, "remote.git");
    await git(fixture.root, ["clone", "--bare", fixture.repositoryRoot, remoteRoot]);
    await git(fixture.repositoryRoot, ["remote", "add", "origin", remoteRoot]);
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());

    const source = unwrap(await service.resolveSource({
      cwd: fixture.repositoryRoot,
      refreshRemote: true
    }));
    expect(source).toMatchObject({
      ref: "refs/remotes/origin/main",
      remote: "origin",
      refreshed: true,
      strategy: "remote_default_refreshed"
    });
  });

  test("rejects linked checkouts, nested storage, invalid sources, and aborted calls", async () => {
    const fixture = await createRepositoryFixture();
    const linkedPath = join(fixture.root, "linked");
    await git(fixture.repositoryRoot, ["worktree", "add", "-b", "auxiliary", linkedPath, "HEAD"]);
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());

    expect(unwrap(await service.detectCwd(linkedPath)).isLinkedWorktree).toBe(true);
    expectFailure(await service.acquire({ sessionId: "linked", cwd: linkedPath }), "CWD_IS_WORKTREE");
    expectFailure(await service.resolveSource({ cwd: fixture.repositoryRoot, sourceRef: "missing-ref" }), "SOURCE_NOT_FOUND");

    const controller = new AbortController();
    controller.abort();
    expectFailure(await service.detectCwd(fixture.repositoryRoot, { signal: controller.signal }), "ABORTED");

    const nested = new EphemeralWorktreeService({ storageRoot: join(fixture.repositoryRoot, ".ephemeral") });
    unwrap(await nested.initialize());
    expectFailure(await nested.acquire({ sessionId: "nested", cwd: fixture.repositoryRoot }), "STORAGE_UNSAFE");
  });

  test("keeps exact session ownership and rejects a cross-repository replay", { timeout: 15_000 }, async () => {
    const fixture = await createRepositoryFixture();
    const secondRepository = await createRepository(join(fixture.root, "second"));
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());
    unwrap(await service.acquire({ sessionId: "owner", cwd: fixture.repositoryRoot }));

    expectFailure(
      await service.acquire({ sessionId: "owner", cwd: secondRepository }),
      "SESSION_CONFLICT"
    );
    expect(service.snapshot().active).toHaveLength(1);
  });

  test("fails closed on durable state corruption without touching unrelated files", async () => {
    const root = await createTemporaryRoot();
    const storageRoot = join(root, "storage");
    const unrelated = join(storageRoot, "unrelated", "keep.txt");
    await mkdir(join(storageRoot, "unrelated"), { recursive: true });
    await writeFile(unrelated, "keep\n", "utf8");
    await writeFile(join(storageRoot, "state.json"), "{not-json\n", "utf8");
    const service = new EphemeralWorktreeService({ storageRoot });

    expectFailure(await service.initialize(), "STATE_CORRUPT");
    expect(await readFile(unrelated, "utf8")).toBe("keep\n");
    expect(service.snapshot().initialized).toBe(false);
  });

  test.each(["preserved", "clean", "dirty"] as const)(
    "rejects archived %s state without an exact branch-tip identity",
    { timeout: 20_000 },
    async (mode) => {
      const fixture = await createRepositoryFixture();
      const first = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
      unwrap(await first.initialize());
      const acquired = unwrap(await first.acquire({ sessionId: `missing-tip-${mode}`, cwd: fixture.repositoryRoot }));
      await writeFile(join(acquired.lease.path, "tracked.txt"), "archive data\n", "utf8");
      unwrap(await first.release(`missing-tip-${mode}`, { retainForRestore: true }));
      first.dispose();

      await rewriteOnlyEntry(fixture.storageRoot, (entry) => {
        const archiveSnapshot = entry["archiveSnapshot"] as Readonly<Record<string, unknown>>;
        if (mode === "preserved") return { ...entry, archiveSnapshot: undefined };
        if (mode === "clean") return { ...entry, archiveSnapshot: { kind: "clean" } };
        return { ...entry, archiveSnapshot: { kind: "dirty", sha: archiveSnapshot["sha"] } };
      });

      const restarted = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
      expectFailure(await restarted.initialize({ retainSessionIds: [`missing-tip-${mode}`] }), "STATE_CORRUPT");
      expect(restarted.snapshot().initialized).toBe(false);
      await expect(lstat(acquired.lease.path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  test("refuses a linked storage root and leaves its target intact", async (context) => {
    const root = await createTemporaryRoot();
    const target = join(root, "actual-storage");
    const alias = join(root, "storage-alias");
    const marker = join(target, "marker.txt");
    await mkdir(target);
    await writeFile(marker, "outside\n", "utf8");
    try {
      await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (isPermissionError(error)) {
        context.skip();
        return;
      }
      throw error;
    }

    const service = new EphemeralWorktreeService({ storageRoot: alias });
    expectFailure(await service.initialize(), "STORAGE_UNSAFE");
    expect(await readFile(marker, "utf8")).toBe("outside\n");
  });

  test("never follows a directory link substituted for a restorable slot", async (context) => {
    const fixture = await createRepositoryFixture();
    const service = new EphemeralWorktreeService({ storageRoot: fixture.storageRoot });
    unwrap(await service.initialize());
    const acquired = unwrap(await service.acquire({ sessionId: "first", cwd: fixture.repositoryRoot }));
    expect(unwrap(await service.release("first", { retainForRestore: true }))).toMatchObject({
      status: "preserved",
      reason: "restorable",
      pathRemoved: true
    });

    const outside = join(fixture.root, "outside");
    const marker = join(outside, "marker.txt");
    await mkdir(outside);
    await writeFile(marker, "protected\n", "utf8");
    try {
      await symlink(outside, acquired.lease.path, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (isPermissionError(error)) {
        context.skip();
        return;
      }
      throw error;
    }

    try {
      expectFailure(
        await service.acquire({ sessionId: "first", cwd: fixture.repositoryRoot }),
        "PATH_UNSAFE"
      );
      expect(await readFile(marker, "utf8")).toBe("protected\n");
      expect((await lstat(acquired.lease.path)).isSymbolicLink()).toBe(true);
    } finally {
      await unlink(acquired.lease.path).catch(() => undefined);
    }
  });
});

interface RepositoryFixture {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly storageRoot: string;
}

async function createRepositoryFixture(): Promise<RepositoryFixture> {
  const root = await createTemporaryRoot();
  const repositoryRoot = await createRepository(join(root, "source"));
  return { root, repositoryRoot, storageRoot: join(root, "storage") };
}

async function createTemporaryRoot(): Promise<string> {
  const requestedRoot = await mkdtemp(join(tmpdir(), "joko-worktree-test-"));
  const root = process.env.GITHUB_ACTIONS === "true" ? await realpath(requestedRoot) : requestedRoot;
  temporaryRoots.push(root);
  return root;
}

async function createRepository(repositoryRoot: string): Promise<string> {
  await mkdir(repositoryRoot, { recursive: true });
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Joko Test"]);
  await git(repositoryRoot, ["config", "user.email", "test@invalid.example"]);
  await mkdir(join(repositoryRoot, "src"));
  await writeFile(join(repositoryRoot, ".gitignore"), "*.ignored\n", "utf8");
  await writeFile(join(repositoryRoot, "tracked.txt"), "initial\n", "utf8");
  await writeFile(join(repositoryRoot, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  return resolve(repositoryRoot);
}

async function git(cwd: string, args: readonly string[], standardInput?: string): Promise<string> {
  const environment: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  for (const key of ["GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) {
    delete environment[key];
  }
  return new Promise<string>((resolveResult, reject) => {
    const child = execFile("git", [...args], {
      cwd,
      encoding: "utf8",
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`Git fixture command failed: ${stderr.trim()}`, { cause: error }));
        return;
      }
      resolveResult(stdout);
    });
    if (standardInput !== undefined) child.stdin?.end(standardInput);
  });
}

async function gitBranchExists(repositoryRoot: string, branch: string): Promise<boolean> {
  try {
    await git(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function ownerKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

async function snapshotRefSha(repositoryRoot: string, sessionId: string): Promise<string> {
  return (await git(repositoryRoot, [
    "for-each-ref",
    "--format=%(objectname)",
    `refs/joko/worktree-snapshots/${ownerKey(sessionId)}`
  ])).trim().toLowerCase();
}

async function persistedEntries(storageRoot: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const parsed = JSON.parse(await readFile(join(storageRoot, "state.json"), "utf8")) as {
    readonly entries?: unknown;
  };
  if (!Array.isArray(parsed.entries)) throw new Error("Worktree fixture state has no entries array.");
  return parsed.entries as readonly Readonly<Record<string, unknown>>[];
}

async function rewriteOnlyEntry(
  storageRoot: string,
  transform: (entry: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>
): Promise<void> {
  const entries = await persistedEntries(storageRoot);
  if (entries.length !== 1 || entries[0] === undefined) {
    throw new Error("Worktree fixture state must contain exactly one entry.");
  }
  await writeFile(
    join(storageRoot, "state.json"),
    `${JSON.stringify({ format: 1, entries: [transform(entries[0])] }, undefined, 2)}\n`,
    "utf8"
  );
}

function unwrap<T>(result: WorktreeResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(result.ok).toBe(true);
  return result.value;
}

function expectFailure(result: WorktreeResult<unknown>, code: WorktreeErrorCode): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`Expected ${code}, but the operation succeeded.`);
  expect(result.error.code).toBe(code);
}

function isPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
}
