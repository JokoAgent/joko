import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDesktopMainWindowCloseSettingsStore, parseMainWindowCloseSettingsChange } from "../src/window-close-settings.js";
import { mkdtemp } from "./test-paths.js";

describe("device main-window close preferences", () => {
  it("persists only the current device shape, serializes edits and retains an explicit unset choice", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-close-settings-"));
    try {
      for (const platform of ["win32", "linux"] as const) {
        const path = join(root, `${platform}.json`);
        const store = createDesktopMainWindowCloseSettingsStore(path, platform);
        expect(await store.initialize()).toEqual({ behavior: null, revision: 0 });
        const behavior = platform === "win32" ? "tray" : "minimize";
        const results = await Promise.allSettled([
          store.set({ behavior, expectedRevision: 0 }), store.set({ behavior: "quit", expectedRevision: 0 })
        ]);
        expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
        expect(await store.initialize()).toEqual({ behavior, revision: 1 });
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ behavior });
        expect(await createDesktopMainWindowCloseSettingsStore(path, platform).initialize()).toEqual({ behavior, revision: 0 });
        await store.set({ behavior: null, expectedRevision: 1 });
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ behavior: null });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects unsupported platforms, unknown fields, malformed revisions and another platform's action", async () => {
    for (const value of [
      { behavior: "minimize", expectedRevision: 0 }, { behavior: "tray", expectedRevision: -1 },
      { behavior: "tray", expectedRevision: 0.5 }, { behavior: "tray", expectedRevision: 0, extra: true },
      { behavior: "tray" }, null
    ]) expect(() => parseMainWindowCloseSettingsChange(value, "win32")).toThrow(TypeError);
    expect(() => parseMainWindowCloseSettingsChange({ behavior: "quit", expectedRevision: 0 }, "darwin")).toThrow(TypeError);
    const root = await mkdtemp(join(tmpdir(), "joko-close-settings-invalid-"));
    try {
      const path = join(root, "settings.json");
      for (const raw of ["{bad", JSON.stringify({ behavior: "minimize" }), JSON.stringify({ behavior: "tray", extra: true })]) {
        await writeFile(path, raw);
        expect(await createDesktopMainWindowCloseSettingsStore(path, "win32").initialize()).toEqual({ behavior: null, revision: 0 });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not consume the selected behavior on write failure or expired queued ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-close-settings-write-"));
    try {
      const path = join(root, "settings.json");
      const store = createDesktopMainWindowCloseSettingsStore(path, "win32");
      await store.initialize();
      await expect(store.set({ behavior: "quit", expectedRevision: 0 }, () => false)).rejects.toThrow();
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      await mkdir(path);
      await expect(store.set({ behavior: "quit", expectedRevision: 0 })).rejects.toThrow();
      expect(store.get()).toEqual({ behavior: null, revision: 0 });
      await rm(path, { recursive: true });
      expect(await store.set({ behavior: "tray", expectedRevision: 0 })).toEqual({ behavior: "tray", revision: 1 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
