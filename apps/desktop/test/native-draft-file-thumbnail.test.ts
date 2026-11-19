import { mkdtemp, readFile, readdir, realpath, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { readNativeDraftFileThumbnail } from "../src/native-draft-file-thumbnail.js";

it("previews only a staged copy of the selected document and removes it after reading", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(join(await realpath(tmpdir()), "joko-draft-preview-test-")));
  const file = { name: "notes.pdf", bytes: Uint8Array.of(112, 100, 102) };
  const render = vi.fn(async (path: string) => {
    expect(dirname(dirname(path))).toBe(temporaryDirectory);
    expect(await readFile(path)).toEqual(Buffer.from(file.bytes));
    return "data:image/png;base64,dGVzdA==";
  });
  const options = { temporaryDirectory, isCurrent: () => true, render };
  try {
    await expect(readNativeDraftFileThumbnail({ ...file, name: "../notes.pdf" }, options)).resolves.toBeUndefined();
    await expect(readNativeDraftFileThumbnail({ ...file, name: "notes.pdf.exe" }, options)).resolves.toBeUndefined();
    expect(render).not.toHaveBeenCalled();
    await expect(readNativeDraftFileThumbnail(file, options)).resolves.toMatch(/^data:image\/png;base64,/u);
    expect(render).toHaveBeenCalledOnce();
    expect(await readdir(temporaryDirectory)).toEqual([]);
  } finally { await rmdir(temporaryDirectory); }
});

it("releases the temporary copy and withholds a rendition after its window retires", async () => {
  const temporaryDirectory = await realpath(await mkdtemp(join(await realpath(tmpdir()), "joko-draft-preview-test-")));
  let current = true;
  try {
    await expect(readNativeDraftFileThumbnail({ name: "sheet.xlsx", bytes: Uint8Array.of(80, 75) }, {
      temporaryDirectory,
      isCurrent: () => current,
      render: async path => {
        expect(await readFile(path)).toEqual(Buffer.from([80, 75]));
        current = false;
        return "data:image/png;base64,dGVzdA==";
      }
    })).resolves.toBeUndefined();
    expect(await readdir(temporaryDirectory)).toEqual([]);
  } finally { await rmdir(temporaryDirectory); }
});
