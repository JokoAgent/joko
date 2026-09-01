import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createDesktopNativeTaskStatusLayoutSettingsStore,
  resolveDesktopNativeTaskStatusLayoutPreference
} from "../src/native-task-status-layout-settings.js";
import { mkdtemp } from "./test-paths.js";

describe("native task-status layout settings store", () => {
  it("atomically persists one remappable preference per display", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-native-task-layout-"));
    const path = join(root, "layout.json");
    try {
      const store = createDesktopNativeTaskStatusLayoutSettingsStore(path);
      await expect(store.initialize()).resolves.toEqual([]);
      await store.set({
        displayId: 7,
        displayName: "Studio",
        displayIndex: 1,
        displayBounds: { x: 1512, y: 0, width: 1920, height: 1080 },
        centerXRatio: 0.72,
        compactWidth: 560,
        expandedWidth: 680
      });
      await store.set({
        displayId: 19,
        displayName: "Studio",
        displayIndex: 1,
        displayBounds: { x: 1512, y: 0, width: 1920, height: 1080 },
        centerXRatio: 0.4,
        compactWidth: 620,
        expandedWidth: 760
      });

      expect(store.get()).toHaveLength(1);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        version: 1,
        preferences: [expect.objectContaining({
          displayId: 19,
          centerXRatio: 0.4,
          compactWidth: 620,
          expandedWidth: 760
        })]
      });
      await expect(createDesktopNativeTaskStatusLayoutSettingsStore(path).initialize())
        .resolves.toEqual(store.get());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("remaps operating-system display ids and fails corrupt state closed", async () => {
    const preference = {
      displayId: 2,
      displayName: "Studio",
      displayIndex: 1,
      displayBounds: { x: 1512, y: 0, width: 1920, height: 1080 },
      centerXRatio: 0.6,
      compactWidth: 480,
      expandedWidth: 640
    };
    expect(resolveDesktopNativeTaskStatusLayoutPreference([preference], {
      id: 41,
      name: "Studio",
      primary: false,
      bounds: { x: 1512, y: 0, width: 1920, height: 1080 }
    }, 1)).toEqual(preference);

    const root = await mkdtemp(join(tmpdir(), "joko-native-task-layout-invalid-"));
    const path = join(root, "layout.json");
    try {
      for (const value of [
        "{bad",
        JSON.stringify({ version: 1, preferences: [{ ...preference, compactWidth: -1 }] })
      ]) {
        await writeFile(path, value, { mode: 0o600 });
        await expect(createDesktopNativeTaskStatusLayoutSettingsStore(path).initialize()).resolves.toEqual([]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
