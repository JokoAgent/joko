import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractLlamaCppArchive } from "./llama-cpp-process.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
interface Entry { name: string; type?: "0" | "1" | "2" | "5"; target?: string; content?: string }
function archive(entries: readonly Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.content ?? ""), header = Buffer.alloc(512);
    const text = (value: string, offset: number, size: number) => header.write(value, offset, size, "utf8");
    const octal = (value: number, offset: number, size: number) => text(value.toString(8).padStart(size - 1, "0") + "\0", offset, size);
    text(entry.name, 0, 100); octal(0o755, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(bytes.length, 124, 12); octal(0, 136, 12); header.fill(32, 148, 156);
    text(entry.type ?? "0", 156, 1); text(entry.target ?? "", 157, 100); text("ustar\0", 257, 6); text("00", 263, 2);
    const sum = header.reduce((total, byte) => total + byte, 0); text(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
async function unpack(entries: readonly Entry[]) {
  const root = await mkdtemp(join(tmpdir(), "joko-gguf-archive-")); roots.push(root);
  const archivePath = join(root, "runtime.tar.gz"); await writeFile(archivePath, archive(entries));
  return { root, destination: join(root, "extracted"), archivePath, platform: process.platform, signal: new AbortController().signal };
}

describe("official GGUF runtime archive links", () => {
  it.skipIf(process.platform === "win32")("preserves contained versioned libraries and hard links in the real extracted tree", async () => {
    const input = await unpack([
      { name: "bundle/", type: "5" }, { name: "bundle/llama-server", content: "fixture executable" },
      { name: "bundle/libllama.so.0.7.0", content: "fixture library" },
      { name: "bundle/libllama.so.0", type: "2", target: "libllama.so.0.7.0" },
      { name: "bundle/libllama.so", type: "2", target: "libllama.so.0" },
      { name: "bundle/libcopy.so", type: "1", target: "bundle/libllama.so.0.7.0" }
    ]);
    expect(await extractLlamaCppArchive(input)).toBe(join(input.destination, "bundle", "llama-server"));
    expect(await readFile(join(input.destination, "bundle", "libllama.so"), "utf8")).toBe("fixture library");
    expect(await readFile(join(input.destination, "bundle", "libcopy.so"), "utf8")).toBe("fixture library");
  });

  it.each([
    [{ name: "bundle/link", type: "2", target: "../../outside" }],
    [{ name: "bundle/link", type: "1", target: "../outside" }],
    [{ name: "bundle/a", type: "2", target: "b" }, { name: "bundle/b", type: "2", target: "a" }],
    [{ name: "bundle/link", type: "2", target: "missing" }],
    [{ name: "bundle/link", type: "2", target: "library" }, { name: "bundle/link/child", content: "unsafe traversal" }],
    [{ name: "bundle/library", type: "2", target: "library" }]
  ] satisfies Entry[][])("rejects an unsafe link graph before extracting any payload (%j)", async (...entries) => {
    const input = await unpack([{ name: "bundle/llama-server", content: "executable" }, { name: "bundle/library", content: "library" }, ...entries]);
    await expect(extractLlamaCppArchive(input)).rejects.toMatchObject({ code: "ARCHIVE_REJECTED" });
    await expect(readFile(join(input.destination, "bundle", "llama-server"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects nonportable drive and alternate-stream paths before extraction", async () => {
    const input = await unpack([{ name: "bundle/llama-server", content: "executable" }, { name: "./C:/outside", content: "unsafe" }]);
    await expect(extractLlamaCppArchive(input)).rejects.toMatchObject({ code: "ARCHIVE_REJECTED" });
  });

  it.skipIf(process.platform !== "win32")("rejects case aliases that traverse a linked directory on Windows", async () => {
    const input = await unpack([{ name: "bundle/llama-server.exe", content: "executable" }, { name: "bundle/library", content: "library" },
      { name: "bundle/link", type: "2", target: "library" }, { name: "bundle/LINK/child", content: "unsafe" }]);
    await expect(extractLlamaCppArchive(input)).rejects.toMatchObject({ code: "ARCHIVE_REJECTED" });
  });
});
