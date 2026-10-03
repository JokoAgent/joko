import { describe, expect, it, vi } from "vitest";

import {
  createDedicatedHardwareMainController,
  type DedicatedHardwarePhysicalInputController
} from "./dedicated-hardware-main-controller.js";
import {
  DEDICATED_HARDWARE_MODEL_IDS,
  createDefaultDedicatedHardwareSettings,
  type DedicatedHardwareModelId,
  type DedicatedHardwareSettings
} from "./dedicated-hardware/settings.js";
import type {
  DedicatedHardwareConnectionSnapshot,
  DedicatedHardwareInputEvent
} from "./dedicated-hardware/protocol.js";
import type { DedicatedHardwareHostClient } from "./dedicated-hardware/host-client.js";
import type {
  DedicatedHardwareSettingsRead,
  DedicatedHardwareSettingsStore
} from "./dedicated-hardware/settings-store.js";

function connection(
  model: DedicatedHardwareModelId,
  status: DedicatedHardwareConnectionSnapshot["status"] = "disabled"
): DedicatedHardwareConnectionSnapshot {
  return {
    model,
    status,
    reason: status === "unavailable" ? "sdk-unavailable" : null,
    devicePresent: status === "connected" ? true : null,
    transport: status === "connected" ? "usb" : null,
    firmwareVersion: null,
    batteryPercent: null,
    charging: null,
    inputPermission: "not-required",
    keymap: model === "creator-micro-2"
      ? { phase: "idle", backupAvailable: false, failure: null }
      : null
  };
}

