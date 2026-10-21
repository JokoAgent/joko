import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalRuntimeError } from "./errors.js";
import { allowedDownloadUrl, downloadLlamaCppAsset, llamaCppPlatform, pickLlamaCppRelease, resolveHfRepository, resolveLlamaCppRelease, selectGgufShards } from "./llama-cpp-downloads.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
async function destination() { const root = await mkdtemp(join(tmpdir(), "joko-gguf-download-")); roots.push(root); return join(root, "weights.gguf"); }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const signal = () => new AbortController().signal;
const asset = (value = "abcdefgh") => ({ url: "https://huggingface.co/a/model/resolve/" + "a".repeat(40) + "/weights.gguf", size: value.length, sha256: digest(value) });

describe("verified GGUF assets", () => {
  it("cancels rejected HTTP bodies so the streaming proxy can retire its dispatcher", async () => {
    for (const operation of ["release", "repository", "asset"]) {
      const cancelled = vi.fn(), fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), { status: 404 }));
      const flight = operation === "release" ? resolveLlamaCppRelease(signal(), fetcher, "win32", "x64") : operation === "repository" ? resolveHfRepository("a/model", signal(), fetcher) : downloadLlamaCppAsset(asset(), await destination(), "hf", signal(), () => undefined, false, fetcher);
      await expect(flight).rejects.toThrow(); expect(cancelled).toHaveBeenCalledTimes(1);
    }
  });
  it("selects only exact official CPU/macOS/Ubuntu assets with published digest on all six platforms", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) for (const arch of ["x64", "arm64"]) {
      const name = `llama-b7000-bin-${llamaCppPlatform(platform, arch)}`, url = `https://github.com/ggml-org/llama.cpp/releases/download/b7000/${name}`;
      const release = [{ tag_name: "b7000", assets: [{ name: name.replace("win-cpu", "win-cuda"), browser_download_url: url, size: 8, digest: "sha256:" + digest("abcdefgh") }, { name, browser_download_url: url, size: 8, digest: "sha256:" + digest("abcdefgh") }] }];
      expect(pickLlamaCppRelease(release, platform, arch)).toMatchObject({ name, size: 8, version: "b7000" });
      expect(() => pickLlamaCppRelease([{ ...release[0], assets: [{ name, browser_download_url: url, size: 8 }] }], platform, arch)).toThrow("RELEASE_UNAVAILABLE");
    }
    expect(llamaCppPlatform("freebsd", "x64")).toBeNull(); expect(llamaCppPlatform("linux", "ia32")).toBeNull();
    expect(allowedDownloadUrl("https://github.com/another/repo/releases/download/b7/llama.zip", "github")).toBe(false);
    expect(allowedDownloadUrl("https://user:secret@huggingface.co/weights", "hf")).toBe(false);
  });
  it("pins immutable LFS metadata, requires every shard and refuses API redirect outside the repository API", async () => {
    const files = [{ rfilename: "Q4-00001-of-00002.gguf", lfs: { size: 4, sha256: digest("abcd") } }, { rfilename: "Q4-00002-of-00002.gguf", lfs: { size: 4, sha256: digest("efgh") } }, { rfilename: "mmproj-Q4.gguf", lfs: { size: 3, sha256: digest("xxx") } }, { rfilename: "other.gguf", size: 3 }];
    const result = await resolveHfRepository("a/model", signal(), vi.fn(async () => Response.json({ sha: "a".repeat(40), siblings: files })));
    expect(result.files).toHaveLength(2); expect(selectGgufShards(result.files, result.files[0]!.name)).toHaveLength(2);
    expect(() => selectGgufShards(result.files.slice(0, 1), result.files[0]!.name)).toThrow("MODEL_INCOMPLETE");
    expect(() => selectGgufShards([{ name: "a-00001-of-00257.gguf", sizeBytes: 4, sha256: digest("abcd") }], "a-00001-of-00257.gguf")).toThrow("INVALID_MODEL");
    await expect(resolveHfRepository("a/model", signal(), vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/api/models/a/model" } })))).rejects.toThrow("DOWNLOAD_BLOCKED");
    await expect(resolveHfRepository("a/model", signal(), vi.fn(async () => Response.json({ sha: "main", siblings: files })))).rejects.toThrow("MODEL_NOT_FOUND");
  });
  it("rehashes a paused prefix and validates exact Range; ignored Range replaces instead of appending", async () => {
    for (const status of [206, 200]) {
      const file = await destination(); await writeFile(`${file}.partial`, "abcd");
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toEqual({ Range: "bytes=4-" });
        return new Response(status === 206 ? "efgh" : "abcdefgh", { status, ...(status === 206 ? { headers: { "content-range": "bytes 4-7/8" } } : {}) });
      });
      await downloadLlamaCppAsset(asset(), file, "hf", signal(), () => undefined, true, fetcher);
      expect(await readFile(file, "utf8")).toBe("abcdefgh"); expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const file = await destination(); await writeFile(`${file}.partial`, "abcd");
    await expect(downloadLlamaCppAsset(asset(), file, "hf", signal(), () => undefined, true, vi.fn(async () => new Response("efgh", { status: 206, headers: { "content-range": "bytes 3-7/8" } })))).rejects.toThrow("DOWNLOAD_FAILED");
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects oversized or corrupt streamed bytes and validates every redirect before request", async () => {
    for (const value of ["abcdefghi", "abcdxxxx"]) {
      const file = await destination(); await expect(downloadLlamaCppAsset(asset(), file, "hf", signal(), () => undefined, false, vi.fn(async () => new Response(value)))).rejects.toThrow(/DOWNLOAD_(SIZE|CHECKSUM)/u);
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" }); await expect(readFile(`${file}.partial`)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://huggingface.co/weights" } }));
    await expect(downloadLlamaCppAsset(asset(), await destination(), "hf", signal(), () => undefined, false, fetcher)).rejects.toThrow("DOWNLOAD_BLOCKED"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects with the original retired-owner error from progress and removes unverified bytes", async () => {
    const file = await destination(), retired = new LocalRuntimeError("OWNER_CHANGED", "The runtime owner changed during the operation.");
    const fetcher = vi.fn(async () => new Response("abcdefgh"));
    await expect(downloadLlamaCppAsset(asset(), file, "hf", signal(), () => { throw retired; }, false, fetcher)).rejects.toBe(retired);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${file}.partial`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps the winning idle timeout instead of reporting cancellation", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true }); } })));
    await expect(downloadLlamaCppAsset(asset(), await destination(), "hf", signal(), () => undefined, false, fetcher, 25)).rejects.toThrow("DOWNLOAD_TIMEOUT");
  });
});
