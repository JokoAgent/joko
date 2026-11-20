import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeFileActionRequestId } from "@joko/contracts";
import { create as createTar } from "tar";
import { expect, it, vi } from "vitest";
import { NativeWorkspaceDirectoryDownload } from "../src/native-workspace-directory-download.js";

it("publishes the original directory once per gesture without overwriting Downloads entries", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-directory-save-test-")));
  const source = join(root, "source");
  const downloads = join(root, "Downloads");
  const reveal = vi.fn();
  const scope = { id: "owner", isCurrent: () => true };
  const native = new NativeWorkspaceDirectoryDownload({ downloadRoot: () => downloads, revealPath: reveal });
  try {
    await mkdir(join(source, "docs", "nested", "empty"), { recursive: true });
    await mkdir(join(downloads, "docs"), { recursive: true });
    await writeFile(join(downloads, "docs", "keep.txt"), "Existing Downloads content");
    await writeFile(join(source, "docs", "guide.txt"), "Original remote guide");
    await writeFile(join(source, "docs", "nested", "data.bin"), Uint8Array.of(0, 1, 254, 255));
    const archive = join(root, "docs.tar.gz");
    await createTar({ cwd: source, file: archive, gzip: true, portable: true }, ["./docs"]);
    const bytes = await readFile(archive);
    const first = { requestId: nativeFileActionRequestId(1, randomUUID()), directoryName: "docs", bytes };
    const second = { ...first, requestId: nativeFileActionRequestId(2, randomUUID()) };
    expect(await Promise.all([native.save(first, scope), native.save(first, scope), native.save(second, scope)])).toEqual([true, true, true]);
    expect(reveal.mock.calls.map(([path]) => path).sort()).toEqual([join(downloads, "docs (1)"), join(downloads, "docs (2)")]);
    expect((await readdir(downloads)).sort()).toEqual(["docs", "docs (1)", "docs (2)"]);
    expect(await readFile(join(downloads, "docs", "keep.txt"), "utf8")).toBe("Existing Downloads content");
    for (const name of ["docs (1)", "docs (2)"]) {
      const delivered = join(downloads, name);
      expect(await readFile(join(delivered, "guide.txt"), "utf8")).toBe("Original remote guide");
      expect(await readFile(join(delivered, "nested", "data.bin"))).toEqual(Buffer.from([0, 1, 254, 255]));
      expect(await readdir(join(delivered, "nested", "empty"))).toEqual([]);
    }

    await expect(native.save({ requestId: nativeFileActionRequestId(3, randomUUID()), directoryName: "different", bytes }, scope)).rejects.toThrow();
    const pending = { requestId: nativeFileActionRequestId(4, randomUUID()), directoryName: "docs", bytes };
    const saving = native.save(pending, scope);
    native.cancel(pending.requestId, scope.id);
    expect(await saving).toBe(false);
    expect((await readdir(downloads)).sort()).toEqual(["docs", "docs (1)", "docs (2)"]);
    expect(reveal).toHaveBeenCalledTimes(2);
  } finally {
    native.cancelPending();
    await rm(root, { recursive: true, force: true });
  }
});
