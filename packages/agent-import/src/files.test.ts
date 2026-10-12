import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createImportBudget, MAX_FILE_BYTES, optionalText, readImportFile, readImportTree } from "./files.js";

const temporaryBase = resolve(tmpdir()); const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(temporaryBase, "joko-agent-import-")); roots.push(root); return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || dirname(root) !== temporaryBase || !basename(root).startsWith("joko-agent-import-")) {
      throw new Error("Import test cleanup target is outside its allocated temporary root.");
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("source file reads", () => {
  it("keeps complete original bytes, empty markers and nested hidden documents within one budget", async () => {
    const root = await fixture(); await mkdir(join(root, "memory", ".archive"), { recursive: true });
    const document = Buffer.from("---\ntitle: Notes\n---\n\n  Retain whitespace.\n日本語\n", "utf8");
    const asset = Buffer.from([0, 255, 1, 128, 10]);
    await writeFile(join(root, "memory", ".archive", "notes.md"), document);
    await writeFile(join(root, "memory", "original.bin"), asset); await writeFile(join(root, "memory", "marker"), "");
    const files = await readImportTree(root, () => true, createImportBudget(4096));
    expect(files.map(file => file.name)).toEqual(["memory/.archive/notes.md", "memory/marker", "memory/original.bin"]);
    expect(files[0]!.bytes).toEqual(document); expect(files[1]!.bytes.length).toBe(0); expect(files[2]!.bytes).toEqual(asset);
    await expect(optionalText(root, join(root, "absent"), createImportBudget(4096))).resolves.toBeUndefined();
  });
  it("rejects a foreign file and special entries before opening or allocating their content", async () => {
    const root = await fixture(); const foreign = await fixture(); await writeFile(join(foreign, "private"), "outside content");
    await expect(readImportFile(root, join(foreign, "private"), createImportBudget(4096))).rejects.toMatchObject({ code: "SOURCE_LINK_OUTSIDE_FOLDER" });
    await expect(readImportFile(root, join(foreign, "private"), createImportBudget(4096), [foreign])).rejects.toMatchObject({ code: "SOURCE_LINK_OUTSIDE_FOLDER" });
    await mkdir(join(root, "directory"));
    await expect(readImportFile(root, join(root, "directory"), createImportBudget(4096))).rejects.toMatchObject({ code: "SOURCE_NOT_REGULAR_FILE" });
  });
  it("fails the whole capture on its shared budget and rejects an oversized file without returning a prefix", async () => {
    const root = await fixture(); await writeFile(join(root, "small"), "small original");
    await expect(readImportTree(root, () => true, createImportBudget(128), () => undefined)).rejects.toMatchObject({ code: "SOURCE_SNAPSHOT_TOO_LARGE" });
    await writeFile(join(root, "large"), Buffer.alloc(MAX_FILE_BYTES + 1));
    await expect(readImportFile(root, join(root, "large"), createImportBudget())).rejects.toMatchObject({ code: "SOURCE_FILE_TOO_LARGE" });
  });
});
