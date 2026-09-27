import { describe, expect, it, vi } from "vitest";

import {
  createDedicatedHardwareSettingsStore,
  type DedicatedHardwareSettingsStoreIo
} from "./settings-store.js";
import { createDefaultDedicatedHardwareSettings } from "./settings.js";

function memoryIo(initial: Readonly<Record<string, Uint8Array>> = {}) {
  const files = new Map(Object.entries(initial).map(([path, bytes]) => [path, new Uint8Array(bytes)]));
  const writes: string[] = [];
  const io: DedicatedHardwareSettingsStoreIo = {
    readFile: async (path) => files.get(path) === undefined ? undefined : new Uint8Array(files.get(path)!),
    atomicWriteFile: async (path, bytes) => {
      writes.push(path);
      files.set(path, new Uint8Array(bytes));
    }
  };
  return { io, files, writes };
}

describe("dedicated hardware settings store", () => {
  it("defaults both models off and publishes only after a successful atomic write", async () => {
    const memory = memoryIo();
    const store = createDedicatedHardwareSettingsStore({ directory: "D:\\settings", io: memory.io });
    const published = vi.fn();
    store.subscribe(published);
    const initialized = await store.initialize();
    expect(initialized["codex-micro"].settings.enabled).toBe(false);
    expect(initialized["creator-micro-2"].settings.enabled).toBe(false);
    expect(published).not.toHaveBeenCalled();

    const enabled = { ...createDefaultDedicatedHardwareSettings("codex-micro"), enabled: true };
    await store.save("codex-micro", enabled);
    expect(memory.writes).toEqual([store.filePath("codex-micro")]);
    expect(store.get("codex-micro")).toEqual({ settings: enabled });
    expect(published).toHaveBeenCalledWith("codex-micro", { settings: enabled });
    expect(JSON.parse(new TextDecoder().decode(memory.files.get(store.filePath("codex-micro"))))).toEqual(enabled);
  });

  it("fails corrupt, oversized, and unreadable files closed without rewriting them", async () => {
    const cases: readonly { bytes?: Uint8Array; failRead?: boolean; error: "invalid" | "unavailable" }[] = [
      { bytes: new TextEncoder().encode("{not-json"), error: "invalid" },
      { bytes: new TextEncoder().encode(JSON.stringify({ version: 1, enabled: true })), error: "invalid" },
      { bytes: new Uint8Array(64 * 1024 + 1), error: "invalid" },
      { failRead: true, error: "unavailable" }
    ];
    for (const [index, entry] of cases.entries()) {
      const path = `D:\\settings\\dedicated-hardware.codex-micro.v1.json`;
      const original = entry.bytes === undefined ? undefined : new Uint8Array(entry.bytes);
      const writes = vi.fn();
      const store = createDedicatedHardwareSettingsStore({
        directory: "D:\\settings",
        io: {
          readFile: async (candidate) => {
            if (candidate !== path) return undefined;
            if (entry.failRead) throw new Error("denied");
            return original;
          },
          atomicWriteFile: writes
        }
      });
      const value = (await store.initialize())["codex-micro"];
      expect(value.error, `case ${index}`).toBe(entry.error);
      expect(value.settings.enabled, `case ${index}`).toBe(false);
      expect(writes, `case ${index}`).not.toHaveBeenCalled();
      if (entry.bytes !== undefined) expect(original, `case ${index}`).toEqual(entry.bytes);
    }
  });

  it("keeps active settings and subscribers unchanged when persistence fails", async () => {
    let fail = false;
    const writes = vi.fn(async () => {
      if (fail) throw new Error("disk full");
    });
    const store = createDedicatedHardwareSettingsStore({
      directory: "D:\\settings",
      io: { readFile: async () => undefined, atomicWriteFile: writes }
    });
    const published = vi.fn();
    store.subscribe(published);
    await store.initialize();
    const enabled = { ...createDefaultDedicatedHardwareSettings("creator-micro-2"), enabled: true };
    await store.save("creator-micro-2", enabled);
    fail = true;
    const changed = { ...enabled, lighting: { ...enabled.lighting, brightnessPercent: 35 } };
    await expect(store.save("creator-micro-2", changed)).rejects.toThrow("disk full");
    expect(store.get("creator-micro-2")).toEqual({ settings: enabled });
    expect(published).toHaveBeenCalledOnce();
  });

  it("does not let a throwing subscriber turn a persisted commit into a failure", async () => {
    const memory = memoryIo();
    const store = createDedicatedHardwareSettingsStore({ directory: "D:\\settings", io: memory.io });
    await store.initialize();
    store.subscribe(() => { throw new Error("observer failed"); });
    const observer = vi.fn();
    store.subscribe(observer);
    const settings = { ...createDefaultDedicatedHardwareSettings("codex-micro"), enabled: true };
    await expect(store.save("codex-micro", settings)).resolves.toEqual({ settings });
    expect(observer).toHaveBeenCalledOnce();
    expect(store.get("codex-micro")).toEqual({ settings });
  });

  it("resets layout or all settings while preserving the enabled choice", async () => {
    const memory = memoryIo();
    const store = createDedicatedHardwareSettingsStore({ directory: "D:\\settings", io: memory.io });
    await store.initialize();
    const defaults = createDefaultDedicatedHardwareSettings("creator-micro-2");
    const customized = {
      ...defaults,
      enabled: true,
      taskSource: "priority" as const,
      lighting: { brightnessPercent: 20, autoDim: "off" as const },
      layout: {
        ...defaults.layout,
        keys: {
          ...defaults.layout.keys,
          ACT12: { keycapId: "archive" as const, binding: { kind: "command" as const, command: "archive-task" as const } }
        }
      }
    };
    await store.save("creator-micro-2", customized);

    const layoutReset = await store.reset("creator-micro-2", "layout");
    expect(layoutReset.settings.enabled).toBe(true);
    expect(layoutReset.settings.taskSource).toBe("priority");
    expect(layoutReset.settings.lighting.brightnessPercent).toBe(20);
    expect(layoutReset.settings.layout).toEqual(defaults.layout);

    const allReset = await store.reset("creator-micro-2", "all");
    expect(allReset.settings).toEqual({ ...defaults, enabled: true });
  });

  it("serializes mutations and continues after a rejected write", async () => {
    let call = 0;
    const io: DedicatedHardwareSettingsStoreIo = {
      readFile: async () => undefined,
      atomicWriteFile: async () => {
        call += 1;
        if (call === 1) throw new Error("first failed");
      }
    };
    const store = createDedicatedHardwareSettingsStore({ directory: "D:\\settings", io });
    const first = { ...createDefaultDedicatedHardwareSettings("codex-micro"), enabled: true };
    const second = { ...first, lighting: { ...first.lighting, brightnessPercent: 40 } };
    const failed = store.save("codex-micro", first);
    const succeeded = store.save("codex-micro", second);
    await expect(failed).rejects.toThrow("first failed");
    await expect(succeeded).resolves.toEqual({ settings: second });
    expect(store.get("codex-micro")).toEqual({ settings: second });
  });
});
