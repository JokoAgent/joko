import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AndroidAdbAdapter } from "./adb-adapter.js";
import {
  AndroidAdbResolver,
  buildAndroidAdbCandidates,
  type AndroidAdbCandidate
} from "./resolver.js";

describe("Android ADB candidate resolution", () => {
  it("orders bundled, prepared, SDK, and PATH after strict overrides", () => {
    const home = "D:\\people\\tester";
    const local = "D:\\local";
    const bundled = "D:\\app\\tools\\adb.exe";
    const prepared = "D:\\data\\tools\\adb.exe";
    const sdk = join(local, "Android", "Sdk", "platform-tools", "adb.exe");
    const existing = new Set([bundled, prepared, sdk]);
    const candidates = buildAndroidAdbCandidates({
      platform: "win32",
      environment: { LOCALAPPDATA: local },
      homeDirectory: home,
      bundledPaths: [bundled],
      preparedPath: prepared,
      pathExists: (path) => existing.has(path)
    });

    expect(candidates.map(({ executablePath, pathSource, strict }) => ({ executablePath, pathSource, strict })))
      .toEqual([
        { executablePath: bundled, pathSource: "bundled", strict: false },
        { executablePath: prepared, pathSource: "prepared", strict: false },
        { executablePath: sdk, pathSource: "sdk", strict: false },
        { executablePath: "adb.exe", pathSource: "fallback", strict: false }
      ]);

    expect(buildAndroidAdbCandidates({
      platform: "win32",
      environment: { JOKO_ANDROID_ADB_PATH: "D:\\environment\\adb.exe" },
      homeDirectory: home,
      customPath: "D:\\custom\\adb.exe",
      bundledPaths: [bundled],
      preparedPath: prepared,
      pathExists: () => true
    })).toEqual([{
      executablePath: "D:\\custom\\adb.exe",
      pathSource: "custom",
      strict: true
    }]);

    expect(buildAndroidAdbCandidates({
      platform: "win32",
      environment: { JOKO_ANDROID_ADB_PATH: "D:\\environment\\adb.exe" },
      homeDirectory: home,
      bundledPaths: [bundled],
      preparedPath: prepared,
      pathExists: () => true
    })).toEqual([{
      executablePath: "D:\\environment\\adb.exe",
      pathSource: "environment",
      strict: true
    }]);
  });

  it("checks standard Android SDK environment roots before default SDK locations", () => {
    const sdkRoot = "D:\\android-sdk-root";
    const androidHome = "D:\\android-home";
    const local = "D:\\local";
    const rootAdb = join(sdkRoot, "platform-tools", "adb.exe");
    const homeAdb = join(androidHome, "platform-tools", "adb.exe");
    const defaultAdb = join(local, "Android", "Sdk", "platform-tools", "adb.exe");
    const existing = new Set([rootAdb, homeAdb, defaultAdb]);

    expect(buildAndroidAdbCandidates({
      platform: "win32",
      environment: {
        ANDROID_SDK_ROOT: sdkRoot,
        ANDROID_HOME: androidHome,
        LOCALAPPDATA: local
      },
      homeDirectory: "D:\\people\\tester",
      pathExists: (path) => existing.has(path)
    })).toEqual([
      { executablePath: rootAdb, pathSource: "sdk", strict: false },
      { executablePath: homeAdb, pathSource: "sdk", strict: false },
      { executablePath: defaultAdb, pathSource: "sdk", strict: false },
      { executablePath: "adb.exe", pathSource: "fallback", strict: false }
    ]);
  });

  it("probes non-strict candidates in order and caches the first runnable adapter", async () => {
    const probes: string[] = [];
    const factory = vi.fn((candidate: AndroidAdbCandidate) => adapter({
      probe: async () => {
        probes.push(candidate.executablePath);
        if (candidate.pathSource !== "prepared") throw new Error("not runnable");
        return "ADB 35";
      }
    }));
    const resolver = new AndroidAdbResolver({
      platform: "linux",
      environment: {},
      homeDirectory: "/home/tester",
      bundledPaths: ["/app/adb"],
      preparedPath: "/data/adb",
      pathExists: () => true,
      adapterFactory: factory
    });

    await expect(resolver.resolve()).resolves.toMatchObject({
      executablePath: "/data/adb",
      pathSource: "prepared",
      version: "ADB 35"
    });
    await resolver.resolve();

    expect(probes).toEqual(["/app/adb", "/data/adb"]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("never falls back or auto-prepares after a strict custom or environment path fails", async () => {
    const prepare = vi.fn(async () => ({ executablePath: "/prepared/adb" }));
    const resolver = new AndroidAdbResolver({
      platform: "linux",
      environment: { JOKO_ANDROID_ADB_PATH: "/strict/adb" },
      homeDirectory: "/home/tester",
      bundledPaths: ["/app/adb"],
      pathExists: () => true,
      adapterFactory: () => adapter({ probe: async () => { throw new Error("strict failure"); } }),
      preparer: { prepare }
    });

    await expect(resolver.resolve()).rejects.toMatchObject({ code: "adb_not_found" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("automatically prepares and probes a private copy after ordinary candidates fail", async () => {
    const prepare = vi.fn(async () => ({ executablePath: "/private/tools/adb" }));
    const factory = vi.fn((candidate: AndroidAdbCandidate) => adapter({
      probe: async () => {
        if (candidate.pathSource === "prepared") return "ADB 36";
        throw new Error("missing");
      }
    }));
    const resolver = new AndroidAdbResolver({
      platform: "linux",
      environment: {},
      homeDirectory: "/home/tester",
      pathExists: () => false,
      adapterFactory: factory,
      preparer: { prepare },
      redactRoots: ["/private"]
    });

    await expect(resolver.resolve()).resolves.toMatchObject({
      executablePath: "/private/tools/adb",
      pathSource: "prepared",
      version: "ADB 36"
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(resolver.preparationState()).toEqual({
      supported: true,
      attempted: true,
      ready: true,
      executablePath: "[PATH]/tools/adb"
    });
  });

  it("discovers an atomically promoted prepared binary after invalidation without preparing twice", async () => {
    const preparedPath = "/private/tools/adb";
    let promoted = false;
    const prepare = vi.fn(async () => {
      promoted = true;
      return { executablePath: preparedPath };
    });
    const resolver = new AndroidAdbResolver({
      platform: "linux",
      environment: {},
      homeDirectory: "/home/tester",
      preparedPath,
      pathExists: (path) => path === preparedPath && promoted,
      adapterFactory: (candidate) => adapter({
        probe: async () => {
          if (candidate.pathSource === "prepared") return "ADB 36";
          throw new Error("missing");
        }
      }),
      preparer: { prepare }
    });

    await expect(resolver.resolve()).resolves.toMatchObject({ pathSource: "prepared" });
    resolver.invalidate();
    await expect(resolver.resolve()).resolves.toMatchObject({ pathSource: "prepared" });

    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("can perform a fresh candidate-only probe without invoking the preparer", async () => {
    const prepare = vi.fn(async () => ({ executablePath: "/private/tools/adb" }));
    const resolver = new AndroidAdbResolver({
      platform: "linux",
      environment: {},
      homeDirectory: "/home/tester",
      pathExists: () => false,
      adapterFactory: () => adapter({ probe: async () => { throw new Error("missing"); } }),
      preparer: { prepare }
    });

    await expect(resolver.resolve(undefined, { allowPreparation: false }))
      .rejects.toMatchObject({ code: "adb_not_found" });
    expect(prepare).not.toHaveBeenCalled();
    expect(resolver.preparationState()).toMatchObject({ attempted: false, ready: false });
  });

  it("deduplicates concurrent resolution and supports explicit invalidation", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const probe = vi.fn(async () => {
      await gate;
      return "ADB 35";
    });
    const resolver = new AndroidAdbResolver({
      platform: "linux",
      environment: {},
      homeDirectory: "/home/tester",
      pathExists: () => false,
      adapterFactory: () => adapter({ probe })
    });

    const first = resolver.resolve();
    const second = resolver.resolve();
    release?.();
    await Promise.all([first, second]);
    expect(probe).toHaveBeenCalledTimes(1);

    resolver.invalidate();
    await resolver.resolve();
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

function adapter(overrides: Partial<AndroidAdbAdapter> = {}): AndroidAdbAdapter {
  return {
    probe: async () => "ADB",
    listDevices: async () => [],
    startServer: async () => undefined,
    killServer: async () => undefined,
    connect: async (endpoint) => ({ endpoint, output: "" }),
    disconnect: async (endpoint) => ({ endpoint, output: "" }),
    snapshot: async () => { throw new Error("unused"); },
    tap: async () => undefined,
    swipe: async () => undefined,
    inputText: async () => undefined,
    pressKey: async () => 0,
    launchApp: async () => "",
    installArtifact: async () => "",
    ...overrides
  };
}
