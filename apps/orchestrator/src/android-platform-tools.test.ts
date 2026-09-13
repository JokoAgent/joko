import { mkdir, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV,
  encodeManagedOutboundProxySnapshot
} from "@joko/contracts/managed-outbound-proxy";

import {
  ManagedAndroidAdbPreparer,
  androidPlatformToolsTarget,
  managedAndroidAdbPreparationSupported,
  resolveAndroidArchiveProxy
} from "./android-platform-tools.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("ManagedAndroidAdbPreparer", () => {
  it("downloads, validates, and promotes one official platform-tools layout", async () => {
    const root = temporaryRoot();
    const downloadArchive = vi.fn(async ({ destination }: { readonly destination: string }) => {
      await writeFile(destination, "bounded archive");
    });
    const extractArchive = vi.fn(async ({ destination }: { readonly destination: string }) => {
      const tools = join(destination, "platform-tools");
      await mkdir(tools, { recursive: true });
      await writeFile(join(tools, "adb.exe"), "executable");
      await writeFile(join(tools, "AdbWinApi.dll"), "library");
    });
    const preparer = new ManagedAndroidAdbPreparer({
      dataDirectory: root,
      platform: "win32",
      architecture: "x64",
      downloadArchive,
      extractArchive
    });

    const result = await preparer.prepare();

    expect(result.executablePath).toBe(join(root, "android", "platform-tools", "adb.exe"));
    expect(await readFile(result.executablePath, "utf8")).toBe("executable");
    expect(downloadArchive).toHaveBeenCalledTimes(1);
    expect(extractArchive).toHaveBeenCalledTimes(1);
  });

  it("replaces a nonempty prepared executable after its runtime probe failed", async () => {
    const root = temporaryRoot();
    const executable = join(root, "android", "platform-tools", "adb");
    await mkdir(join(root, "android", "platform-tools"), { recursive: true });
    await writeFile(executable, "damaged executable");
    const downloadArchive = vi.fn(async ({ destination }: { readonly destination: string }) => {
      await writeFile(destination, "bounded archive");
    });
    const extractArchive = vi.fn(async ({ destination }: { readonly destination: string }) => {
      const tools = join(destination, "platform-tools");
      await mkdir(tools, { recursive: true });
      await writeFile(join(tools, "adb"), "repaired executable");
    });
    const preparer = new ManagedAndroidAdbPreparer({
      dataDirectory: root,
      platform: "linux",
      architecture: "x64",
      downloadArchive,
      extractArchive
    });

    await expect(preparer.prepare()).resolves.toEqual({ executablePath: executable });
    expect(await readFile(executable, "utf8")).toBe("repaired executable");
    expect(downloadArchive).toHaveBeenCalledTimes(1);
    expect(extractArchive).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent preparation and never promotes a missing executable", async () => {
    const root = temporaryRoot();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const downloadArchive = vi.fn(async ({ destination }: { readonly destination: string }) => {
      await gate;
      await writeFile(destination, "bounded archive");
    });
    const extractArchive = vi.fn(async ({ destination }: { readonly destination: string }) => {
      await mkdir(join(destination, "platform-tools"), { recursive: true });
    });
    const preparer = new ManagedAndroidAdbPreparer({
      dataDirectory: root,
      platform: "darwin",
      architecture: "arm64",
      downloadArchive,
      extractArchive
    });

    const first = preparer.prepare();
    const second = preparer.prepare();
    release?.();

    await expect(Promise.all([first, second])).rejects.toThrow("usable ADB executable");
    expect(downloadArchive).toHaveBeenCalledTimes(1);
    expect(extractArchive).toHaveBeenCalledTimes(1);
  });

  it("fails closed on platforms without an official archive", async () => {
    const root = temporaryRoot();
    const preparer = new ManagedAndroidAdbPreparer({
      dataDirectory: root,
      platform: "aix"
    });

    await expect(preparer.prepare()).rejects.toThrow("unavailable on this platform");
  });

  it("advertises automatic preparation only for published platform and architecture pairs", () => {
    expect(androidPlatformToolsTarget("linux", "X64")).toBe("linux-x64");
    expect(managedAndroidAdbPreparationSupported("darwin", "x64")).toBe(true);
    expect(managedAndroidAdbPreparationSupported("darwin", "arm64")).toBe(true);
    expect(managedAndroidAdbPreparationSupported("linux", "x64")).toBe(true);
    expect(managedAndroidAdbPreparationSupported("win32", "x64")).toBe(true);
    expect(managedAndroidAdbPreparationSupported("linux", "arm64")).toBe(false);
    expect(managedAndroidAdbPreparationSupported("win32", "arm64")).toBe(false);
    expect(managedAndroidAdbPreparationSupported("aix", "x64")).toBe(false);
  });

  it("selects validated application proxies with HTTPS precedence and NO_PROXY bypass", () => {
    const target = new URL("https://dl.google.com/android/repository/platform-tools-latest-linux.zip");
    expect(resolveAndroidArchiveProxy(target, {
      HTTPS_PROXY: "http://secure-proxy.example:8443",
      HTTP_PROXY: "http://fallback-proxy.example:8080"
    })).toBe("http://secure-proxy.example:8443/");
    expect(resolveAndroidArchiveProxy(target, {
      HTTPS_PROXY: "http://secure-proxy.example:8443",
      NO_PROXY: ".google.com"
    })).toBeUndefined();
    expect(resolveAndroidArchiveProxy(target, {
      HTTPS_PROXY: "file:///not-a-proxy"
    })).toBeUndefined();
    expect(resolveAndroidArchiveProxy(target, {
      ALL_PROXY: "socks5h://person:secret@proxy.example:1080"
    })).toBe("socks5h://person:secret@proxy.example:1080");
    expect(resolveAndroidArchiveProxy(target, {
      HTTPS_PROXY: "socks5://person:secret@proxy.example:1080"
    })).toBe("socks5://person:secret@proxy.example:1080");
    expect(resolveAndroidArchiveProxy(target, {
      HTTP_PROXY: "http://http-only.example:8080"
    })).toBeUndefined();
  });

  it("uses the fixed system/PAC snapshot only when explicit proxy environment is absent", () => {
    const target = new URL("https://dl.google.com/android/repository/platform-tools-latest-linux.zip");
    const snapshot = encodeManagedOutboundProxySnapshot({
      "android-platform-tools-linux": "socks5://system-proxy.example:1080"
    });
    expect(resolveAndroidArchiveProxy(target, {
      [MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV]: snapshot
    })).toBe("socks5://system-proxy.example:1080");
    expect(resolveAndroidArchiveProxy(target, {
      HTTPS_PROXY: "http://application-proxy.example:8080",
      [MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV]: snapshot
    })).toBe("http://application-proxy.example:8080/");
  });

  it("does not expose authenticated proxy URLs when the transport fails", async () => {
    const root = temporaryRoot();
    const preparer = new ManagedAndroidAdbPreparer({
      dataDirectory: root,
      platform: "linux",
      architecture: "x64",
      environment: {
        HTTPS_PROXY: "http://person:proxy-secret@127.0.0.1:1"
      }
    });

    let failure: unknown;
    try {
      await preparer.prepare(AbortSignal.timeout(2_000));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("proxy-secret");
    expect(String(failure)).toMatch(/could not be downloaded|cancelled/iu);
  });

  it("does not expose authenticated SOCKS5 URLs when the transport fails", async () => {
    const root = temporaryRoot();
    const preparer = new ManagedAndroidAdbPreparer({
      dataDirectory: root,
      platform: "linux",
      architecture: "x64",
      environment: {
        HTTPS_PROXY: "socks5://person:socks-secret@127.0.0.1:1"
      }
    });

    const failure = await preparer.prepare(AbortSignal.timeout(2_000)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("person");
    expect(String(failure)).not.toContain("socks-secret");
    expect(String(failure)).toMatch(/could not be downloaded|cancelled/iu);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "joko-platform-tools-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
