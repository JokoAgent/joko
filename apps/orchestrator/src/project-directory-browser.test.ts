import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Code } from "@connectrpc/connect";
import { afterEach, expect, it } from "vitest";

import { listProjectDirectories } from "./project-directory-browser.js";

const roots: string[] = [];
afterEach(async () => {
  const allowed = resolve(tmpdir()) + sep;
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(allowed)) throw new Error("Refusing cleanup outside the test temp directory.");
    await rm(root, { recursive: true, force: true });
  }
});

it("returns bounded service-native directory paths, parent and empty states without files", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-project-browser-"));
  roots.push(root);
  await mkdir(join(root, "beta"));
  await mkdir(join(root, "alpha"));
  await writeFile(join(root, "notes.txt"), "not a directory");
  const signal = new AbortController().signal;
  const canonicalRoot = await realpath(root);

  expect(await listProjectDirectories(root, signal)).toEqual({
    path: canonicalRoot, parentPath: dirname(canonicalRoot), truncated: false,
    directories: [
      { name: "alpha", path: join(canonicalRoot, "alpha") },
      { name: "beta", path: join(canonicalRoot, "beta") }
    ]
  });
  expect((await listProjectDirectories(join(root, "alpha"), signal)).directories).toEqual([]);
  await expect(listProjectDirectories("relative/path", signal)).rejects.toMatchObject({ code: Code.InvalidArgument });
  await expect(listProjectDirectories(join(root, "notes.txt"), signal)).rejects.toMatchObject({ code: Code.FailedPrecondition });
  await expect(listProjectDirectories(join(root, "missing"), signal)).rejects.toMatchObject({ code: Code.NotFound });
  const aborted = new AbortController();
  aborted.abort();
  await expect(listProjectDirectories(root, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
});

it("marks large service directories as incomplete without loading an unbounded listing", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-project-browser-"));
  roots.push(root);
  await Promise.all(Array.from({ length: 205 }, (_, index) => mkdir(join(root, `dir-${index.toString().padStart(3, "0")}`))));
  const listing = await listProjectDirectories(root, new AbortController().signal);
  expect(listing.directories).toHaveLength(200);
  expect(listing.truncated).toBe(true);
});
