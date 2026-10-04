import { describe, expect, it, vi } from "vitest";

import type { DesktopKeepAwakeSettings } from "../src/channels.js";
import {
  broadcastDesktopKeepAwakeSettings,
  createDesktopKeepAwakeSettingsCoordinator,
  type DesktopKeepAwakeBroadcastWindow
} from "../src/keep-awake-settings-coordinator.js";
import {
  createDesktopKeepAwakeController,
  type DesktopKeepAwakeController,
  type DesktopPowerSaveBlocker
} from "../src/keep-awake-controller.js";
import type { DesktopKeepAwakeSettingsStore } from "../src/keep-awake-settings.js";

function memoryStore(initial = false): DesktopKeepAwakeSettingsStore & {
  readonly writes: boolean[];
} {
  let settings = Object.freeze({ enabled: initial });
  const writes: boolean[] = [];
  return {
    writes,
    initialize: async () => settings,
    get: () => settings,
    setEnabled: async (enabled) => {
      writes.push(enabled);
      settings = Object.freeze({ enabled });
      return settings;
    }
  };
}

function nativeController(): {
  readonly controller: DesktopKeepAwakeController;
  readonly blocker: DesktopPowerSaveBlocker;
} {
  let nextId = 1;
  const active = new Set<number>();
  const blocker: DesktopPowerSaveBlocker = {
    start: vi.fn(() => {
      const id = nextId++;
      active.add(id);
      return id;
    }),
    stop: vi.fn((id) => { active.delete(id); }),
    isStarted: vi.fn((id) => active.has(id))
  };
  return { controller: createDesktopKeepAwakeController(blocker), blocker };
}

