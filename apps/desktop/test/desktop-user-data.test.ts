import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
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
});
