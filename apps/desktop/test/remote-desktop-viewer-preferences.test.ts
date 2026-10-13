import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopRemoteDesktopViewerPreferencesStore } from "../src/remote-desktop-viewer-preferences.js";

const OWNER = { profileId: "profile", serverId: "server", deviceId: "controller" };
describe("Desktop viewer playback preferences", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + "\\") && !resolve(directory).startsWith(resolve(tmpdir()) + "/")) {
        throw new Error("Temporary preference directory escaped its root.");
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
  const path = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "joko-viewer-preferences-")); directories.push(directory);
    return join(directory, "preferences.json");
  };

  it("defaults malformed state to audio enabled without changing the original file, then rebuilds only on explicit save", async () => {
    const file = await path(), malformed = JSON.stringify({ version: 1, targets: { ["a".repeat(64)]: { audio: false, hostMute: true, lockOnExit: false } } });
    await writeFile(file, malformed, { mode: 0o600 });
    const store = createDesktopRemoteDesktopViewerPreferencesStore(file);
    await store.initialize(); expect(store.get(OWNER, "target")).toEqual({ audio: true, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false });
    expect(await readFile(file, "utf8")).toBe(malformed);
    await store.setAudio(OWNER, "target", false);
    const restarted = createDesktopRemoteDesktopViewerPreferencesStore(file); await restarted.initialize();
    expect(restarted.get(OWNER, "target")).toEqual({ audio: false, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false });
  });

  it("serially merges exact owner and target scopes and restores them after restart", async () => {
    const file = await path(), store = createDesktopRemoteDesktopViewerPreferencesStore(file);
    await store.initialize(); expect(store.get(OWNER, "target")).toEqual({ audio: true, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false });
    await Promise.all([
      store.setAudio(OWNER, "target", false), store.setAudio(OWNER, "other-target", false),
      store.setAudio({ ...OWNER, serverId: "other-server" }, "target", false), store.setHostMute(OWNER, "target", true),
      store.setLockOnExit(OWNER, "target", true), store.setClipboardSync(OWNER, "target", true), store.setPrivacyScreen(OWNER, "target", true)
    ]);
    const restarted = createDesktopRemoteDesktopViewerPreferencesStore(file); await restarted.initialize();
    expect(restarted.get(OWNER, "target")).toEqual({ audio: false, hostMute: true, lockOnExit: true, clipboardSync: true, privacyScreen: true });
    expect(restarted.get(OWNER, "other-target")).toEqual({ audio: false, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false });
    expect(restarted.get({ ...OWNER, serverId: "other-server" }, "target")).toEqual({ audio: false, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false });
    expect(restarted.get({ ...OWNER, profileId: "other-profile" }, "target")).toEqual({ audio: true, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false });
    expect(restarted.get({ ...OWNER, deviceId: "other-controller" }, "target")).toEqual({ audio: true, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false });
    const disk = JSON.parse(await readFile(file, "utf8")) as { version: number; targets: Record<string, object> };
    expect(disk.version).toBe(1); expect(Object.keys(disk.targets)).toHaveLength(3);
    expect(Object.values(disk.targets)).toEqual([{ audio: false, hostMute: true, lockOnExit: true, clipboardSync: true, privacyScreen: true }, { audio: false, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false }, { audio: false, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false }]);
  });

  it("keeps confirmed memory after a failed save and rejects a retired queued intent before writing", async () => {
    const file = await path(), store = createDesktopRemoteDesktopViewerPreferencesStore(file);
    await store.setAudio(OWNER, "target", false);
    await expect(store.setAudio(OWNER, "target", true, () => { throw new Error("retired"); })).rejects.toThrow("retired");
    await rename(file, file + ".saved"); await mkdir(file);
    await expect(store.setAudio(OWNER, "target", true)).rejects.toThrow();
    expect(store.get(OWNER, "target")).toEqual({ audio: false, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false });
    const saved = JSON.parse(await readFile(file + ".saved", "utf8")) as { targets: Record<string, object> };
    expect(Object.values(saved.targets)).toEqual([{ audio: false, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false }]);
  });
});
