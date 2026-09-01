import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_TEXT_FILE_MAXIMUM_BYTES,
  WorkspaceGitReviewError,
  WorkspaceService,
  isSafeGitRevision,
  selectDiffHunkPatch
} from "./workspace-service.js";

const execFileAsync = promisify(execFile);

describe("WorkspaceService", () => {
  it("lists and previews files while rejecting path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export const answer = 42;\n");
    const service = new WorkspaceService();
    await service.register({ id: "workspace", root, displayName: "Test", trusted: true });
    const entries = await service.list("workspace", "", { recursive: true });
    expect(entries.map((entry) => entry.path)).toContain("src/index.ts");
    await expect(service.search("workspace", "answer")).resolves.toEqual([
      expect.objectContaining({ path: "src/index.ts", line: 1 })
    ]);
    await expect(service.preview("workspace", "src/index.ts")).resolves.toMatchObject({ text: "export const answer = 42;\n" });
    await expect(service.preview("workspace", "../outside.txt")).rejects.toThrow(/escapes/);
  });

  it("keeps supported code extensions in the truncated text path beyond the UTF-8 probe limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-baseline-code-"));
    await writeFile(join(root, "Component.vue"), "x".repeat(WORKSPACE_TEXT_FILE_MAXIMUM_BYTES + 1), "utf8");
    const service = new WorkspaceService();
    await service.register({ id: "workspace-code", root, displayName: "Workspace code", trusted: true });

    await expect(service.preview("workspace-code", "Component.vue", 16)).resolves.toMatchObject({
      mediaType: "text/plain",
      text: "x".repeat(16),
      truncated: true
    });
  });

  it("keeps glTF model documents out of the editable text path", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-model-"));
    await writeFile(join(root, "scene.gltf"), '{"asset":{"version":"2.0"}}', "utf8");
    await writeFile(join(root, "scene.glb"), Buffer.from([0x67, 0x6c, 0x54, 0x46, 0, 0, 0, 0]));
    const service = new WorkspaceService();
    await service.register({ id: "workspace-model", root, displayName: "Model", trusted: true });

    const gltf = await service.preview("workspace-model", "scene.gltf");
    const glb = await service.preview("workspace-model", "scene.glb");
    expect(gltf).toMatchObject({ mediaType: "model/gltf+json", truncated: false });
    expect(glb).toMatchObject({ mediaType: "model/gltf-binary", truncated: false });
    expect(gltf.text).toBeUndefined();
    expect(gltf.bytes).toBeUndefined();
    expect(glb.text).toBeUndefined();
    expect(glb.bytes).toBeUndefined();
  });

  it("atomically saves existing UTF-8 text and preserves caller-provided line endings", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-write-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "Makefile"), "before\n", "utf8");
    const service = new WorkspaceService();
    await service.register({ id: "workspace-write", root, displayName: "Write", trusted: true });
    const preview = await service.preview("workspace-write", "src/Makefile", 3);

    expect(preview.entry.revision).toMatch(/^sha256:[0-9a-f]{64}:7$/u);
    const result = await service.writeTextFile("workspace-write", {
      path: "src/Makefile",
      text: "first\r\nsecond",
      expectedRevision: preview.entry.revision
    });

    expect(await readFile(join(root, "src", "Makefile"), "utf8")).toBe("first\r\nsecond");
    expect(result).toMatchObject({
      mediaType: "text/plain",
      previousRevision: preview.entry.revision,
      revision: result.entry.revision,
      entry: { path: "src/Makefile", name: "Makefile", size: 13 }
    });
    expect(result.revision).not.toBe(result.previousRevision);
    await expect(service.preview("workspace-write", "src/Makefile")).resolves.toMatchObject({
      text: "first\r\nsecond",
      entry: { revision: result.revision }
    });
  });

  it("fails closed on a stale read revision without overwriting the newer file", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-stale-"));
    const path = join(root, "stale.txt");
    await writeFile(path, "original\n", "utf8");
    const service = new WorkspaceService();
    await service.register({ id: "workspace-stale", root, displayName: "Stale", trusted: true });
    const preview = await service.preview("workspace-stale", "stale.txt");
    await writeFile(path, "external update\n", "utf8");

    await expect(service.writeTextFile("workspace-stale", {
      path: "stale.txt",
      text: "would overwrite\n",
      expectedRevision: preview.entry.revision
    })).rejects.toMatchObject({ kind: "stale", code: "WORKSPACE_TEXT_FILE_STALE" });
    expect(await readFile(path, "utf8")).toBe("external update\n");
  });

  it("rejects non-canonical paths, symbolic links, and non-file targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-paths-"));
    await mkdir(join(root, "actual"));
    const target = join(root, "actual", "target.txt");
    await writeFile(target, "target\n", "utf8");
    await mkdir(join(root, "directory"));
    // A junction exercises the same lstat symbolic-link gate without requiring
    // Windows developer-mode privileges for file symlinks.
    await symlink(join(root, "actual"), join(root, "linked"), "junction");
    const service = new WorkspaceService();
    await service.register({ id: "workspace-paths", root, displayName: "Paths", trusted: true });
    const revision = (await service.preview("workspace-paths", "actual/target.txt")).entry.revision;

    await expect(service.writeTextFile("workspace-paths", {
      path: "linked/target.txt",
      text: "replacement\n",
      expectedRevision: revision
    })).rejects.toMatchObject({ kind: "unsupported" });
    await expect(service.writeTextFile("workspace-paths", {
      path: "directory",
      text: "replacement\n",
      expectedRevision: revision
    })).rejects.toMatchObject({ kind: "unsupported" });
    await expect(service.writeTextFile("workspace-paths", {
      path: "actual/../actual/target.txt",
      text: "replacement\n",
      expectedRevision: revision
    })).rejects.toMatchObject({ kind: "invalid" });
    await expect(service.writeTextFile("workspace-paths", {
      path: target,
      text: "replacement\n",
      expectedRevision: revision
    })).rejects.toMatchObject({ kind: "invalid" });
    expect(await readFile(target, "utf8")).toBe("target\n");
  });

  it("rejects binary, oversized existing, and oversized replacement content", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-write-limits-"));
    await writeFile(join(root, "binary.txt"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(join(root, "invalid-utf8.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(root, "large.txt"), Buffer.alloc(WORKSPACE_TEXT_FILE_MAXIMUM_BYTES + 1, 0x61));
    await writeFile(join(root, "small.txt"), "small\n", "utf8");
    const service = new WorkspaceService();
    await service.register({ id: "workspace-limits", root, displayName: "Limits", trusted: true });
    const binaryRevision = (await service.preview("workspace-limits", "binary.txt")).entry.revision;
    const invalidUtf8Revision = (await service.preview("workspace-limits", "invalid-utf8.txt")).entry.revision;
    const largeRevision = (await service.preview("workspace-limits", "large.txt")).entry.revision;
    const smallRevision = (await service.preview("workspace-limits", "small.txt")).entry.revision;

    await expect(service.writeTextFile("workspace-limits", {
      path: "binary.txt",
      text: "text\n",
      expectedRevision: binaryRevision
    })).rejects.toMatchObject({ kind: "unsupported" });
    await expect(service.writeTextFile("workspace-limits", {
      path: "invalid-utf8.txt",
      text: "text\n",
      expectedRevision: invalidUtf8Revision
    })).rejects.toMatchObject({ kind: "unsupported" });
    await expect(service.writeTextFile("workspace-limits", {
      path: "large.txt",
      text: "text\n",
      expectedRevision: largeRevision
    })).rejects.toMatchObject({ kind: "too_large" });
    await expect(service.writeTextFile("workspace-limits", {
      path: "small.txt",
      text: "x".repeat(WORKSPACE_TEXT_FILE_MAXIMUM_BYTES + 1),
      expectedRevision: smallRevision
    })).rejects.toMatchObject({ kind: "too_large" });
  });

  it("serializes same-file saves so only one matching revision can commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-write-race-"));
    const path = join(root, "race.txt");
    await writeFile(path, "before\n", "utf8");
    const service = new WorkspaceService();
    await service.register({ id: "workspace-race", root, displayName: "Race", trusted: true });
    const revision = (await service.preview("workspace-race", "race.txt")).entry.revision;
    const attempt = (text: string) => service.writeTextFile("workspace-race", {
      path: "race.txt",
      text,
      expectedRevision: revision
    }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );

    const results = await Promise.all([attempt("first\n"), attempt("second\n")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.error : undefined).toMatchObject({
      kind: "stale",
      code: "WORKSPACE_TEXT_FILE_STALE"
    });
    expect(["first\n", "second\n"]).toContain(await readFile(path, "utf8"));
  });

  it("removes a failed staging file and preserves the original on commit failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-write-failure-"));
    const path = join(root, "safe.txt");
    await writeFile(path, "keep me\n", "utf8");
    let stagedPath = "";
    const service = new WorkspaceService({
      commitWorkspaceTextFile: async (staged) => {
        stagedPath = staged;
        throw new Error("injected commit failure");
      }
    });
    await service.register({ id: "workspace-failure", root, displayName: "Failure", trusted: true });
    const revision = (await service.preview("workspace-failure", "safe.txt")).entry.revision;

    await expect(service.writeTextFile("workspace-failure", {
      path: "safe.txt",
      text: "do not keep\n",
      expectedRevision: revision
    })).rejects.toMatchObject({ kind: "write_failed", code: "WORKSPACE_TEXT_FILE_WRITE_FAILED" });
    expect(dirname(stagedPath)).toBe(root);
    expect(await readFile(path, "utf8")).toBe("keep me\n");
    expect(await readdir(root)).toEqual(["safe.txt"]);
  });

  it("keeps index and working-tree diffs separate for the same path", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-git-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await writeFile(join(root, "both.txt"), "staged\n");
    await execFileAsync("git", ["add", "--", "both.txt"], { cwd: root, windowsHide: true });
    await writeFile(join(root, "both.txt"), "staged\nunstaged\n");

    const service = new WorkspaceService();
    await service.register({ id: "workspace-git", root, displayName: "Git", trusted: true });
    const diff = await service.gitDiff("workspace-git");

    expect(diff.index).toContain("diff --git a/both.txt b/both.txt");
    expect(diff.index).toContain("+staged");
    expect(diff.index).not.toContain("+unstaged");
    expect(diff.workingTree).toContain("diff --git a/both.txt b/both.txt");
    expect(diff.workingTree).toContain("+unstaged");
    expect(diff.repositoryRevision).toMatch(/^[0-9a-f]{64}$/u);
    await expect(service.readGitDiffFile("workspace-git", {
      path: "both.txt",
      source: "index",
      expectedRepositoryRevision: diff.repositoryRevision
    })).resolves.toMatchObject({ text: "staged\n", truncated: false });
    await expect(service.readGitDiffFile("workspace-git", {
      path: "both.txt",
      source: "workingTree",
      expectedRepositoryRevision: diff.repositoryRevision
    })).resolves.toMatchObject({ text: "staged\nunstaged\n", truncated: false });
    await expect(service.readGitDiffFile("workspace-git", {
      path: "both.txt",
      source: "index",
      expectedRepositoryRevision: diff.repositoryRevision,
      maximumBytes: 4
    })).resolves.toMatchObject({ text: "stag", truncated: true });
    await writeFile(join(root, "both.txt"), "staged\nunstaged\nchanged again\n");
    await expect(service.readGitDiffFile("workspace-git", {
      path: "both.txt",
      source: "workingTree",
      expectedRepositoryRevision: diff.repositoryRevision
    })).rejects.toMatchObject({ kind: "stale" });
  });

  it("resolves strict base/head refs into an immutable merge-base comparison", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-compare-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "review@example.test"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "Review Test"], { cwd: root, windowsHide: true });
    await writeFile(join(root, "README.md"), "# Base\n");
    await execFileAsync("git", ["add", "--", "README.md"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["commit", "--quiet", "-m", "base"], { cwd: root, windowsHide: true });
    const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true })).stdout.trim();
    const headText = `# Head\n\n${"Changed ".repeat(80)}\n`;
    await writeFile(join(root, "README.md"), headText);
    await execFileAsync("git", ["add", "--", "README.md"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["commit", "--quiet", "-m", "head"], { cwd: root, windowsHide: true });
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true })).stdout.trim();

    const service = new WorkspaceService();
    await service.register({ id: "workspace-compare", root, displayName: "Compare", trusted: true });
    const diff = await service.gitDiff("workspace-compare", [], { baseRevision: base, headRevision: head });

    expect(diff).toMatchObject({ baseRevision: base, headRevision: head, mergeBaseRevision: base, index: "", workingTree: "" });
    expect(diff.comparison).toContain("+# Head");
    await writeFile(join(root, "README.md"), "# Uncommitted worktree content\n");
    await expect(service.readGitDiffFile("workspace-compare", {
      path: "README.md",
      source: "comparison",
      expectedRepositoryRevision: diff.repositoryRevision,
      headRevision: head,
      maximumBytes: 32
    })).resolves.toMatchObject({ text: headText.slice(0, 32), truncated: true, repositoryRevision: diff.repositoryRevision });
    await expect(service.gitDiff("workspace-compare", [], { baseRevision: "--output=/tmp/pwn", headRevision: "HEAD" }))
      .rejects.toMatchObject({ kind: "invalid" });
    await expect(service.gitDiff("workspace-compare", [], { baseRevision: "main", headRevision: "" }))
      .rejects.toThrow(/provided together/u);
  }, 15_000);

  it("revision-fences stage, unstage, and revert hunk mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-hunks-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "review@example.test"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "Review Test"], { cwd: root, windowsHide: true });
    const baseline = Array.from({ length: 32 }, (_, index) => `line ${index + 1}`);
    await writeFile(join(root, "review.txt"), `${baseline.join("\n")}\n`);
    await execFileAsync("git", ["add", "--", "review.txt"], { cwd: root, windowsHide: true });
    await execFileAsync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root, windowsHide: true });
    const changed = [...baseline];
    changed[1] = "first changed";
    changed[25] = "second changed";
    await writeFile(join(root, "review.txt"), `${changed.join("\n")}\n`);

    const service = new WorkspaceService();
    await service.register({ id: "workspace-hunks", root, displayName: "Hunks", trusted: true });
    const initial = await service.gitDiff("workspace-hunks");
    expect(initial.workingTree.match(/^@@ /gmu)).toHaveLength(2);

    await service.applyGitDiffHunk("workspace-hunks", {
      action: "stage",
      source: "workingTree",
      path: "review.txt",
      hunkIndex: 0,
      expectedRepositoryRevision: initial.repositoryRevision
    });
    const afterStage = await service.gitDiff("workspace-hunks");
    expect(afterStage.index).toContain("+first changed");
    expect(afterStage.index).not.toContain("+second changed");
    expect(afterStage.workingTree).toContain("+second changed");
    await expect(service.applyGitDiffHunk("workspace-hunks", {
      action: "stage",
      source: "workingTree",
      path: "review.txt",
      hunkIndex: 0,
      expectedRepositoryRevision: initial.repositoryRevision
    })).rejects.toMatchObject({ kind: "stale" });

    await service.applyGitDiffHunk("workspace-hunks", {
      action: "revert",
      source: "workingTree",
      path: "review.txt",
      hunkIndex: 0,
      expectedRepositoryRevision: afterStage.repositoryRevision,
      confirmRevert: true
    });
    const afterRevert = await service.gitDiff("workspace-hunks");
    expect(afterRevert.workingTree).toBe("");
    await service.applyGitDiffHunk("workspace-hunks", {
      action: "unstage",
      source: "index",
      path: "review.txt",
      hunkIndex: 0,
      expectedRepositoryRevision: afterRevert.repositoryRevision
    });
    const afterUnstage = await service.gitDiff("workspace-hunks");
    expect(afterUnstage.index).toBe("");
    expect(afterUnstage.workingTree).toContain("+first changed");
  }, 15_000);

  it("validates refs and extracts exactly one selected textual hunk", () => {
    expect(isSafeGitRevision("origin/main")).toBe(true);
    expect(isSafeGitRevision("HEAD")).toBe(true);
    expect(isSafeGitRevision("main..evil")).toBe(false);
    expect(isSafeGitRevision("--help")).toBe(false);
    const raw = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n";
    expect(selectDiffHunkPatch(raw, 1)).toContain("@@ -9 +9 @@\n-c\n+d");
    expect(selectDiffHunkPatch(raw, 1)).not.toContain("@@ -1 +1 @@");
    expect(() => selectDiffHunkPatch(raw, 2)).toThrow(WorkspaceGitReviewError);
  });
});
