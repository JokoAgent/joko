import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDesktopRemoteDesktopSettingsStore } from "../src/remote-desktop-settings.js";

describe("Desktop Remote Desktop settings", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  it("defaults missing and malformed private state to disabled", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "remote-desktop-settings.json");
    const missing = createDesktopRemoteDesktopSettingsStore(path);
    await expect(missing.initialize()).resolves.toEqual({ enabled: false });

    await writeFile(path, '{"enabled":true,"legacy":true}\n', { mode: 0o600 });
    const malformed = createDesktopRemoteDesktopSettingsStore(path);
    await expect(malformed.initialize()).resolves.toEqual({ enabled: false });
  });

  it("persists only the exact current-v1 enabled shape", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "remote-desktop-settings.json");
    const store = createDesktopRemoteDesktopSettingsStore(path);
    await store.initialize();
    await expect(store.setEnabled(true)).resolves.toEqual({ enabled: true });
    expect(await readFile(path, "utf8")).toBe('{"enabled":true}\n');
  });

  async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "joko-remote-desktop-settings-"));
    directories.push(directory);
    return directory;
  }
});
