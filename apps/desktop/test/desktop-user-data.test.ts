import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  prepareDesktopManagedWorkspaceDirectory,
  prepareDesktopUserDataDirectory,
  resolveDesktopUserDataDirectory
} from "../src/desktop-user-data.js";

describe("Desktop user-data directory", () => {
  it("isolates an unpackaged development profile from packaged user data", () => {
    expect(resolveDesktopUserDataDirectory({
      packaged: false,
      appDataDirectory: resolve("C:/Users/test/AppData/Roaming"),
      packagedSmoke: false
    })).toBe(resolve("C:/Users/test/AppData/Roaming", "Joko Development"));
  });

  it("leaves packaged defaults unchanged while preserving the explicit smoke override", () => {
    const appDataDirectory = resolve("C:/Users/test/AppData/Roaming");
    expect(resolveDesktopUserDataDirectory({
      packaged: true,
      appDataDirectory,
      packagedSmoke: false
    })).toBeUndefined();
    expect(resolveDesktopUserDataDirectory({
      packaged: true,
      appDataDirectory,
      packagedSmoke: true,
      packagedSmokeDirectory: resolve("C:/temp/joko-smoke")
    })).toBe(resolve("C:/temp/joko-smoke"));
  });

  it("creates and canonicalizes the profile root before Electron uses it", () => {
    const parent = mkdtempSync(join(tmpdir(), "joko-desktop-user-data-"));
    const directory = resolve(parent, "profile");
    try {
      expect(prepareDesktopUserDataDirectory(directory)).toBe(realpathSync.native(directory));
      expect(existsSync(directory)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("runs smoke tasks in the temporary profile while ordinary tasks keep Documents", () => {
    const parent = mkdtempSync(join(tmpdir(), "joko-desktop-workspace-"));
    const profile = resolve(parent, "profile");
    const documents = resolve(parent, "documents");
    try {
      expect(prepareDesktopManagedWorkspaceDirectory({
        packagedSmoke: false, userDataDirectory: profile, documentsDirectory: documents
      })).toBe(documents);
      expect(existsSync(profile)).toBe(false);
      expect(existsSync(documents)).toBe(false);
      const workspace = prepareDesktopManagedWorkspaceDirectory({
        packagedSmoke: true, userDataDirectory: profile, documentsDirectory: documents
      });
      expect(workspace).toBe(realpathSync.native(resolve(profile, "smoke-workspace")));
      expect(existsSync(documents)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects an existing smoke workspace link that escapes the temporary profile", () => {
    const parent = mkdtempSync(join(tmpdir(), "joko-desktop-workspace-"));
    const profile = resolve(parent, "profile");
    const outside = resolve(parent, "outside");
    mkdirSync(profile); mkdirSync(outside);
    symlinkSync(outside, resolve(profile, "smoke-workspace"), process.platform === "win32" ? "junction" : "dir");
    try {
      expect(() => prepareDesktopManagedWorkspaceDirectory({
        packagedSmoke: true, userDataDirectory: profile, documentsDirectory: resolve(parent, "documents")
      })).toThrow("must remain inside");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
