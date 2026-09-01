import { execFile } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_GIT_COMMIT_MESSAGE_MAXIMUM_BYTES,
  WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES,
  isUnmergedGitStatus,
  WorkspaceService
} from "./workspace-service.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
}

async function initializedRepository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "review@example.test");
  await git(root, "config", "user.name", "Review Test");
  await git(root, "config", "core.autocrlf", "false");
  return root;
}

describe("WorkspaceService Git Review backend", () => {
  it("recognizes every porcelain unmerged XY form without classifying ordinary changes", () => {
    for (const status of ["U", "UU", "AA", "DD", "AU", "UA", "DU", "UD"]) {
      expect(isUnmergedGitStatus(status)).toBe(true);
    }
    for (const status of [" M", "M ", "A ", " D", "R ", "??"]) expect(isUnmergedGitStatus(status)).toBe(false);
  });

  it("blocks Review writes for a real unmerged repository", async () => {
    const root = await initializedRepository("joko-review-unmerged-");
    await writeFile(join(root, "conflict.txt"), "base\n", "utf8");
    await git(root, "add", "--", "conflict.txt");
    await git(root, "commit", "--quiet", "-m", "base");
    await git(root, "checkout", "--quiet", "-b", "other");
    await writeFile(join(root, "conflict.txt"), "other\n", "utf8");
    await git(root, "commit", "--quiet", "-am", "other");
    await git(root, "checkout", "--quiet", "master");
    await writeFile(join(root, "conflict.txt"), "main\n", "utf8");
    await git(root, "commit", "--quiet", "-am", "main");
    await expect(execFileAsync("git", ["merge", "other"], { cwd: root, windowsHide: true })).rejects.toBeDefined();

    const service = new WorkspaceService();
    await service.register({ id: "unmerged", root, displayName: "Unmerged", trusted: true });
    await expect(service.gitState("unmerged")).resolves.toMatchObject({
      unmerged: true,
      operationInProgress: true,
      changes: [expect.objectContaining({ index: "U", worktree: "U" })]
    });
    await expect(service.commitGitReview("unmerged", {
      message: "must not commit",
      expectedRepositoryRevision: "stale-is-never-reached"
    })).rejects.toMatchObject({ kind: "unsupported" });
  }, 20_000);

  it("resolves an omitted branch base from safe configured defaults and fences a moved base", async () => {
    const root = await initializedRepository("joko-review-default-base-");
    await git(root, "branch", "-m", "main");
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await git(root, "add", "--", "base.txt");
    await git(root, "commit", "--quiet", "-m", "base");
    const base = await git(root, "rev-parse", "HEAD");
    await git(root, "checkout", "--quiet", "-b", "feature");
    await writeFile(join(root, "feature.txt"), "feature\n", "utf8");
    await git(root, "add", "--", "feature.txt");
    await git(root, "commit", "--quiet", "-m", "feature");

    const service = new WorkspaceService();
    await service.register({ id: "default-base", root, displayName: "Default base", trusted: true });
    const initial = await service.gitReviewDiff("default-base", { source: "branch" });
    expect(initial).toMatchObject({ source: "branch", sourceRevision: base, resolvedBaseRef: "main", baseRevision: base, mergeBaseRevision: base });
    expect(initial.comparison).toContain("feature.txt");
    await expect(service.gitReviewDiff("default-base", { source: "branch", sourceRevision: "missing-base" })).resolves.toMatchObject({
      sourceRevision: base,
      requestedBaseRef: "missing-base",
      resolvedBaseRef: "main",
      branchBaseWarning: {
        kind: "requested_base_missing",
        requestedBaseRef: "missing-base",
        resolvedBaseRef: "main"
      }
    });

    await git(root, "checkout", "--quiet", "main");
    await writeFile(join(root, "main.txt"), "main moves\n", "utf8");
    await git(root, "add", "--", "main.txt");
    await git(root, "commit", "--quiet", "-m", "main moves");
    await git(root, "checkout", "--quiet", "feature");
    await expect(service.gitReviewDiff("default-base", {
      source: "branch",
      expectedRepositoryRevision: initial.repositoryRevision,
      expectedMergeBaseRevision: initial.mergeBaseRevision
    })).rejects.toMatchObject({ kind: "stale" });
  }, 20_000);

  it("fails closed when an omitted branch base has no upstream or known default", async () => {
    const root = await initializedRepository("joko-review-no-default-base-");
    await git(root, "branch", "-m", "feature");
    await writeFile(join(root, "feature.txt"), "feature\n", "utf8");
    await git(root, "add", "--", "feature.txt");
    await git(root, "commit", "--quiet", "-m", "feature");
    const service = new WorkspaceService();
    await service.register({ id: "no-default-base", root, displayName: "No default base", trusted: true });
    await expect(service.gitReviewDiff("no-default-base", { source: "branch" })).rejects.toMatchObject({ kind: "unsupported" });
  }, 20_000);

  it("prefers the remote default over the current branch upstream", async () => {
    const root = await initializedRepository("joko-review-upstream-base-");
    await git(root, "branch", "-m", "main");
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await git(root, "add", "--", "base.txt");
    await git(root, "commit", "--quiet", "-m", "base");
    await git(root, "checkout", "--quiet", "-b", "feature");
    await writeFile(join(root, "feature.txt"), "feature\n", "utf8");
    await git(root, "add", "--", "feature.txt");
    await git(root, "commit", "--quiet", "-m", "feature");
    const feature = await git(root, "rev-parse", "HEAD");
    const remote = await mkdtemp(join(tmpdir(), "joko-review-upstream-remote-"));
    await git(remote, "init", "--bare", "--quiet");
    await git(root, "remote", "add", "origin", remote);
    await git(root, "push", "--quiet", "origin", "main");
    await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    await git(root, "push", "--quiet", "-u", "origin", "feature");
    await git(root, "remote", "set-head", "origin", "-a");

    const service = new WorkspaceService();
    await service.register({ id: "upstream-base", root, displayName: "Upstream base", trusted: true });
    await expect(service.gitReviewDiff("upstream-base", { source: "branch" })).resolves.toMatchObject({
      resolvedBaseRef: "origin/main"
    });
    expect((await service.gitReviewDiff("upstream-base", { source: "branch" })).sourceRevision).not.toBe(feature);
  }, 20_000);

  it("does not use the current branch or its sole upstream as an implicit base", async () => {
    const root = await initializedRepository("joko-review-only-upstream-");
    await git(root, "branch", "-m", "feature");
    await writeFile(join(root, "feature.txt"), "feature\n", "utf8");
    await git(root, "add", "--", "feature.txt");
    await git(root, "commit", "--quiet", "-m", "feature");
    const remote = await mkdtemp(join(tmpdir(), "joko-review-only-upstream-remote-"));
    await git(remote, "init", "--bare", "--quiet");
    await git(root, "remote", "add", "origin", remote);
    await git(root, "push", "--quiet", "-u", "origin", "feature");
    await git(root, "tag", "tag-only");

    const service = new WorkspaceService();
    await service.register({ id: "only-upstream", root, displayName: "Only upstream", trusted: true });
    await expect(service.gitReviewDiff("only-upstream", { source: "branch" })).rejects.toMatchObject({ kind: "unsupported" });
    await expect(service.gitReviewDiff("only-upstream", { source: "branch", sourceRevision: "tag-only" })).rejects.toMatchObject({ kind: "unsupported" });
  }, 20_000);

  it("uses deterministic other-local then other-remote branch fallbacks", async () => {
    const root = await initializedRepository("joko-review-other-bases-");
    await git(root, "branch", "-m", "feature");
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await git(root, "add", "--", "base.txt");
    await git(root, "commit", "--quiet", "-m", "base");
    await git(root, "branch", "zeta");
    await git(root, "branch", "alpha");
    const service = new WorkspaceService();
    await service.register({ id: "other-bases", root, displayName: "Other bases", trusted: true });
    await expect(service.gitReviewDiff("other-bases", { source: "branch" })).resolves.toMatchObject({ resolvedBaseRef: "alpha" });

    const remote = await mkdtemp(join(tmpdir(), "joko-review-other-bases-remote-"));
    await git(remote, "init", "--bare", "--quiet");
    await git(root, "remote", "add", "origin", remote);
    await git(root, "push", "--quiet", "origin", "alpha", "zeta");
    await git(root, "branch", "-D", "alpha", "zeta");
    await expect(service.gitReviewDiff("other-bases", { source: "branch" })).resolves.toMatchObject({ resolvedBaseRef: "origin/alpha" });
  }, 20_000);

  it("keeps the four Git sources exact and revision-fences commit and branch reads", async () => {
    const root = await initializedRepository("joko-review-sources-");
    await writeFile(join(root, "review.txt"), "base\n", "utf8");
    await git(root, "add", "--", "review.txt");
    await git(root, "commit", "--quiet", "-m", "base");
    const base = await git(root, "rev-parse", "HEAD");
    await git(root, "branch", "base-branch", base);
    await writeFile(join(root, "review.txt"), "head\n", "utf8");
    await git(root, "add", "--", "review.txt");
    await git(root, "commit", "--quiet", "-m", "head");
    const head = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "review.txt"), "staged\n", "utf8");
    await git(root, "add", "--", "review.txt");
    await writeFile(join(root, "review.txt"), "staged\nunstaged\n", "utf8");

    const service = new WorkspaceService();
    await service.register({ id: "sources", root, displayName: "Sources", trusted: true });
    const staged = await service.gitReviewDiff("sources", { source: "staged" });
    const unstaged = await service.gitReviewDiff("sources", { source: "unstaged" });
    const commit = await service.gitReviewDiff("sources", { source: "commit", sourceRevision: head });
    const branch = await service.gitReviewDiff("sources", { source: "branch", sourceRevision: "base-branch" });
    const filtered = await service.gitReviewDiff("sources", { source: "branch", sourceRevision: "base-branch", paths: ["review.txt"] });

    expect(staged).toMatchObject({ source: "staged", workingTree: "", comparison: "" });
    expect(staged.index).toContain("+staged");
    expect(unstaged).toMatchObject({ source: "unstaged", index: "", comparison: "" });
    expect(unstaged.workingTree).toContain("+unstaged");
    expect(commit).toMatchObject({ source: "commit", sourceRevision: head, baseRevision: base, headRevision: head });
    expect(commit.comparison).toContain("+head");
    expect(branch).toMatchObject({ source: "branch", sourceRevision: base, requestedBaseRef: "base-branch", resolvedBaseRef: "base-branch", baseRevision: base, headRevision: head, mergeBaseRevision: base });
    expect(filtered.repositoryRevision).toBe(branch.repositoryRevision);

    await expect(service.gitReviewDiff("sources", {
      source: "branch",
      sourceRevision: base,
      expectedRepositoryRevision: branch.repositoryRevision,
      expectedMergeBaseRevision: "wrong"
    })).rejects.toMatchObject({ kind: "stale" });
    await expect(service.readGitReviewFile("sources", {
      path: "review.txt",
      source: "branch",
      sourceRevision: base,
      expectedRepositoryRevision: branch.repositoryRevision,
      expectedMergeBaseRevision: base
    })).resolves.toMatchObject({ text: "head\n", mergeBaseRevision: base });
    await expect(service.readGitReviewFile("sources", {
      path: "review.txt",
      source: "branch",
      sourceRevision: base,
      expectedRepositoryRevision: branch.repositoryRevision
    })).rejects.toMatchObject({ kind: "invalid" });
  }, 20_000);

  it("returns only guarded raster bytes and rejects SVG, absolute paths, symlinks, and oversize content", async () => {
    const root = await initializedRepository("joko-review-images-");
    const oldImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const newImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
    await writeFile(join(root, "photo.png"), oldImage);
    await writeFile(join(root, "unsafe.svg"), "<svg><script>bad()</script></svg>", "utf8");
    await git(root, "add", "--", "photo.png", "unsafe.svg");
    await git(root, "commit", "--quiet", "-m", "images");
    await writeFile(join(root, "photo.png"), newImage);

    const service = new WorkspaceService();
    await service.register({ id: "images", root, displayName: "Images", trusted: true });
    const diff = await service.gitReviewDiff("images", { source: "unstaged" });
    const preview = await service.readGitDiffImage("images", {
      path: "photo.png",
      source: "unstaged",
      expectedRepositoryRevision: diff.repositoryRevision
    });
    expect(preview.oldImage).toMatchObject({ present: true, tooLarge: false, mediaType: "image/png" });
    expect(preview.oldImage.bytes).toEqual(oldImage);
    expect(preview.newImage.bytes).toEqual(newImage);

    await expect(service.readGitDiffImage("images", {
      path: "unsafe.svg",
      source: "unstaged",
      expectedRepositoryRevision: diff.repositoryRevision
    })).rejects.toMatchObject({ kind: "unsupported" });
    await expect(service.readGitDiffImage("images", {
      path: join(root, "photo.png"),
      source: "unstaged",
      expectedRepositoryRevision: diff.repositoryRevision
    })).rejects.toMatchObject({ kind: "invalid" });

    await mkdir(join(root, "actual"));
    await writeFile(join(root, "actual", "linked.png"), newImage);
    // Directory junctions exercise the same lexical symlink guard without
    // requiring Windows developer-mode privileges for file symlinks.
    await symlink(join(root, "actual"), join(root, "linked"), "junction");
    const linkFence = await service.gitReviewDiff("images", { source: "unstaged" });
    await expect(service.readGitDiffImage("images", {
      path: "linked/linked.png",
      source: "unstaged",
      expectedRepositoryRevision: linkFence.repositoryRevision
    })).rejects.toMatchObject({ kind: "unsupported" });

    await writeFile(join(root, "large.png"), Buffer.alloc(WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES + 1, 1));
    const largeFence = await service.gitReviewDiff("images", { source: "unstaged" });
    const large = await service.readGitDiffImage("images", {
      path: "large.png",
      source: "unstaged",
      expectedRepositoryRevision: largeFence.repositoryRevision
    });
    expect(large).toMatchObject({ newImage: { present: true, tooLarge: true } });
    expect(large.newImage.bytes).toBeUndefined();
  }, 20_000);

  it("uses one serialized, confirmed, revision-fenced backend for file and hunk actions", async () => {
    const root = await initializedRepository("joko-review-files-");
    const baseline = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`);
    await writeFile(join(root, "review.txt"), `${baseline.join("\n")}\n`, "utf8");
    await git(root, "add", "--", "review.txt");
    await git(root, "commit", "--quiet", "-m", "base");
    const changed = [...baseline];
    changed[1] = "first changed";
    changed[20] = "second changed";
    await writeFile(join(root, "review.txt"), `${changed.join("\n")}\n`, "utf8");

    const service = new WorkspaceService();
    await service.register({ id: "files", root, displayName: "Files", trusted: true });
    const initial = await service.gitReviewDiff("files", { source: "unstaged" });
    const afterStageRevision = await service.applyGitDiff("files", {
      action: "stage",
      source: "unstaged",
      target: "file",
      path: "review.txt",
      expectedRepositoryRevision: initial.repositoryRevision
    });
    expect((await service.gitReviewDiff("files", { source: "staged" })).index).toContain("+second changed");
    const afterUnstageRevision = await service.applyGitDiff("files", {
      action: "unstage",
      source: "staged",
      target: "file",
      path: "review.txt",
      expectedRepositoryRevision: afterStageRevision
    });
    await expect(service.applyGitDiff("files", {
      action: "revert",
      source: "unstaged",
      target: "file",
      path: "review.txt",
      expectedRepositoryRevision: afterUnstageRevision
    })).rejects.toMatchObject({ kind: "invalid" });
    await service.applyGitDiff("files", {
      action: "revert",
      source: "unstaged",
      target: "file",
      path: "review.txt",
      expectedRepositoryRevision: afterUnstageRevision,
      confirmRevert: true
    });
    expect(await readFile(join(root, "review.txt"), "utf8")).toBe(`${baseline.join("\n")}\n`);

    await writeFile(join(root, "new.txt"), "new\n", "utf8");
    const untracked = await service.gitReviewDiff("files", { source: "unstaged" });
    expect(untracked.workingTree).toContain("diff --git a/new.txt b/new.txt");
    await writeFile(join(root, "new.txt"), "new content\n", "utf8");
    const changedUntracked = await service.gitReviewDiff("files", { source: "unstaged" });
    expect(changedUntracked.repositoryRevision).not.toBe(untracked.repositoryRevision);
    const outcomes = await Promise.allSettled([
      service.applyGitDiff("files", {
        action: "stage",
        source: "unstaged",
        target: "file",
        path: "new.txt",
        expectedRepositoryRevision: changedUntracked.repositoryRevision
      }),
      service.applyGitDiff("files", {
        action: "stage",
        source: "unstaged",
        target: "file",
        path: "new.txt",
        expectedRepositoryRevision: changedUntracked.repositoryRevision
      })
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")[0]).toMatchObject({ reason: { kind: "stale" } });
  }, 20_000);

  it("bounds commit messages and performs only explicit non-force pushes", async () => {
    const root = await initializedRepository("joko-review-effects-");
    await writeFile(join(root, "commit.txt"), "base\n", "utf8");
    await git(root, "add", "--", "commit.txt");
    await git(root, "commit", "--quiet", "-m", "base");
    await writeFile(join(root, "commit.txt"), "next\n", "utf8");
    await git(root, "add", "--", "commit.txt");

    const service = new WorkspaceService();
    await service.register({ id: "effects", root, displayName: "Effects", trusted: true });
    const beforeCommit = await service.gitReviewDiff("effects", { source: "staged" });
    await expect(service.commitGitReview("effects", {
      message: "bad\0message",
      expectedRepositoryRevision: beforeCommit.repositoryRevision
    })).rejects.toMatchObject({ kind: "invalid" });
    await expect(service.commitGitReview("effects", {
      message: "x".repeat(WORKSPACE_GIT_COMMIT_MESSAGE_MAXIMUM_BYTES + 1),
      expectedRepositoryRevision: beforeCommit.repositoryRevision
    })).rejects.toMatchObject({ kind: "invalid" });
    const committed = await service.commitGitReview("effects", {
      message: "review commit\n\nbody",
      expectedRepositoryRevision: beforeCommit.repositoryRevision
    });
    expect(await git(root, "log", "-1", "--pretty=%B")).toBe("review commit\n\nbody");

    const bare = await mkdtemp(join(tmpdir(), "joko-review-remote-"));
    await git(bare, "init", "--bare", "--quiet");
    await git(root, "remote", "add", "origin", bare);
    const pushFence = (await service.gitReviewDiff("effects", { source: "staged" })).repositoryRevision;
    await expect(service.pushGitReview("effects", {
      remote: "origin",
      remoteRef: "refs/heads/review",
      expectedRepositoryRevision: pushFence,
      expectedHeadRevision: committed.headRevision
    })).resolves.toMatchObject({ kind: "pushed", remote: "origin", remoteRef: "refs/heads/review" });
    expect(await git(bare, "rev-parse", "refs/heads/review")).toBe(committed.headRevision);

    const other = await mkdtemp(join(tmpdir(), "joko-review-other-"));
    await git(tmpdir(), "clone", "--quiet", "--branch", "review", bare, other);
    await git(other, "config", "user.email", "remote@example.test");
    await git(other, "config", "user.name", "Remote Test");
    await writeFile(join(other, "remote.txt"), "remote\n", "utf8");
    await git(other, "add", "--", "remote.txt");
    await git(other, "commit", "--quiet", "-m", "remote");
    await git(other, "push", "--quiet", "origin", "HEAD:refs/heads/review");
    const remoteOid = await git(other, "rev-parse", "HEAD");

    await writeFile(join(root, "local.txt"), "local\n", "utf8");
    await git(root, "add", "--", "local.txt");
    await git(root, "commit", "--quiet", "-m", "local");
    const diverged = await service.gitReviewDiff("effects", { source: "staged" });
    const divergedHead = await git(root, "rev-parse", "HEAD");
    const needsForce = await service.pushGitReview("effects", {
      remote: "origin",
      remoteRef: "refs/heads/review",
      expectedRepositoryRevision: diverged.repositoryRevision,
      expectedHeadRevision: divergedHead
    });
    expect(needsForce).toMatchObject({
      kind: "needs_force",
      remoteOid,
      ahead: 1,
      behind: 1
    });
    if (needsForce.kind !== "needs_force") throw new Error("Expected force-with-lease confirmation.");
    await expect(service.pushGitReview("effects", {
      remote: "origin",
      remoteRef: "refs/heads/review",
      expectedRepositoryRevision: diverged.repositoryRevision,
      expectedHeadRevision: divergedHead,
      confirmForceWithLease: true,
      expectedRemoteOid: needsForce.remoteOid
    })).resolves.toMatchObject({ kind: "pushed" });
    expect(await git(bare, "rev-parse", "refs/heads/review")).toBe(divergedHead);

    await writeFile(join(root, "local-two.txt"), "local two\n", "utf8");
    await git(root, "add", "--", "local-two.txt");
    await git(root, "commit", "--quiet", "-m", "local two");
    const remoteTwo = await mkdtemp(join(tmpdir(), "joko-review-remote-two-"));
    await git(tmpdir(), "clone", "--quiet", "--branch", "review", bare, remoteTwo);
    await git(remoteTwo, "config", "user.email", "remote@example.test");
    await git(remoteTwo, "config", "user.name", "Remote Test");
    await writeFile(join(remoteTwo, "remote-two.txt"), "remote two\n", "utf8");
    await git(remoteTwo, "add", "--", "remote-two.txt");
    await git(remoteTwo, "commit", "--quiet", "-m", "remote two");
    await git(remoteTwo, "push", "--quiet", "origin", "HEAD:refs/heads/review");
    const secondFence = await service.gitReviewDiff("effects", { source: "staged" });
    const secondHead = await git(root, "rev-parse", "HEAD");
    const secondNeedsForce = await service.pushGitReview("effects", {
      remote: "origin",
      remoteRef: "refs/heads/review",
      expectedRepositoryRevision: secondFence.repositoryRevision,
      expectedHeadRevision: secondHead
    });
    if (secondNeedsForce.kind !== "needs_force") throw new Error("Expected a second force-with-lease confirmation.");
    await writeFile(join(remoteTwo, "remote-three.txt"), "remote three\n", "utf8");
    await git(remoteTwo, "add", "--", "remote-three.txt");
    await git(remoteTwo, "commit", "--quiet", "-m", "remote three");
    await git(remoteTwo, "push", "--quiet", "origin", "HEAD:refs/heads/review");
    await expect(service.pushGitReview("effects", {
      remote: "origin",
      remoteRef: "refs/heads/review",
      expectedRepositoryRevision: secondFence.repositoryRevision,
      expectedHeadRevision: secondHead,
      confirmForceWithLease: true,
      expectedRemoteOid: secondNeedsForce.remoteOid
    })).rejects.toMatchObject({ kind: "lease_expired" });

    const behind = await mkdtemp(join(tmpdir(), "joko-review-behind-"));
    await git(tmpdir(), "clone", "--quiet", "--branch", "review", bare, behind);
    await writeFile(join(remoteTwo, "remote-four.txt"), "remote four\n", "utf8");
    await git(remoteTwo, "add", "--", "remote-four.txt");
    await git(remoteTwo, "commit", "--quiet", "-m", "remote four");
    await git(remoteTwo, "push", "--quiet", "origin", "HEAD:refs/heads/review");
    const behindService = new WorkspaceService();
    await behindService.register({ id: "behind", root: behind, displayName: "Behind", trusted: true });
    const behindFence = await behindService.gitReviewDiff("behind", { source: "staged" });
    const behindHead = await git(behind, "rev-parse", "HEAD");
    await expect(behindService.pushGitReview("behind", {
      remote: "origin",
      remoteRef: "refs/heads/review",
      expectedRepositoryRevision: behindFence.repositoryRevision,
      expectedHeadRevision: behindHead
    })).rejects.toMatchObject({ kind: "invalid" });

    await git(root, "remote", "add", "secret", "https://token@example.test/repository.git");
    const finalFence = await service.gitReviewDiff("effects", { source: "staged" });
    const finalHead = await git(root, "rev-parse", "HEAD");
    await expect(service.pushGitReview("effects", {
      remote: "secret",
      remoteRef: "refs/heads/review",
      expectedRepositoryRevision: finalFence.repositoryRevision,
      expectedHeadRevision: finalHead
    })).rejects.toMatchObject({ kind: "unsupported", message: expect.not.stringContaining("token") });
    await expect(service.pushGitReview("effects", {
      remote: "origin",
      remoteRef: "--force",
      expectedRepositoryRevision: finalFence.repositoryRevision,
      expectedHeadRevision: finalHead
    })).rejects.toMatchObject({ kind: "invalid" });
  }, 45_000);
});
