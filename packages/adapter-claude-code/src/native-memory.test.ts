import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  ClaudeNativeMemoryFilesystemError,
  resetClaudeNativeMemory,
  type ClaudeNativeMemoryFileSystem
} from "./native-memory.js";

describe("Claude native memory filesystem owner", () => {
  test.each([0, 1])("stops before the next removal when authorization retires after %i deletions", async (completed) => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "joko-claude-native-memory-retired-"));
    const paths = [join(root, "projects", "first", "memory"), join(root, "projects", "second", "memory")];
    try {
      for (const path of paths) {
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "MEMORY.md"), "native memory");
      }
      const scanned = new Set<string>();
      const removed: string[] = [];
      let authorized = true;
      const fileSystem: ClaudeNativeMemoryFileSystem = {
        lstat,
        realpath: async (path) => {
          const canonical = await realpath(path);
          if (paths.includes(path)) {
            if (scanned.has(path) && removed.length === completed) authorized = false;
            scanned.add(path);
          }
          return canonical;
        },
        readdir: (path) => readdir(path, { withFileTypes: true }),
        rm: async (path) => {
          await rm(path, { recursive: true, force: false });
          removed.push(path);
        }
      };
      await expect(resetClaudeNativeMemory(root, fileSystem, () => {
        if (!authorized) throw new Error("Original device revoked.");
      })).rejects.toEqual(new ClaudeNativeMemoryFilesystemError("authorization_retired", completed > 0));
      expect(removed).toHaveLength(completed);
      for (const path of paths.filter(path => !removed.includes(path))) {
        await expect(readFile(join(path, "MEMORY.md"), "utf8")).resolves.toBe("native memory");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("marks a deletion failure after an earlier target as outcome-unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-claude-native-memory-partial-"));
    const configDirectory = join(root, "profile");
    const first = join(configDirectory, "projects", "first", "memory");
    const second = join(configDirectory, "projects", "second", "memory");
    try {
      await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
      await Promise.all([
        writeFile(join(first, "MEMORY.md"), "first"),
        writeFile(join(second, "MEMORY.md"), "second")
      ]);
      let removals = 0;
      const fileSystem: ClaudeNativeMemoryFileSystem = {
        lstat,
        realpath,
        readdir: (path) => readdir(path, { withFileTypes: true }),
        rm: async (path) => {
          removals += 1;
          if (removals === 2) throw new Error("private failure");
          await rm(path, { recursive: true, force: false });
        }
      };

      await expect(resetClaudeNativeMemory(configDirectory, fileSystem)).rejects.toEqual(
        new ClaudeNativeMemoryFilesystemError("remove_failed", true)
      );
      expect(removals).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
