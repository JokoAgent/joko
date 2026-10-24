import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import https from "node:https";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { LocalRuntimeError } from "./errors.js";
import {
  downloadOfficialAsset,
  installManagedRuntime,
  isAllowedDownloadUrl,
  DOWNLOAD_TIMEOUT_MS,
  MIN_RUNTIME_INSTALL_FREE_BYTES,
  readManagedRuntimeManifest,
  runtimeAssetName,
  runtimeInstallPreflight,
  runtimeRoot,
  selectOfficialAsset
} from "./installer.js";

function release(assetName: string, size = 12, version = "0.32.14") {
  return {
    tag_name: `v${version}`,
    assets: [{
      name: assetName,
      browser_download_url: `https://github.com/ollama/ollama/releases/download/v${version}/${assetName}`,
      digest: `sha256:${"ab".repeat(32)}`,
      size
    }]
  };
}

describe("official runtime installer", () => {
  it("maps supported platforms and accepts only the exact official asset", () => {
    expect(runtimeAssetName("darwin", "arm64")).toBe("ollama-darwin.tgz");
    expect(runtimeAssetName("win32", "x64")).toBe("ollama-windows-amd64.zip");
    expect(runtimeAssetName("linux", "arm64")).toBe("ollama-linux-arm64.tgz");
    expect(runtimeAssetName("freebsd", "x64")).toBeUndefined();
    expect(selectOfficialAsset(release("ollama-linux-amd64.tgz"), "linux", "x64")).toMatchObject({ version: "0.32.14", assetName: "ollama-linux-amd64.tgz" });
    expect(selectOfficialAsset({ ...release("ollama-linux-amd64.tgz"), tag_name: "nightly" }, "linux", "x64")).toBeUndefined();
  });

  it("accepts the verified Windows x64 release size and rejects unsafe numeric download budgets", () => {
    expect(selectOfficialAsset(release("ollama-windows-amd64.zip", 1_586_229_413, "0.40.10"), "win32", "x64"))
      .toMatchObject({ version: "0.40.10", assetName: "ollama-windows-amd64.zip", sizeBytes: 1_586_229_413 });
    for (const size of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(selectOfficialAsset(release("ollama-windows-amd64.zip", size), "win32", "x64")).toBeUndefined();
    }
  });

  it("blocks unofficial or ambiguous download URLs", () => {
    expect(isAllowedDownloadUrl("https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-darwin.tgz", "ollama-darwin.tgz")).toBe(true);
    expect(isAllowedDownloadUrl("https://github.com/other/repository/releases/download/v1.0.0/ollama-darwin.tgz", "ollama-darwin.tgz")).toBe(false);
    expect(isAllowedDownloadUrl("http://github.com/ollama/ollama/releases/download/v0.32.14/ollama-darwin.tgz", "ollama-darwin.tgz")).toBe(false);
    expect(isAllowedDownloadUrl("https://example.invalid/ollama-darwin.tgz", "ollama-darwin.tgz")).toBe(false);
  });

  it("preflights platform support and installation disk headroom", () => {
    expect(runtimeInstallPreflight({ platform: "linux", arch: "x64", freeDiskBytes: MIN_RUNTIME_INSTALL_FREE_BYTES })).toMatchObject({ allowed: true, disk: "sufficient" });
    expect(runtimeInstallPreflight({ platform: "linux", arch: "x64", freeDiskBytes: MIN_RUNTIME_INSTALL_FREE_BYTES - 1 })).toMatchObject({ allowed: false, publicErrorCode: "DISK_SPACE_LOW" });
    expect(runtimeInstallPreflight({ platform: "freebsd", arch: "x64" })).toMatchObject({ allowed: false, publicErrorCode: "UNSUPPORTED_PLATFORM" });
    const archiveSizeBytes = 1_586_229_413;
    const requiredDiskBytes = archiveSizeBytes + MIN_RUNTIME_INSTALL_FREE_BYTES;
    expect(runtimeInstallPreflight({ platform: "win32", arch: "x64", archiveSizeBytes, freeDiskBytes: requiredDiskBytes - 1 }))
      .toMatchObject({ allowed: false, requiredDiskBytes, publicErrorCode: "DISK_SPACE_LOW" });
    expect(runtimeInstallPreflight({ platform: "win32", arch: "x64", archiveSizeBytes, freeDiskBytes: requiredDiskBytes }))
      .toMatchObject({ allowed: true, requiredDiskBytes });
  });

  it("rechecks the resolved archive disk budget before downloading", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "joko-runtime-install-space-"));
    const asset = selectOfficialAsset(release("ollama-windows-amd64.zip", 1_586_229_413), "win32", "x64")!;
    const downloadAsset = vi.fn(async () => undefined);
    await expect(installManagedRuntime({ dataRoot, platform: "win32", arch: "x64", resolveAsset: async () => asset,
      readFreeDiskBytes: async () => asset.sizeBytes + MIN_RUNTIME_INSTALL_FREE_BYTES - 1, downloadAsset }))
      .rejects.toMatchObject({ code: "DISK_SPACE_LOW" });
    expect(downloadAsset).not.toHaveBeenCalled();
    await expect(readManagedRuntimeManifest(dataRoot)).resolves.toBeUndefined();
  });

  it("keeps a progressing download alive beyond a single inactivity window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const data = Buffer.from("verified-runtime");
      const digest = (await import("node:crypto")).createHash("sha256").update(data).digest("hex");
      const directory = await mkdtemp(join(tmpdir(), "joko-runtime-slow-download-"));
      const destination = join(directory, "runtime.tgz");
      let publishResponse!: (response: PassThrough) => void;
      const started = new Promise<PassThrough>((resolve) => { publishResponse = resolve; });
      const get = ((_url: unknown, _options: unknown, callback: (response: PassThrough & { statusCode: number; headers: object }) => void) => {
        const request = new EventEmitter() as EventEmitter & { destroy: () => void };
        request.destroy = vi.fn();
        queueMicrotask(() => {
          const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-length": String(data.length) } });
          callback(response);
          publishResponse(response);
        });
        return request;
      }) as unknown as typeof https.get;
      const download = downloadOfficialAsset({ asset: { version: "0.32.14", assetName: "ollama-darwin.tgz",
        url: "https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-darwin.tgz", sha256: digest, sizeBytes: data.length },
        destination, get });
      const response = await started;
      response.write(data.subarray(0, 5));
      await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS - 1_000);
      response.write(data.subarray(5, 10));
      await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS - 1_000);
      response.end(data.subarray(10));
      await download;
      await expect(readFile(destination)).resolves.toEqual(data);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["declared", "streamed"] as const)("rejects %s bytes beyond the exact verified asset size", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "joko-runtime-download-size-"));
    const destination = join(directory, "runtime.tgz");
    const get = ((_url: unknown, _options: unknown, callback: (response: PassThrough & { statusCode: number; headers: object }) => void) => {
      const request = new EventEmitter() as EventEmitter & { destroy: () => void };
      request.destroy = vi.fn();
      queueMicrotask(() => {
        const response = Object.assign(new PassThrough(), { statusCode: 200,
          headers: { "content-length": mode === "declared" ? "5" : "4" } });
        callback(response);
        response.end("12345");
      });
      return request;
    }) as unknown as typeof https.get;
    await expect(downloadOfficialAsset({ asset: { version: "0.32.14", assetName: "ollama-darwin.tgz",
      url: "https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-darwin.tgz", sha256: "ab".repeat(32), sizeBytes: 4 },
      destination, get })).rejects.toMatchObject({ code: "DOWNLOAD_TOO_LARGE" });
    await expect(access(destination)).rejects.toThrow();
  });

  it("streams a bounded asset and verifies SHA-256 before promotion", async () => {
    const data = Buffer.from("verified-runtime");
    const digest = (await import("node:crypto")).createHash("sha256").update(data).digest("hex");
    const directory = await mkdtemp(join(tmpdir(), "joko-runtime-download-"));
    const destination = join(directory, "runtime.tgz");
    const get = ((_url: string | URL, _options: unknown, callback: (response: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
      const request = new EventEmitter() as EventEmitter & { destroy: () => void };
      request.destroy = vi.fn();
      queueMicrotask(() => {
        const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
        response.statusCode = 200;
        response.headers = { "content-length": String(data.byteLength) };
        callback(response);
        response.end(data);
      });
      return request;
    }) as unknown as typeof https.get;
    await downloadOfficialAsset({
      asset: {
        version: "0.32.14",
        assetName: "ollama-darwin.tgz",
        url: "https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-darwin.tgz",
        sha256: digest,
        sizeBytes: data.byteLength
      },
      destination,
      get
    });
    await expect(readFile(destination)).resolves.toEqual(data);
  });

  it("removes an unverified partial instead of promoting it", async () => {
    const data = Buffer.from("wrong-runtime");
    const directory = await mkdtemp(join(tmpdir(), "joko-runtime-checksum-"));
    const destination = join(directory, "runtime.tgz");
    const get = ((_url: string | URL, _options: unknown, callback: (response: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
      const request = new EventEmitter() as EventEmitter & { destroy: () => void };
      request.destroy = vi.fn();
      queueMicrotask(() => {
        const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
        response.statusCode = 200;
        response.headers = { "content-length": String(data.byteLength) };
        callback(response);
        response.end(data);
      });
      return request;
    }) as unknown as typeof https.get;
    await expect(downloadOfficialAsset({
      asset: {
        version: "0.32.14",
        assetName: "ollama-darwin.tgz",
        url: "https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-darwin.tgz",
        sha256: "00".repeat(32),
        sizeBytes: data.byteLength
      },
      destination,
      get
    })).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    await expect(access(destination)).rejects.toThrow();
  });

  it("extracts into staging and atomically promotes a relative manifest", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "joko-runtime-install-"));
    const installed = await installManagedRuntime({
      dataRoot,
      platform: "linux",
      arch: "x64",
      resolveAsset: async () => ({
        version: "0.32.14",
        assetName: "ollama-linux-amd64.tgz",
        url: "https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-linux-amd64.tgz",
        sha256: "ab".repeat(32),
        sizeBytes: 12
      }),
      downloadAsset: async ({ destination }) => {
        await mkdir(join(destination, ".."), { recursive: true });
        await writeFile(destination, "archive");
      },
      extractArchive: async ({ destination }) => {
        const executable = join(destination, "bin", "ollama");
        await mkdir(join(destination, "bin"), { recursive: true });
        await writeFile(executable, "binary");
        return executable;
      }
    });
    const manifest = await readManagedRuntimeManifest(dataRoot);
    expect(manifest).toMatchObject({ format: 1, version: "0.32.14", archiveSha256: "ab".repeat(32) });
    expect(manifest?.binaryRelativePath.startsWith("v0.32.14")).toBe(true);
    expect(installed.archiveSha256).toBe("ab".repeat(32));
    expect(relative(runtimeRoot(dataRoot), installed.binary).startsWith("v0.32.14")).toBe(true);
    await expect(readFile(installed.binary, "utf8")).resolves.toBe("binary");
  });

  it("never promotes an aborted or failed extraction", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "joko-runtime-failed-install-"));
    await expect(installManagedRuntime({
      dataRoot,
      platform: "linux",
      arch: "x64",
      resolveAsset: async () => ({
        version: "0.32.14",
        assetName: "ollama-linux-amd64.tgz",
        url: "https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-linux-amd64.tgz",
        sha256: "ab".repeat(32),
        sizeBytes: 12
      }),
      downloadAsset: async ({ destination }) => writeFile(destination, "archive"),
      extractArchive: async ({ destination }) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "partial"), "partial");
        throw new LocalRuntimeError("OPERATION_CANCELLED", "The operation was cancelled.");
      }
    })).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    await expect(readManagedRuntimeManifest(dataRoot)).resolves.toBeUndefined();
    await expect(access(join(runtimeRoot(dataRoot), "v0.32.14"))).rejects.toThrow();
  });
});