function harness(initialError?: "invalid" | "unavailable") {
  const values = new Map<DedicatedHardwareModelId, DedicatedHardwareSettingsRead>(
    DEDICATED_HARDWARE_MODEL_IDS.map((model) => [model, {
      settings: createDefaultDedicatedHardwareSettings(model),
      ...(initialError === undefined ? {} : { error: initialError })
    }])
  );
  const stateListeners = new Set<(model: DedicatedHardwareModelId, state: DedicatedHardwareConnectionSnapshot) => void>();
  const inputListeners = new Set<(model: DedicatedHardwareModelId, sequence: number, input: DedicatedHardwareInputEvent) => void>();
  const states = new Map<DedicatedHardwareModelId, DedicatedHardwareConnectionSnapshot>(
    DEDICATED_HARDWARE_MODEL_IDS.map((model) => [model, connection(model)] as const)
  );
  const desired: Array<{ model: DedicatedHardwareModelId; settings: DedicatedHardwareSettings; preview: boolean }> = [];
  const lighting = vi.fn<DedicatedHardwareHostClient["setLightingState"]>();
  const store: DedicatedHardwareSettingsStore = {
    initialize: async () => Object.fromEntries(values) as Readonly<Record<DedicatedHardwareModelId, DedicatedHardwareSettingsRead>>,
    get: (model) => values.get(model)!,
    save: async (model, settings) => {
      const read = { settings };
      values.set(model, read);
      return read;
    },
    reset: async (model, scope = "all") => {
      const prior = values.get(model)!.settings;
      const defaults = createDefaultDedicatedHardwareSettings(model);
      const read = { settings: scope === "layout" ? { ...prior, layout: defaults.layout } : { ...defaults, enabled: prior.enabled } };
      values.set(model, read);
      return read;
    },
    subscribe: () => () => undefined,
    filePath: (model) => model
  };
  const host: DedicatedHardwareHostClient = {
    getConnectionState: (model) => states.get(model)!,
    setDesiredState: (model, next) => desired.push({ model, settings: next.settings, preview: next.preview }),
    setLightingState: lighting,
    probe: vi.fn(() => true),
    inspectCreatorKeymapRecovery: vi.fn(async () => states.get("creator-micro-2")!),
    recoverCreatorKeymap: vi.fn(async () => states.get("creator-micro-2")!),
    retry: vi.fn(),
    stop: vi.fn(async () => undefined),
    subscribeConnectionState: (listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    subscribeInput: (listener) => { inputListeners.add(listener); return () => inputListeners.delete(listener); }
  };
  const input: DedicatedHardwarePhysicalInputController = {
    updateModel: vi.fn(),
    handleInput: vi.fn(),
    setPreview: vi.fn(),
    cancelModel: vi.fn(),
    cancelAll: vi.fn()
  };
  return {
    store,
    host,
    input,
    desired,
    lighting,
    setConnection(model: DedicatedHardwareModelId, status: DedicatedHardwareConnectionSnapshot["status"]) {
      const next = connection(model, status);
      states.set(model, next);
      for (const listener of stateListeners) listener(model, next);
    },
    sendInput(model: DedicatedHardwareModelId, inputEvent: DedicatedHardwareInputEvent) {
      for (const listener of inputListeners) listener(model, 1, inputEvent);
    }
  };
}

describe("dedicated hardware main controller", () => {
  it("projects unreadable settings without silently rewriting them", async () => {
    const owner = harness("invalid");
    const controller = createDedicatedHardwareMainController({
      store: owner.store,
      host: owner.host,
      input: owner.input
    });
    const state = await controller.initialize();
    expect(state.models["codex-micro"].settingsError).toBe("invalid");
    expect(state.models["codex-micro"].settings.enabled).toBe(false);
    expect(owner.desired).toHaveLength(2);
    expect(owner.desired.every((entry) => !entry.settings.enabled && !entry.preview)).toBe(true);
  });

  it("persists before applying enabled settings and clears the recovery error", async () => {
    const owner = harness("unavailable");
    const controller = createDedicatedHardwareMainController({ store: owner.store, host: owner.host, input: owner.input });
    await controller.initialize();
    const settings = { ...createDefaultDedicatedHardwareSettings("codex-micro"), enabled: true };
    const state = await controller.setSettings("codex-micro", settings);
    expect(state.models["codex-micro"].settingsError).toBeNull();
    expect(owner.desired.at(-1)).toMatchObject({ model: "codex-micro", settings: { enabled: true }, preview: false });
  });

  it("selects and pads task slots from the strict catalog", async () => {
    const owner = harness();
    const controller = createDedicatedHardwareMainController({ store: owner.store, host: owner.host, input: owner.input });
    await controller.initialize();
    controller.setPrimaryWindowVisible("window-a", true);
    const state = controller.publishTasks({
      version: 1,
      profileId: "profile-a",
      serverId: "server-a",
      connectionGeneration: "4",
      snapshotRevision: "9",
      tasks: [
        { sessionId: "older", sessionGeneration: "1", targetId: "target-1", title: "Older", pinned: false, userSendAt: 10, sidebarOrder: 0, catalogEligible: true, priorityRank: 1, activity: { phase: "completed", attention: true } },
        { sessionId: "newer", sessionGeneration: "2", targetId: "target-2", title: "Newer", pinned: true, userSendAt: 20, sidebarOrder: 1, catalogEligible: true, priorityRank: 0, activity: { phase: "running", attention: false } }
      ]
    }, "window-a");
    expect(state.models["codex-micro"].taskSlots).toHaveLength(6);
    expect(state.models["codex-micro"].taskSlots.slice(0, 3)).toEqual([
      { slot: 0, sessionId: "newer", title: "Newer" },
      { slot: 1, sessionId: "older", title: "Older" },
      { slot: 2, sessionId: null, title: null }
    ]);
    const stale = controller.publishTasks({
      version: 1,
      profileId: "profile-a",
      serverId: "server-a",
      connectionGeneration: "4",
      snapshotRevision: "8",
      tasks: []
    }, "window-a");
    expect(stale.models["codex-micro"].taskSlots[0]).toEqual({
      slot: 0,
      sessionId: "newer",
      title: "Newer"
    });
  });

  it("keeps background activity while hidden and retires exact document lighting and reveals", async () => {
    const owner = harness();
    const controller = createDedicatedHardwareMainController({ store: owner.store, host: owner.host, input: owner.input });
    await controller.initialize();
    const catalog = {
      version: 1, profileId: "profile", serverId: "server", connectionGeneration: "4", snapshotRevision: "9",
      tasks: [{ sessionId: "task", sessionGeneration: "3", targetId: "target", title: "Task", pinned: false,
        userSendAt: 1, sidebarOrder: 0, catalogEligible: true, priorityRank: 1, activity: { phase: "running", attention: false } }]
    };
    controller.setPrimaryWindowVisible("document-a", true);
    controller.publishTasks(catalog, "document-a");
    expect(owner.lighting).toHaveBeenLastCalledWith("creator-micro-2", {
      version: 1, primaryVisible: true, revealOccurrence: "0",
      taskSlots: [{ phase: "running", attention: false }, null, null, null, null, null]
    });
    controller.setPrimaryWindowVisible("document-a", false);
    controller.publishTasks({ ...catalog, snapshotRevision: "10", tasks: [{ ...catalog.tasks[0],
      activity: { phase: "needs-interaction", attention: true } }] }, "document-a");
    controller.playWindowReveal("document-a");
    expect(owner.lighting).toHaveBeenLastCalledWith("creator-micro-2", {
      version: 1, primaryVisible: false, revealOccurrence: "0",
      taskSlots: [{ phase: "needs-interaction", attention: true }, null, null, null, null, null]
    });
    controller.setPrimaryWindowVisible("document-a", true);
    controller.playWindowReveal("document-a");
    expect(owner.lighting).toHaveBeenLastCalledWith("creator-micro-2", expect.objectContaining({ revealOccurrence: "1" }));
    controller.retireOwner("document-a");
    const retired = { version: 1, primaryVisible: false, revealOccurrence: "1", taskSlots: [null, null, null, null, null, null] };
    expect(owner.lighting).toHaveBeenLastCalledWith("creator-micro-2", retired);
    controller.setPrimaryWindowVisible("document-a", true);
    controller.publishTasks({ ...catalog, snapshotRevision: "11" }, "document-a");
    controller.playWindowReveal("document-a");
    expect(owner.lighting).toHaveBeenLastCalledWith("creator-micro-2", retired);
    controller.setPrimaryWindowVisible("document-b", true);
    controller.publishTasks(catalog, "document-b");
    expect(owner.lighting).toHaveBeenLastCalledWith("creator-micro-2", expect.objectContaining({
      primaryVisible: true, taskSlots: [{ phase: "running", attention: false }, null, null, null, null, null]
    }));
  });

  it("keeps preview exclusive, emits raw preview only, and cancels it on disconnect", async () => {
    const owner = harness();
    const preview = vi.fn();
    const controller = createDedicatedHardwareMainController({
      store: owner.store,
      host: owner.host,
      input: owner.input,
      onPreviewInput: preview
    });
    await controller.initialize();
    await controller.setSettings("codex-micro", {
      ...createDefaultDedicatedHardwareSettings("codex-micro"),
      enabled: true
    });
    owner.setConnection("codex-micro", "connected");
    controller.setPreview("codex-micro", "window-a", true);
    expect(() => controller.setPreview("codex-micro", "window-b", true)).toThrow(/already owned/u);
    owner.sendInput("codex-micro", { kind: "key", key: "ACT06", pressed: true });
    expect(preview).toHaveBeenCalledWith("window-a", {
      version: 1,
      model: "codex-micro",
      kind: "key",
      key: "ACT06",
      pressed: true
    });
    expect(owner.input.handleInput).toHaveBeenCalledWith("codex-micro", {
      kind: "key", key: "ACT06", pressed: true
    });
    owner.setConnection("codex-micro", "error");
    expect(owner.desired.at(-1)).toMatchObject({ model: "codex-micro", preview: false });
    expect(owner.input.cancelModel).toHaveBeenCalledWith("codex-micro");
  });

  it("cancels held input but preserves an enabled connected preview across settings and layout reset", async () => {
    const owner = harness();
    const controller = createDedicatedHardwareMainController({
      store: owner.store,
      host: owner.host,
      input: owner.input
    });
    await controller.initialize();
    const enabled = {
      ...createDefaultDedicatedHardwareSettings("codex-micro"),
      enabled: true
    };
    await controller.setSettings("codex-micro", enabled);
    owner.setConnection("codex-micro", "connected");
    controller.setPreview("codex-micro", "window-a", true);

    await controller.setSettings("codex-micro", { ...enabled, taskSource: "sidebar" });
    expect(owner.input.cancelModel).toHaveBeenCalledWith("codex-micro");
    expect(owner.input.setPreview).not.toHaveBeenCalledWith("codex-micro", false);
    expect(owner.desired.at(-1)).toMatchObject({ model: "codex-micro", preview: true });
    expect(() => controller.setPreview("codex-micro", "window-b", true)).toThrow(/already owned/u);

    await controller.resetSettings("codex-micro", "layout");
    expect(owner.desired.at(-1)).toMatchObject({ model: "codex-micro", preview: true });
    expect(() => controller.setPreview("codex-micro", "window-b", true)).toThrow(/already owned/u);
  });

  it("uses an explicit enabled probe to recover a paused or breaker-open host", async () => {
    const owner = harness();
    const controller = createDedicatedHardwareMainController({ store: owner.store, host: owner.host, input: owner.input });
    await controller.initialize();
    vi.mocked(owner.host.probe).mockReturnValue(false);
    expect(controller.probe("codex-micro")).toBe(false);
    expect(owner.host.retry).not.toHaveBeenCalled();

    await controller.setSettings("codex-micro", {
      ...createDefaultDedicatedHardwareSettings("codex-micro"),
      enabled: true
    });
    expect(controller.probe("codex-micro")).toBe(true);
    expect(owner.host.retry).toHaveBeenCalledOnce();
  });

  it("consumes the exact inspection and recovery snapshots without relying on listener timing", async () => {
    const owner = harness();
    const inspected: DedicatedHardwareConnectionSnapshot = {
      ...connection("creator-micro-2", "disabled"),
      keymap: { phase: "error", backupAvailable: true, failure: "recovery-required" }
    };
    vi.mocked(owner.host.inspectCreatorKeymapRecovery).mockResolvedValue(inspected);
    const controller = createDedicatedHardwareMainController({
      store: owner.store,
      host: owner.host,
      input: owner.input
    });

    const initialized = await controller.initialize();
    expect(initialized.models["creator-micro-2"].keymap).toEqual({
      phase: "error", backupAvailable: true, failure: "recovery-required"
    });

    const recovered: DedicatedHardwareConnectionSnapshot = {
      ...connection("creator-micro-2", "connected"),
      keymap: { phase: "occupied", backupAvailable: true, failure: null }
    };
    vi.mocked(owner.host.recoverCreatorKeymap).mockResolvedValue(recovered);
    const state = await controller.recoverKeymap("creator-micro-2");
    expect(state.models["creator-micro-2"]).toMatchObject({
      status: "connected",
      keymap: { phase: "occupied", backupAvailable: true, failure: null }
    });
  });
});
