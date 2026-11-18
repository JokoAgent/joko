import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { PortableSessionSave, portableSessionSaveName } from "../src/portable-session-save.js";
import { mkdtemp } from "./test-paths.js";

const bytes = new Uint8Array([1, 2, 3]);
const scope = () => ({ id: randomUUID(), isCurrent: () => true });

it("allows one write from the selecting document and returns the actual file receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-portable-save-"));
  const path = join(directory, portableSessionSaveName("Project / task"));
  const save = new PortableSessionSave();
  const owner = scope();
  const other = scope();
  const requestId = randomUUID();

  await expect(save.choose(owner, randomUUID(), async () => undefined)).resolves.toBe(false);
  await expect(save.choose(owner, requestId, async () => path)).resolves.toBe(true);
  await expect(save.commit(other, requestId, bytes, 64)).rejects.toThrow("no longer available");
  save.cancel(other, requestId);
  expect(await readdir(directory)).toEqual([]);

  await expect(save.commit(owner, requestId, bytes, 64)).resolves.toMatchObject({ bytes: 3 });
  expect(await readFile(path)).toEqual(Buffer.from(bytes));
  expect(await readdir(directory)).toEqual(["Project - task.jshare"]);
  await expect(save.commit(owner, requestId, new Uint8Array([4]), 64)).rejects.toThrow("no longer available");
  expect(await readFile(path)).toEqual(Buffer.from(bytes));
});

it("retires a pending chooser and an already chosen destination with their original documents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-portable-retired-"));
  const path = join(directory, "old.jshare");
  const save = new PortableSessionSave();
  const owner = scope();
  const requestId = randomUUID();
  let selectPath!: (path: string) => void;
  const pending = save.choose(owner, requestId, () => new Promise<string>((resolve) => { selectPath = resolve; }));
  save.retire(owner);
  selectPath(path);
  await expect(pending).resolves.toBe(false);
  await expect(save.commit(owner, requestId, bytes, 64)).rejects.toThrow("no longer available");

  const replacement = scope();
  await expect(save.choose(replacement, requestId, async () => path)).resolves.toBe(true);
  save.retire(replacement);
  await expect(save.commit(replacement, requestId, bytes, 64)).rejects.toThrow("no longer available");
  expect(await readdir(directory)).toEqual([]);
});

it("keeps the destination identity captured before the node produces the package", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-portable-changed-"));
  const path = join(directory, "export.jshare");
  const save = new PortableSessionSave();
  const owner = scope();
  const requestId = randomUUID();

  await expect(save.choose(owner, requestId, async () => path)).resolves.toBe(true);
  await writeFile(path, "A file appeared during export");
  await expect(save.commit(owner, requestId, bytes, 64)).rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
  expect(await readFile(path, "utf8")).toBe("A file appeared during export");
  expect(await readdir(directory)).toEqual(["export.jshare"]);
});
