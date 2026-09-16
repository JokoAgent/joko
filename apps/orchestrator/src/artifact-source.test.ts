import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { resolveStoredArtifactSource, validateLocalArtifactSource } from "./artifact-source.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0).reverse()) await rm(path, { recursive: true, force: true });
});

describe("Artifact source validation", () => {
  it("returns only a canonical root and relative path after exact content verification", async () => {
    const root = await temporaryDirectory();
    const file = join(root, "output.txt");
    const bytes = Buffer.from("canonical output");
    await writeFile(file, bytes);
    const result = await validateLocalArtifactSource({
      workspaceRoot: root,
      sourcePath: file,
      expectedByteLength: bytes.byteLength,
      expectedSha256: createHash("sha256").update(bytes).digest("hex")
    });
    expect(result).toEqual({
      workspaceRoot: await realpath(root),
      relativePath: "output.txt",
      sourcePath: await realpath(file)
    });
    expect(resolveStoredArtifactSource(result.workspaceRoot, result.relativePath)).toBe(result.sourcePath);
  });

  it("rejects paths outside the Workspace, symbolic files, changed content, and cancellation", async () => {
    const root = await temporaryDirectory();
    const outsideRoot = await temporaryDirectory();
    const outside = join(outsideRoot, "outside.txt");
    await writeFile(outside, "outside");
    const exact = { expectedByteLength: 7, expectedSha256: createHash("sha256").update("outside").digest("hex") };
    await expect(validateLocalArtifactSource({ workspaceRoot: root, sourcePath: outside, ...exact }))
      .rejects.toThrow(/outside/u);

    const link = join(root, "link.txt");
    try {
      await symlink(outside, link, "file");
      await expect(validateLocalArtifactSource({ workspaceRoot: root, sourcePath: link, ...exact }))
        .rejects.toThrow(/non-symbolic/u);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }

    const local = join(root, "local.txt");
    await writeFile(local, "changed");
    await expect(validateLocalArtifactSource({ workspaceRoot: root, sourcePath: local, ...exact }))
      .rejects.toThrow(/canonical content/u);
    const controller = new AbortController();
    controller.abort();
    await expect(validateLocalArtifactSource({ workspaceRoot: root, sourcePath: local, ...exact, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "joko-artifact-source-"));
  cleanupPaths.push(directory);
  return directory;
}
