import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  WorkspaceScanError,
  WorkspaceSearchError,
  WorkspaceService
} from "./workspace-service.js";

const execFileAsync = promisify(execFile);

describe("WorkspaceService file discovery", () => {
  it("uses Git ignore semantics for root, nested, negative, info, and configured excludes", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-ignore-git-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await writeFile(join(root, "tracked.log"), "tracked\n", "utf8");
    await execFileAsync("git", ["add", "--", "tracked.log"], { cwd: root, windowsHide: true });

    await mkdir(join(root, "build"));
    await mkdir(join(root, "nested"));
    await mkdir(join(root, "vendor"));
    await writeFile(join(root, ".gitignore"), [
      "root-ignored.txt",
      "vendor/",
      "*.log",
      "!keep.log",
      "build/*",
      "!build/keep.txt",
      ""
    ].join("\n"), "utf8");
    await writeFile(join(root, "root-ignored.txt"), "ignored\n", "utf8");
    await writeFile(join(root, "drop.log"), "ignored\n", "utf8");
    await writeFile(join(root, "keep.log"), "visible\n", "utf8");
    await writeFile(join(root, "build", "drop.txt"), "ignored\n", "utf8");
    await writeFile(join(root, "build", "keep.txt"), "visible\n", "utf8");
    await writeFile(join(root, "vendor", "package.txt"), "ignored\n", "utf8");
    await writeFile(join(root, "nested", ".gitignore"), "*.tmp\n!keep.tmp\n", "utf8");
    await writeFile(join(root, "nested", "drop.tmp"), "ignored\n", "utf8");
    await writeFile(join(root, "nested", "keep.tmp"), "visible\n", "utf8");
    await writeFile(join(root, "nested", "visible.txt"), "visible\n", "utf8");
    await writeFile(join(root, ".git", "info", "exclude"), "info-only.txt\n", "utf8");
    await writeFile(join(root, "info-only.txt"), "ignored\n", "utf8");
    const configuredExclude = join(root, ".git", "joko-global-exclude");
    await writeFile(configuredExclude, "configured-only.txt\n", "utf8");
    await execFileAsync("git", ["config", "core.excludesFile", configuredExclude], { cwd: root, windowsHide: true });
    await writeFile(join(root, "configured-only.txt"), "ignored\n", "utf8");
    await symlink(join(root, "nested"), join(root, "linked"), "junction");

    const service = new WorkspaceService();
    await service.register({ id: "git-ignore", root, displayName: "Git ignore", trusted: true });
    const paths = (await service.list("git-ignore", "", { recursive: true })).map((entry) => entry.path);

    expect(paths).toEqual(expect.arrayContaining([
      ".gitignore",
      "build",
      "build/keep.txt",
      "keep.log",
      "nested",
      "nested/.gitignore",
      "nested/keep.tmp",
      "nested/visible.txt",
      "tracked.log"
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      ".git",
      "build/drop.txt",
      "configured-only.txt",
      "drop.log",
      "info-only.txt",
      "linked",
      "nested/drop.tmp",
      "root-ignored.txt",
      "vendor",
      "vendor/package.txt"
    ]));
    await expect(service.list("git-ignore", "nested"))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "nested/keep.tmp" }),
        expect.objectContaining({ path: "nested/visible.txt" })
      ]));
  });

  it("uses a deterministic nested .gitignore fallback outside Git repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-ignore-fallback-"));
    await mkdir(join(root, "out"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, ".gitignore"), "root.skip\nout/*\n!out/keep.txt\n", "utf8");
    await writeFile(join(root, "root.skip"), "ignored\n", "utf8");
    await writeFile(join(root, "visible.txt"), "visible\n", "utf8");
    await writeFile(join(root, "out", "drop.txt"), "ignored\n", "utf8");
    await writeFile(join(root, "out", "keep.txt"), "visible\n", "utf8");
    await writeFile(join(root, "nested", ".gitignore"), "*.tmp\n!keep.tmp\n", "utf8");
    await writeFile(join(root, "nested", "drop.tmp"), "ignored\n", "utf8");
    await writeFile(join(root, "nested", "keep.tmp"), "visible\n", "utf8");

    const service = new WorkspaceService();
    await service.register({ id: "fallback-ignore", root, displayName: "Fallback ignore", trusted: true });
    const paths = (await service.list("fallback-ignore", "", { recursive: true })).map((entry) => entry.path);

    expect(paths).toEqual(expect.arrayContaining([
      ".gitignore",
      "nested",
      "nested/.gitignore",
      "nested/keep.tmp",
      "out",
      "out/keep.txt",
      "visible.txt"
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      "nested/drop.tmp",
      "out/drop.txt",
      "root.skip"
    ]));
  });

  it("provides the explicit document tree without VCS ignores or builtin caches", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-baseline-tree-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await writeFile(join(root, ".gitignore"), "ignored-dir/\n.settings\n", "utf8");
    await mkdir(join(root, "ignored-dir"));
    await mkdir(join(root, ".notes"));
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, ".cache"));
    await mkdir(join(root, "Folder.meta"));
    await mkdir(join(root, "nested"));
    await mkdir(join(root, "nested", "build"));
    await writeFile(join(root, ".settings"), "visible dotfile\n", "utf8");
    await writeFile(join(root, ".notes", "idea.md"), "visible dot directory\n", "utf8");
    await writeFile(join(root, "ignored-dir", "kept.txt"), "visible despite VCS ignore\n", "utf8");
    await writeFile(join(root, "Asset.cs.meta"), "hidden document metadata\n", "utf8");
    await writeFile(join(root, "node_modules", "package.js"), "builtin cache\n", "utf8");
    await writeFile(join(root, ".cache", "cached.txt"), "builtin cache\n", "utf8");
    await writeFile(join(root, "nested", "build", "output.js"), "builtin cache\n", "utf8");
    await symlink(join(root, "ignored-dir"), join(root, "linked"), "junction");

    const service = new WorkspaceService({ gitExecutable: `missing-joko-git-${Date.now()}` });
    await service.register({ id: "document-tree", root, displayName: "Document tree", trusted: true });
    const paths = (await service.list("document-tree", "", {
      recursive: true,
      listingPolicy: "document_tree"
    })).map((entry) => entry.path);

    expect(paths).toEqual(expect.arrayContaining([
      ".gitignore",
      ".notes",
      ".notes/idea.md",
      ".settings",
      "ignored-dir",
      "ignored-dir/kept.txt",
      "nested"
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      ".git",
      ".cache",
      "Asset.cs.meta",
      "Folder.meta",
      "linked",
      "nested/build",
      "node_modules"
    ]));
    await expect(service.list("document-tree", ".git", { listingPolicy: "document_tree" }))
      .rejects.toBeInstanceOf(WorkspaceScanError);
    await expect(service.list("document-tree", "linked", { listingPolicy: "document_tree" }))
      .rejects.toBeInstanceOf(WorkspaceScanError);
    await expect(service.list("document-tree", "nested/../ignored-dir", { listingPolicy: "document_tree" }))
      .rejects.toBeInstanceOf(WorkspaceScanError);
  });

  it("distinguishes an empty tree from a Git-backed scanner failure", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "joko-workspace-empty-"));
    const emptyService = new WorkspaceService();
    await emptyService.register({ id: "empty", root: emptyRoot, displayName: "Empty", trusted: true });
    await expect(emptyService.list("empty", "", { recursive: true })).resolves.toEqual([]);

    const gitRoot = await mkdtemp(join(tmpdir(), "joko-workspace-broken-git-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: gitRoot, windowsHide: true });
    const brokenService = new WorkspaceService({ gitExecutable: `missing-joko-git-${Date.now()}` });
    await brokenService.register({ id: "broken-git", root: gitRoot, displayName: "Broken Git", trusted: true });
    await expect(brokenService.list("broken-git")).rejects.toBeInstanceOf(WorkspaceScanError);
  });
});

