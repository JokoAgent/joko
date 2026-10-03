import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlatformSystemFrontmostInput }
  from "./dedicated-hardware-action/system-frontmost-input.js";
import { loadNativeSystemFrontmostInput } from "./native-system-frontmost-input.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function artifact(overrides: Record<string, unknown> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), "joko-native-frontmost-"));
  directories.push(directory);
  const bytes = Buffer.from("native input test artifact");
  writeFileSync(join(directory, "joko-windows-frontmost-input.node"), bytes);
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({
    architecture: "x64", helper: "joko-windows-frontmost-input.node", platform: "win32", protocolVersion: 1,
    sha256: createHash("sha256").update(bytes).digest("hex"), ...overrides
  }));
  return directory;
}

describe("native foreground sampler admission", () => {
  it("loads once without sampling and synchronously captures the physical activation target", async () => {
    let foreground = "123";
    const captureTarget = vi.fn(() => ({ nativeId: foreground, processId: 999 }));
    const native = nativeExports(captureTarget);
    const loadNative = vi.fn(() => native);
    const windowsHelper = loadNativeSystemFrontmostInput({
      directory: artifact(), platform: "win32", architecture: "x64", loadNative
    });
    expect(windowsHelper).toBeDefined();
    expect(Object.isFrozen(windowsHelper)).toBe(true);
    expect(captureTarget).not.toHaveBeenCalled();
    const platform = createPlatformSystemFrontmostInput({ platform: "win32", windowsHelper: windowsHelper! });
    if (platform.status !== "available") throw new Error("Expected admitted native capture.");
    const target = platform.runner.captureTarget();
    foreground = "456";
    await platform.runner.postReturn(target);
    await platform.runner.postScroll(target, 120);
    await platform.runner.postPaste(target);
    expect(captureTarget).toHaveBeenCalledOnce();
    expect(loadNative).toHaveBeenCalledOnce();
    expect(native.postReturn).toHaveBeenCalledExactlyOnceWith("123", 999);
    expect(native.postScroll).toHaveBeenCalledExactlyOnceWith("123", 999, 120);
    expect(native.postPaste).toHaveBeenCalledExactlyOnceWith("123", 999);
  });

  it.each([
    { platform: "linux" }, { architecture: "arm64" }, { protocolVersion: 2 },
    { helper: "../other.node" }, { sha256: "0".repeat(64) }, { extra: true }
  ])("rejects a different or corrupt artifact before native loading: %j", (overrides) => {
    const loadNative = vi.fn();
    expect(loadNativeSystemFrontmostInput({
      directory: artifact(overrides), platform: "win32", architecture: "x64", loadNative
    })).toBeUndefined();
    expect(loadNative).not.toHaveBeenCalled();
  });

  it("fails closed for missing, extra, unloadable and incompatible native inputs", () => {
    const directory = artifact();
    const options = { directory, platform: "win32" as const, architecture: "x64" };
    expect(loadNativeSystemFrontmostInput({ ...options, loadNative: () => { throw new Error("native unavailable"); } }))
      .toBeUndefined();
    for (const native of [{}, { ...nativeExports(() => undefined), protocolVersion: 2 },
      { ...nativeExports(() => undefined), extra: true },
      { ...nativeExports(() => undefined), postPaste: undefined },
      { protocolVersion: 1, captureTarget: () => undefined }]) {
      expect(loadNativeSystemFrontmostInput({ ...options, loadNative: () => native })).toBeUndefined();
    }
    writeFileSync(join(directory, "unexpected.node"), "extra");
    const loadNative = vi.fn();
    expect(loadNativeSystemFrontmostInput({ ...options, loadNative })).toBeUndefined();
    expect(loadNative).not.toHaveBeenCalled();
    expect(loadNativeSystemFrontmostInput({ ...options, directory: join(directory, "missing") })).toBeUndefined();
    expect(loadNativeSystemFrontmostInput({ ...options, platform: "darwin", loadNative })).toBeUndefined();
  });

  it("propagates unavailable foreground and rejects native identity drift without a fallback target", () => {
    let identity: unknown = { nativeId: "123", processId: process.pid };
    const windowsHelper = loadNativeSystemFrontmostInput({
      directory: artifact(), platform: "win32", architecture: "x64",
      loadNative: () => nativeExports(() => identity)
    })!;
    const platform = createPlatformSystemFrontmostInput({ platform: "win32", windowsHelper });
    if (platform.status !== "available") throw new Error("Expected native capture.");
    expect(() => platform.runner.captureTarget()).toThrow("belongs to this process");
    for (identity of [null, { nativeId: "0", processId: 999 }, { nativeId: "123", processId: 0 },
      { nativeId: "123", processId: 999, extra: true }]) {
      expect(() => platform.runner.captureTarget()).toThrow("identity is invalid");
    }
    const unavailable = loadNativeSystemFrontmostInput({
      directory: artifact(), platform: "win32", architecture: "x64",
      loadNative: () => nativeExports(() => { throw new Error("Foreground changed."); })
    })!;
    expect(() => unavailable.captureTarget()).toThrow("Foreground changed");
  });
});

function nativeExports(captureTarget: () => unknown) {
  return {
    protocolVersion: 1, captureTarget,
    postReturn: vi.fn((_nativeId: string, _processId: number) => undefined),
    postPaste: vi.fn((_nativeId: string, _processId: number) => undefined),
    postScroll: vi.fn((_nativeId: string, _processId: number, _deltaY: number) => undefined)
  };
}
