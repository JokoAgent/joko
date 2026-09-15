import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  ClaudeNativeMemoryFilesystemError,
  resetClaudeNativeMemory,
  type ClaudeNativeMemoryFileSystem
} from "./native-memory.js";

describe("Claude native memory filesystem owner", () => {
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
