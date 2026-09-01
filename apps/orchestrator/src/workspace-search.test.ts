import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  WORKSPACE_KNOWN_TEXT_FILENAMES,
  WORKSPACE_SUPPORTED_TEXT_EXTENSIONS,
  workspaceFileIndexArguments,
  workspaceTextSearchArguments,
  runWorkspaceFileIndex,
  streamWorkspaceTextSearch
} from "./workspace-search.js";
import { WorkspaceService } from "./workspace-service.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projectRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  return root;
}

describe("workspace ripgrep contracts", () => {
  it("uses fixed-string/index flags and the complete text whitelist", () => {
    expect(workspaceFileIndexArguments()).toEqual([
      "--files", "--hidden", "--no-messages", "--", "."
    ]);
    const insensitive = workspaceTextSearchArguments("[literal", false);
    expect(insensitive.slice(0, 4)).toEqual(["--json", "-F", "--max-count=200", "--hidden"]);
    expect(insensitive.slice(-4)).toEqual(["-i", "--", "[literal", "."]);
    expect(insensitive).not.toContain("--regexp");
    expect(insensitive.filter((value) => value === "--glob")).toHaveLength(WORKSPACE_SUPPORTED_TEXT_EXTENSIONS.length);
    expect(insensitive.filter((value) => value === "--iglob")).toHaveLength(WORKSPACE_KNOWN_TEXT_FILENAMES.length);
    expect(workspaceTextSearchArguments("Needle", true)).not.toContain("-i");
  });

  it("indexes hidden files, honours Git ignores, caps at the requested boundary, and returns a stable fence", async () => {
    const root = await projectRoot("joko-file-index-");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(root, "ignored.txt"), "ignored\n", "utf8");
    await writeFile(join(root, ".hidden.txt"), "hidden\n", "utf8");
    await writeFile(join(root, "visible.txt"), "visible\n", "utf8");

    const first = await runWorkspaceFileIndex({ executable: "rg", cwd: root });
    const second = await runWorkspaceFileIndex({ executable: "rg", cwd: root });
    expect(first.paths).toEqual(expect.arrayContaining([".gitignore", ".hidden.txt", "visible.txt"]));
    expect(first.paths).not.toContain("ignored.txt");
    expect(first.truncated).toBe(false);
    expect(new Set(second.paths)).toEqual(new Set(first.paths));
    expect(second.revision).toBe(first.revision);
    expect(second.truncated).toBe(first.truncated);

    const capped = await runWorkspaceFileIndex({ executable: "rg", cwd: root, cap: 2 });
    expect(capped.paths).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    expect(capped.revision).not.toBe(first.revision);
  });

  it("searches only supported text files, applies the per-file cap, and streams a terminal count", async () => {
    const root = await projectRoot("joko-text-search-");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(root, "ignored.txt"), "needle\n", "utf8");
    await writeFile(join(root, "binary.png"), "needle\n", "utf8");
    await writeFile(join(root, ".hidden.md"), "needle\n", "utf8");
    await writeFile(join(root, "few.txt"), "NEEDLE\nneedle\n", "utf8");
    await writeFile(join(root, "many.txt"), `${"needle\n".repeat(205)}`, "utf8");

    const events = [];
    for await (const event of streamWorkspaceTextSearch({
      executable: "rg",
      cwd: root,
      query: "needle",
      caseSensitive: false
    })) events.push(event);
    const matches = events.filter((event) => event.kind === "match");
    const end = events.at(-1);
    // Compose positive whitelist globs with --hidden. ripgrep treats those
    // explicit globs as authoritative and includes the otherwise ignored file.
    expect(matches).toHaveLength(204);
    expect(matches.some((event) => event.kind === "match" && event.match.data.path.text.includes("binary.png"))).toBe(false);
    expect(matches.some((event) => event.kind === "match" && event.match.data.path.text.includes("ignored.txt"))).toBe(true);
    expect(end).toMatchObject({ kind: "end", truncated: false, totalMatches: 204, totalFiles: 4 });
  });

  it("kills at the 1000-result global ceiling and honours cancellation", async () => {
    const root = await projectRoot("joko-search-cap-");
    for (let index = 0; index < 6; index += 1) {
      await writeFile(join(root, `${index}.txt`), "hit\n".repeat(205), "utf8");
    }
    const events = [];
    for await (const event of streamWorkspaceTextSearch({
      executable: "rg",
      cwd: root,
      query: "hit",
      caseSensitive: true
    })) events.push(event);
    expect(events.filter((event) => event.kind === "match")).toHaveLength(1_000);
    expect(events.at(-1)).toMatchObject({ kind: "end", truncated: true, totalMatches: 1_000 });

    const inFlightAbort = new AbortController();
    const iterator = streamWorkspaceTextSearch({
      executable: "rg",
      cwd: root,
      query: "hit",
      caseSensitive: true,
      signal: inFlightAbort.signal
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { kind: "match" } });
    inFlightAbort.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });

    const aborted = new AbortController();
    aborted.abort();
    await expect(runWorkspaceFileIndex({ executable: "rg", cwd: root, signal: aborted.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("WorkspaceService search/index projection", () => {
  it("adds canonical ranges and per-file content revisions to streamed matches", async () => {
    const root = await projectRoot("joko-search-service-");
    await writeFile(join(root, "README.md"), "prefix [literal tail\n前🐾后🐾\n", "utf8");
    const service = new WorkspaceService();
    await service.register({ id: "project", root, displayName: "Project", trusted: true });

    const index = await service.listFiles("project");
    expect(index).toMatchObject({ paths: expect.arrayContaining(["README.md"]), truncated: false });
    expect(index.revision).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const events = [];
    for await (const event of service.searchStream("project", "[literal", true)) events.push(event);
    expect(events[0]).toMatchObject({
      kind: "match",
      match: {
        path: "README.md",
        line: 1,
        column: 8,
        endColumn: 16,
        preview: "prefix [literal tail"
      }
    });
    if (events[0]?.kind === "match") expect(events[0].match.revision).toMatch(/^sha256:/u);
    expect(events.at(-1)).toMatchObject({ kind: "end", truncated: false, totalResults: 1, totalFiles: 1 });

    const unicodeEvents = [];
    for await (const event of service.searchStream("project", "🐾", true)) unicodeEvents.push(event);
    expect(unicodeEvents[0]).toMatchObject({
      kind: "match",
      match: {
        path: "README.md",
        line: 2,
        column: 2,
        endColumn: 4,
        preview: "前🐾后🐾",
        submatches: [
          { startByte: 3, endByte: 7 },
          { startByte: 10, endByte: 14 }
        ]
      }
    });
  });
});
