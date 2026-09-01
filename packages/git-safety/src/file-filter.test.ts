import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSnapshotFilePlanFromEntries,
  parseStatusPorcelainZ,
  resolveRepositoryPath
} from "./file-filter.js";

describe("workspace savepoint file filtering", () => {
  it("parses literal porcelain records, including rename pairs", () => {
    expect(parseStatusPorcelainZ(" M tracked.txt\0R  new name.txt\0old name.txt\0?? fresh.txt\0")).toEqual([
      { code: " M", relativePath: "tracked.txt" },
      { code: "R ", relativePath: "new name.txt", oldRelativePath: "old name.txt" },
      { code: "??", relativePath: "fresh.txt" }
    ]);
  });

  it("fails closed for sensitive, oversized, linked, nested, conflicted, and escaping paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-git-filter-"));
    await writeFile(join(root, "safe.txt"), "ordinary text", "utf8");
    await writeFile(join(root, ".env.local"), "PASSWORD=not-persisted-value", "utf8");
    await writeFile(join(root, "content.txt"), "authorization = opaque-value-12345", "utf8");
    await writeFile(join(root, "large.bin"), Buffer.alloc(32, 1));
    await mkdir(join(root, "nested"));
    await mkdir(join(root, "nested", ".git"));
    await writeFile(join(root, "nested", "file.txt"), "nested", "utf8");
    let symbolicLinkCreated = true;
    try {
      await symlink(join(root, "safe.txt"), join(root, "linked.txt"));
    } catch (error) {
      if (process.platform !== "win32") throw error;
      symbolicLinkCreated = false;
    }

    const plan = await buildSnapshotFilePlanFromEntries(root, [
      { code: " M", relativePath: "safe.txt" },
      { code: "??", relativePath: ".env.local" },
      { code: "??", relativePath: "content.txt" },
      { code: "??", relativePath: "large.bin" },
      { code: "??", relativePath: "nested/file.txt" },
      ...(symbolicLinkCreated ? [{ code: "??" as const, relativePath: "linked.txt" }] : []),
      { code: "UU", relativePath: "conflict.txt" },
      { code: "??", relativePath: "../escape.txt" }
    ], { maxFileBytes: 16, maxContentScanBytes: 16 });

    expect(plan.included).toEqual([{ relativePath: "safe.txt" }]);
    expect(Object.fromEntries(plan.skipped.map((item) => [item.relativePath, item.reason]))).toEqual({
      ".env.local": "sensitive_path",
      "content.txt": "large_file",
      "large.bin": "large_file",
      "nested/file.txt": "nested_repository",
      ...(symbolicLinkCreated ? { "linked.txt": "symbolic_link" } : {}),
      "conflict.txt": "conflict",
      "../escape.txt": "unsafe_path"
    });
  });

  it("detects credential-shaped content without returning its bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-git-content-filter-"));
    await writeFile(join(root, "config.txt"), "api_key=sk-examplevalue123456", "utf8");
    const plan = await buildSnapshotFilePlanFromEntries(root, [
      { code: "??", relativePath: "config.txt" }
    ]);
    expect(plan.skipped).toEqual([{ relativePath: "config.txt", reason: "sensitive_content" }]);
    expect(JSON.stringify(plan)).not.toContain("examplevalue123456");
  });

  it("checks nested repositories from a canonical repository-root alias", async () => {
    const parent = await mkdtemp(join(tmpdir(), "joko-git-root-alias-"));
    const root = join(parent, "repository");
    const rootAlias = join(parent, "repository-alias");
    await mkdir(root);
    await writeFile(join(root, "safe.txt"), "ordinary text", "utf8");
    await mkdir(join(root, "nested", ".git"), { recursive: true });
    await writeFile(join(root, "nested", "file.txt"), "nested", "utf8");
    await symlink(root, rootAlias, process.platform === "win32" ? "junction" : "dir");

    const plan = await buildSnapshotFilePlanFromEntries(rootAlias, [
      { code: " M", relativePath: "safe.txt" },
      { code: "??", relativePath: "nested/file.txt" }
    ]);

    expect(plan).toEqual({
      included: [{ relativePath: "safe.txt" }],
      skipped: [{ relativePath: "nested/file.txt", reason: "nested_repository" }]
    });
  });

  it("accepts only canonical repository-relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-git-path-"));
    expect(resolveRepositoryPath(root, "src/file.ts")).toBe(join(root, "src", "file.ts"));
    expect(resolveRepositoryPath(root, "../outside")).toBeNull();
    expect(resolveRepositoryPath(root, ".git/config")).toBeNull();
    expect(resolveRepositoryPath(root, "C:/outside")).toBeNull();
  });
});
