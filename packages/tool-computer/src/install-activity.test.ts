import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clearStaleComputerInstallLock,
  ComputerInstallActivitySampler,
  extractInstallDownloadPath
} from "./install-activity.js";

describe("computer installer activity", () => {
  it("extracts POSIX and PowerShell download targets without accepting relative paths", () => {
    const posix = process.platform === "win32" ? "C:\\Temp\\driver.zip" : "/tmp/driver.tar.gz";
    const windows = "C:\\Temp\\driver.zip";
    expect(extractInstallDownloadPath(`curl -fsSL -o "${posix}" https://example.test/archive`)).toBe(posix);
    expect(extractInstallDownloadPath(`Invoke-WebRequest -OutFile '${windows}' https://example.test/archive`))
      .toBe(process.platform === "win32" ? windows : undefined);
    expect(extractInstallDownloadPath("curl -o relative.tar.gz https://example.test/archive")).toBeUndefined();
  });

  it("reports byte growth and then a real installing phase", async () => {
    const root = mkdtempSync(join(tmpdir(), "joko-install-activity-"));
    const assetName = "cua-driver-rs-1.2.3-linux-x86_64-binary.tar.gz";
    const archive = join(root, assetName);
    writeFileSync(archive, Buffer.alloc(1_024));
    let installing = false;
    const sampler = new ComputerInstallActivitySampler({
      platform: process.platform,
      assets: [{ name: assetName, size: 4_096 }],
      searchRoots: [root],
      readProcesses: async () => [{
        pid: 12,
        parentPid: 1,
        cpuTime: installing ? "0:02" : "0:01",
        command: installing ? "tar -xf archive" : `curl -o "${archive}" https://example.test/archive`
      }]
    });
    try {
      await expect(sampler.sample(12, new AbortController().signal)).resolves.toMatchObject({
        phase: "downloading",
        downloadedBytes: 1_024,
        totalBytes: 4_096
      });
      rmSync(archive);
      installing = true;
      await expect(sampler.sample(12, new AbortController().signal)).resolves.toMatchObject({
        phase: "installing"
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes only a real stale lock owned by a confirmed dead process", async () => {
    const root = mkdtempSync(join(tmpdir(), "joko-install-lock-"));
    const lock = join(root, ".install.lock.d");
    mkdirSync(lock);
    writeFileSync(join(lock, "info"), "pid=4242\n");
    try {
      await expect(clearStaleComputerInstallLock(lock, () => true)).resolves.toBe(false);
      expect(await clearStaleComputerInstallLock(lock, () => false)).toBe(true);
      expect(await clearStaleComputerInstallLock(lock, () => false)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never follows a lock-directory symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "joko-install-lock-root-"));
    const outside = mkdtempSync(join(tmpdir(), "joko-install-lock-outside-"));
    writeFileSync(join(outside, "info"), "pid=4242\n");
    const link = join(root, ".install.lock.d");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      await expect(clearStaleComputerInstallLock(link, () => false)).resolves.toBe(false);
      expect(() => rmSync(join(outside, "info"))).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
