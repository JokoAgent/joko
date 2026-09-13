import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDesktopKeepAwakeSettingsStore } from "../src/keep-awake-settings.js";
import { createDesktopUpdateAutoSettingsStore } from "../src/update-auto-settings.js";
import { createDesktopUpdateChannelSettingsStore } from "../src/update-channel-settings.js";
import { createDesktopWindowInteractionSettingsStore } from "../src/window-interaction-settings.js";
import { mkdtemp } from "./test-paths.js";

interface BooleanSettingsAdapter {
  readonly initialize: () => Promise<unknown>;
  readonly get: () => unknown;
  readonly set: (enabled: boolean) => Promise<unknown>;
  readonly reset?: () => Promise<unknown>;
}

const CASES: readonly {
  readonly name: string;
  readonly key: string;
  readonly create: (path: string) => BooleanSettingsAdapter;
}[] = [
  {
    name: "keep awake",
    key: "enabled",
    create: (path) => {
      const store = createDesktopKeepAwakeSettingsStore(path);
      return { ...store, set: store.setEnabled };
    }
  },
  {
    name: "activation click",
    key: "swallowActivationClick",
    create: (path) => {
      const store = createDesktopWindowInteractionSettingsStore(path);
      return { ...store, set: store.setSwallowActivationClick };
    }
  },
  {
    name: "idle update relaunch",
    key: "autoRelaunchOnIdle",
    create: (path) => {
      const store = createDesktopUpdateAutoSettingsStore(path);
      return { ...store, set: store.setAutoRelaunchOnIdle };
    }
  },
  {
    name: "beta update channel",
    key: "enableBeta",
    create: (path) => {
      const store = createDesktopUpdateChannelSettingsStore(path);
      return { ...store, set: store.setEnableBeta };
    }
  }
];

describe("device-local boolean settings", () => {
  it("default off, persist atomically, and reset customized choices", async () => {
    for (const entry of CASES) {
      const root = await mkdtemp(join(tmpdir(), "joko-device-setting-"));
      const path = join(root, "settings.json");
      try {
        const store = entry.create(path);
        expect(flag(await store.initialize(), entry.key), entry.name).toBe(false);
        expect(flag(await store.set(true), entry.key), entry.name).toBe(true);
        expect(JSON.parse(await readFile(path, "utf8")), entry.name).toEqual({ [entry.key]: true });
        expect(flag(await entry.create(path).initialize(), entry.key), entry.name).toBe(true);

        if (store.reset !== undefined) {
          const reset = await store.reset();
          expect(flag(reset, entry.key), entry.name).toBe(false);
          expect((reset as Record<string, unknown>)["isCustomized"], entry.name).toBe(false);
          await expect(readFile(path, "utf8"), entry.name).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(flag(await store.set(false), entry.key), entry.name).toBe(false);
          expect(flag(await entry.create(path).initialize(), entry.key), entry.name).toBe(false);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("fails malformed and non-exact stored shapes closed", async () => {
    for (const entry of CASES) {
      const root = await mkdtemp(join(tmpdir(), "joko-device-setting-invalid-"));
      const path = join(root, "settings.json");
      try {
        for (const value of [
          "{not-json",
          JSON.stringify({ [entry.key]: "yes" }),
          JSON.stringify({ [entry.key]: true, extra: false })
        ]) {
          await writeFile(path, value, { mode: 0o600 });
          expect(flag(await entry.create(path).initialize(), entry.key), entry.name).toBe(false);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects non-boolean mutations without changing the in-memory value", async () => {
    for (const entry of CASES) {
      const root = await mkdtemp(join(tmpdir(), "joko-device-setting-type-"));
      const path = join(root, "settings.json");
      try {
        const store = entry.create(path);
        await store.initialize();
        await expect(store.set("yes" as never), entry.name).rejects.toThrow(TypeError);
        expect(flag(store.get(), entry.key), entry.name).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});

function flag(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Settings snapshot for ${key} is not an object.`);
  }
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== "boolean") throw new Error(`Settings snapshot for ${key} has no boolean value.`);
  return candidate;
}
