import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDesktopNativeTaskStatusSettingsStore } from "../src/native-task-status-settings.js";
import { mkdtemp } from "./test-paths.js";

describe("native task-status settings store", () => {
  it("atomically persists the complete device-local preference", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-native-task-status-"));
    const path = join(root, "settings.json");
    try {
      const store = createDesktopNativeTaskStatusSettingsStore(path);
      await expect(store.initialize()).resolves.toMatchObject({ enabled: false, layout: "normal" });
      const next = {
        enabled: true,
        display: {
          mode: "display" as const,
          displayId: 7,
          displayName: "Studio",
          displayIndex: 1,
          displayBounds: { x: 1512, y: 0, width: 1920, height: 1080 }
        },
        layout: "compact" as const,
        sounds: {
          enabled: true,
          sounds: {
            start: { type: "builtin" as const, id: "none" as const },
            attention: { type: "builtin" as const, id: "secret-chime" as const },
            complete: { type: "custom" as const, path: "/tmp/done.m4a", name: "done.m4a" },
            error: { type: "builtin" as const, id: "none" as const },
            select: { type: "builtin" as const, id: "item-found" as const }
          }
        }
      };
      await expect(store.set(next)).resolves.toEqual(next);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(next);
      await expect(createDesktopNativeTaskStatusSettingsStore(path).initialize()).resolves.toEqual(next);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails corrupt and shape-invalid state closed to disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-native-task-status-invalid-"));
    const path = join(root, "settings.json");
    try {
      for (const value of ["{bad", JSON.stringify({ enabled: true }), JSON.stringify({
        enabled: true,
        display: { mode: "all" },
        layout: "normal",
        sounds: { enabled: true, sounds: {} },
        extra: true
      })]) {
        await writeFile(path, value, { mode: 0o600 });
        await expect(createDesktopNativeTaskStatusSettingsStore(path).initialize())
          .resolves.toMatchObject({ enabled: false });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