describe("WorkspaceService search semantics", () => {
  it("implements literal/case options and preserves exact range, revision, and page boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-search-"));
    await writeFile(join(root, "a.txt"), "Foo\nfoo\nprefix [ tail\nabc123\nhit one\nhit two\nhit three\n", "utf8");
    await writeFile(join(root, "b.txt"), "foo\nabc999\nhit four\n", "utf8");
    const service = new WorkspaceService();
    await service.register({ id: "search", root, displayName: "Search", trusted: true });

    const insensitive = await service.search("search", "foo", { caseSensitive: false, regularExpression: false });
    expect(insensitive.map(({ path, line }) => `${path}:${line}`)).toEqual(["a.txt:1", "a.txt:2", "b.txt:1"]);
    await expect(service.search("search", "Foo", { caseSensitive: true, regularExpression: false }))
      .resolves.toEqual([expect.objectContaining({ path: "a.txt", line: 1 })]);

    const literalBracket = await service.search("search", "[", { caseSensitive: true, regularExpression: false });
    expect(literalBracket).toEqual([expect.objectContaining({
      path: "a.txt",
      line: 3,
      column: 8,
      endColumn: 9,
      startByte: 15,
      endByte: 16,
      preview: "prefix [ tail"
    })]);
    const preview = await service.preview("search", "a.txt", 4);
    expect(preview).toMatchObject({ text: "Foo\n", truncated: true });
    expect(literalBracket[0]?.revision).toBe(preview.entry.revision);

    await expect(service.search("search", "abc\\d+", { caseSensitive: true, regularExpression: false })).resolves.toEqual([]);
    await expect(service.search("search", "abc\\d+", { caseSensitive: true, regularExpression: true }))
      .resolves.toEqual([
        expect.objectContaining({ path: "a.txt", line: 4, column: 1, endColumn: 7 }),
        expect.objectContaining({ path: "b.txt", line: 2, column: 1, endColumn: 7 })
      ]);

    const firstPage = await service.searchPage("search", "hit", {
      caseSensitive: true,
      regularExpression: false,
      maximumResults: 2
    });
    expect(firstPage).toMatchObject({
      truncated: true,
      nextOffset: 2,
      totalResults: 4,
      totalFiles: 2,
      matches: [
        expect.objectContaining({ path: "a.txt", line: 5 }),
        expect.objectContaining({ path: "a.txt", line: 6 })
      ]
    });
    const secondPage = await service.searchPage("search", "hit", {
      caseSensitive: true,
      regularExpression: false,
      maximumResults: 2,
      offset: firstPage.nextOffset
    });
    expect(secondPage).toMatchObject({
      truncated: false,
      totalResults: 4,
      totalFiles: 2,
      matches: [
        expect.objectContaining({ path: "a.txt", line: 7 }),
        expect.objectContaining({ path: "b.txt", line: 3 })
      ]
    });
    expect(secondPage).not.toHaveProperty("nextOffset");
  });

  it("distinguishes empty results from regex and executable failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-search-errors-"));
    await writeFile(join(root, "file.txt"), "needle\n", "utf8");
    const service = new WorkspaceService();
    await service.register({ id: "search-errors", root, displayName: "Search errors", trusted: true });

    await expect(service.search("search-errors", "missing", { regularExpression: false })).resolves.toEqual([]);
    await expect(service.search("search-errors", "[", { regularExpression: true }))
      .rejects.toBeInstanceOf(WorkspaceSearchError);

    const brokenService = new WorkspaceService({ ripgrepExecutable: `missing-joko-rg-${Date.now()}` });
    await brokenService.register({ id: "broken-search", root, displayName: "Broken search", trusted: true });
    await expect(brokenService.search("broken-search", "")).resolves.toEqual([]);
    await expect(brokenService.search("broken-search", "needle"))
      .rejects.toMatchObject({ name: "WorkspaceSearchError", kind: "search_failed" });

    const streamEvents = [];
    for await (const event of brokenService.searchStream("broken-search", "needle", false)) streamEvents.push(event);
    expect(streamEvents).toEqual([{
      kind: "error",
      code: "RG_UNAVAILABLE",
      message: "ripgrep is unavailable."
    }]);
  });
});
