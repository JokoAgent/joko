import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ renamed: undefined as ((destination: string) => void) | undefined }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    await actual.rename(...args); hooks.renamed?.(String(args[1]));
  } };
});

import { SkillMarketManager, type SkillMarketGitExecutor } from "./skill-market-manager.js";

it.each([
  ["add", "generation"], ["add", "pointer"], ["refresh", "generation"], ["refresh", "pointer"]
] as const)("keeps %s cancellation after the %s switch unpublished and removes its new generation", async (action, phase) => {
  const root = await mkdtemp(join(tmpdir(), "joko-skill-source-cancel-")), store = new OperationalStore(":memory:");
  const sourceRoot = join(root, "source"), cacheRoot = join(root, "cache");
  const git: SkillMarketGitExecutor = async args => {
    if (args[0] === "--version") return { stdout: "git version 2.50.0", stderr: "" };
    if (args[0] === "clone") { await cp(sourceRoot, args.at(-1)!, { recursive: true }); return { stdout: "", stderr: "" }; }
    if (args[0] === "rev-parse") return { stdout: "a".repeat(40), stderr: "" };
    throw new Error("Unexpected source command.");
  };
  const manager = new SkillMarketManager({ store, cacheRoot, git });
  try {
    await mkdir(join(sourceRoot, ".agents", "skills"), { recursive: true });
    await writeFile(join(sourceRoot, ".agents", "skills", "marketplace.json"), JSON.stringify({ format: 1, name: "public-skills", entries: [] }));
    await manager.initialize();
    const input = { kind: "git", repositoryUrl: "https://example.invalid/public-skills.git", sparsePaths: [] } as const;
    const initial = action === "refresh" ? await manager.add(input, 0n) : undefined;
    const before = manager.snapshot(), beforeVersions = await generations(cacheRoot);
    const beforePointer = beforeVersions[0] === undefined ? undefined : await readFile(join(dirname(dirname(beforeVersions[0])), "current"), "utf8");
    const controller = new AbortController();
    hooks.renamed = destination => {
      if (phase === "pointer" ? basename(destination) === "current" : basename(dirname(destination)) === "versions") controller.abort();
    };
    const pending = initial === undefined ? manager.add(input, before.revision, controller.signal) : manager.refresh(initial.id, initial.revision, controller.signal);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    hooks.renamed = undefined;
    expect(manager.snapshot()).toEqual(before);
    expect(await generations(cacheRoot)).toEqual(beforeVersions);
    if (beforeVersions[0] !== undefined) {
      expect(await readFile(join(dirname(dirname(beforeVersions[0])), "current"), "utf8")).toBe(beforePointer);
      expect((await stat(beforeVersions[0])).isDirectory()).toBe(true);
    }
  } finally { hooks.renamed = undefined; await manager.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

async function generations(cacheRoot: string): Promise<string[]> {
  const result: string[] = [], slots = await readdir(join(cacheRoot, "sources"));
  for (const slot of slots) {
    const directory = join(cacheRoot, "sources", slot, "versions");
    for (const version of await readdir(directory).catch(() => [])) result.push(join(directory, version));
  }
  return result.sort();
}