describe("Desktop keep-awake settings coordinator", () => {
  it("commits actual changes, skips duplicate writes, and never repeats an active blocker", async () => {
    const store = memoryStore();
    const { controller, blocker } = nativeController();
    const changed = vi.fn();
    const coordinator = createDesktopKeepAwakeSettingsCoordinator(store, controller, changed);
    await coordinator.initialize();

    await expect(coordinator.setEnabled(true)).resolves.toEqual({
      settings: { enabled: true },
      changed: true
    });
    await expect(coordinator.setEnabled(true)).resolves.toEqual({
      settings: { enabled: true },
      changed: false
    });

    expect(store.writes).toEqual([true]);
    expect(blocker.start).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith({ enabled: true });
  });

  it("repairs native drift from durable authority before treating a same-value set as a no-op", async () => {
    const store = memoryStore(true);
    let nextId = 1;
    const active = new Set<number>();
    const blocker: DesktopPowerSaveBlocker = {
      start: vi.fn(() => {
        const id = nextId++;
        active.add(id);
        return id;
      }),
      stop: vi.fn((id) => { active.delete(id); }),
      isStarted: vi.fn((id) => active.has(id))
    };
    const controller = createDesktopKeepAwakeController(blocker);
    const changed = vi.fn();
    const coordinator = createDesktopKeepAwakeSettingsCoordinator(store, controller, changed);
    await coordinator.initialize();
    active.clear();

    await expect(coordinator.setEnabled(true)).resolves.toEqual({
      settings: { enabled: true },
      changed: false
    });
    expect(controller.isActive()).toBe(true);
    expect(blocker.start).toHaveBeenCalledTimes(2);
    expect(store.writes).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it("serializes rapid setters against the latest confirmed durable value", async () => {
    let settings: DesktopKeepAwakeSettings = Object.freeze({ enabled: false });
    const writes: boolean[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const reachedFirst = new Promise<void>((resolve) => { firstStarted = resolve; });
    const store: DesktopKeepAwakeSettingsStore = {
      initialize: async () => settings,
      get: () => settings,
      setEnabled: async (enabled) => {
        writes.push(enabled);
        if (writes.length === 1) {
          firstStarted();
          await firstGate;
        }
        settings = Object.freeze({ enabled });
        return settings;
      }
    };
    let active = false;
    const controller: DesktopKeepAwakeController = {
      apply: (enabled) => { active = enabled; },
      release: () => { active = false; },
      isActive: () => active
    };
    const changed = vi.fn();
    const coordinator = createDesktopKeepAwakeSettingsCoordinator(store, controller, changed);
    await coordinator.initialize();

    const enable = coordinator.setEnabled(true);
    const disable = coordinator.setEnabled(false);
    await reachedFirst;
    expect(writes).toEqual([true]);

    releaseFirst();
    await expect(enable).resolves.toMatchObject({ settings: { enabled: true }, changed: true });
    await expect(disable).resolves.toMatchObject({ settings: { enabled: false }, changed: true });
    expect(writes).toEqual([true, false]);
    expect(changed.mock.calls).toEqual([[{ enabled: true }], [{ enabled: false }]]);
  });

  it("restores the previous durable and native state when native application fails", async () => {
    const store = memoryStore();
    let active = false;
    const controller: DesktopKeepAwakeController = {
      apply: vi.fn((enabled) => {
        if (enabled) throw new Error("native start failed");
        active = false;
      }),
      release: vi.fn(),
      isActive: () => active
    };
    const changed = vi.fn();
    const coordinator = createDesktopKeepAwakeSettingsCoordinator(store, controller, changed);
    await coordinator.initialize();

    await expect(coordinator.setEnabled(true)).rejects.toThrow("previous durable and native state was restored");
    await expect(coordinator.get()).resolves.toEqual({ enabled: false });
    expect(store.writes).toEqual([true, false]);
    expect(active).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it("compensates a failed native disable to enabled and permits a later retry", async () => {
    const store = memoryStore(true);
    const active = new Set<number>();
    let failStop = true;
    const blocker: DesktopPowerSaveBlocker = {
      start: vi.fn(() => {
        active.add(1);
        return 1;
      }),
      stop: vi.fn((id) => {
        if (failStop) {
          failStop = false;
          throw new Error("native stop failed");
        }
        active.delete(id);
      }),
      isStarted: vi.fn((id) => active.has(id))
    };
    const controller = createDesktopKeepAwakeController(blocker);
    const changed = vi.fn();
    const coordinator = createDesktopKeepAwakeSettingsCoordinator(store, controller, changed);
    await coordinator.initialize();

    await expect(coordinator.setEnabled(false)).rejects.toThrow("previous durable and native state was restored");
    await expect(coordinator.get()).resolves.toEqual({ enabled: true });
    expect(controller.isActive()).toBe(true);
    expect(store.writes).toEqual([false, true]);
    expect(changed).not.toHaveBeenCalled();

    await expect(coordinator.setEnabled(false)).resolves.toEqual({
      settings: { enabled: false },
      changed: true
    });
    expect(controller.isActive()).toBe(false);
    expect(store.writes).toEqual([false, true, false]);
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith({ enabled: false });
  });

  it("holds reads behind a failed transition until durable compensation settles", async () => {
    let settings: DesktopKeepAwakeSettings = Object.freeze({ enabled: false });
    let releaseCompensation!: () => void;
    let compensationStarted!: () => void;
    const compensationGate = new Promise<void>((resolve) => { releaseCompensation = resolve; });
    const compensationReached = new Promise<void>((resolve) => { compensationStarted = resolve; });
    const store: DesktopKeepAwakeSettingsStore = {
      initialize: async () => settings,
      get: () => settings,
      setEnabled: async (enabled) => {
        if (enabled) {
          settings = Object.freeze({ enabled: true });
        } else {
          compensationStarted();
          await compensationGate;
          settings = Object.freeze({ enabled: false });
        }
        return settings;
      }
    };
    let active = false;
    const controller: DesktopKeepAwakeController = {
      apply: (enabled) => {
        if (enabled) throw new Error("native start failed");
        active = false;
      },
      release: () => undefined,
      isActive: () => active
    };
    const coordinator = createDesktopKeepAwakeSettingsCoordinator(store, controller);
    await coordinator.initialize();

    const mutation = coordinator.setEnabled(true);
    await compensationReached;
    expect(store.get()).toEqual({ enabled: true });
    let readSettled = false;
    const read = coordinator.get().finally(() => { readSettled = true; });
    await Promise.resolve();
    expect(readSettled).toBe(false);

    releaseCompensation();
    await expect(mutation).rejects.toThrow("native application failed");
    await expect(read).resolves.toEqual({ enabled: false });
  });

  it("keeps an incomplete compensation observable through the serialized authoritative get", async () => {
    const durable = memoryStore();
    const store: DesktopKeepAwakeSettingsStore = {
      initialize: durable.initialize,
      get: durable.get,
      setEnabled: vi.fn(async (enabled) => {
        if (!enabled && durable.get().enabled) throw new Error("durable rollback failed");
        return durable.setEnabled(enabled);
      })
    };
    const controller: DesktopKeepAwakeController = {
      apply: vi.fn((enabled) => {
        if (enabled) throw new Error("native start failed");
      }),
      release: vi.fn(),
      isActive: () => false
    };
    const coordinator = createDesktopKeepAwakeSettingsCoordinator(store, controller);
    await coordinator.initialize();

    await expect(coordinator.setEnabled(true)).rejects.toThrow("compensation was incomplete");
    await expect(coordinator.get()).resolves.toEqual({ enabled: true });
  });

  it("does not reverse a confirmed mutation when the observer throws", async () => {
    const store = memoryStore();
    const { controller } = nativeController();
    const coordinator = createDesktopKeepAwakeSettingsCoordinator(store, controller, () => {
      throw new Error("renderer unavailable");
    });
    await coordinator.initialize();

    await expect(coordinator.setEnabled(true)).resolves.toEqual({
      settings: { enabled: true },
      changed: true
    });
    await expect(coordinator.get()).resolves.toEqual({ enabled: true });
    expect(controller.isActive()).toBe(true);
  });
});

it("broadcasts to each live renderer independently and ignores observer failures", () => {
  const goodSend = vi.fn();
  const failedSend = vi.fn(() => { throw new Error("renderer crashed"); });
  const destroyedSend = vi.fn();
  const windows: DesktopKeepAwakeBroadcastWindow[] = [
    { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: destroyedSend } },
    { isDestroyed: () => false, webContents: { isDestroyed: () => true, send: destroyedSend } },
    {
      isDestroyed: () => { throw new Error("window closed during inspection"); },
      webContents: { isDestroyed: () => false, send: destroyedSend }
    },
    { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: failedSend } },
    { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: goodSend } }
  ];
  const settings = Object.freeze({ enabled: true });

  expect(() => broadcastDesktopKeepAwakeSettings(windows, "keep-awake:changed", settings)).not.toThrow();
  expect(failedSend).toHaveBeenCalledWith("keep-awake:changed", settings);
  expect(goodSend).toHaveBeenCalledWith("keep-awake:changed", settings);
  expect(destroyedSend).not.toHaveBeenCalled();
});
