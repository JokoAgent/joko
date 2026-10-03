import { describe, expect, it, vi } from "vitest";

import { createDedicatedHardwareSdkManifestIntegrity } from "../dedicated-hardware-sdk.js";
import { createDefaultDedicatedHardwareSettings } from "./settings.js";
import type { DedicatedHardwareKeymapBackup, DedicatedHardwareKeymapBackupStore } from "./keymap-controller.js";
import type { DedicatedHardwareUtilityDeviceSnapshot } from "./protocol.js";
import {
  createDedicatedHardwareUtilityRequestHandler,
  type DedicatedHardwareUtilityAdapter,
  type DedicatedHardwareUtilityAdapterSink
} from "./utility-handler.js";

const connected = (model: "codex-micro" | "creator-micro-2"): DedicatedHardwareUtilityDeviceSnapshot => ({
  model,
  status: "connected",
  reason: null,
  devicePresent: true,
  transport: "bluetooth",
  firmwareVersion: "1.0.0",
  batteryPercent: 70,
  charging: true,
  inputPermission: "not-required",
  keymapDeviceFirmwareIdentity: model === "creator-micro-2" ? "creator-a@firmware-1" : null
});

function creatorKeymap(): DedicatedHardwareUtilityAdapter["creatorKeymap"] {
  const original = JSON.stringify({ profiles: [{ layers: [{}] }] });
  let current = original;
  return {
    readDeviceFirmwareIdentity: vi.fn(async () => "creator-a@firmware-1"),
    readCurrent: vi.fn(async () => current),
    buildManaged: vi.fn((value, taskKeys) => JSON.stringify({
      ...(JSON.parse(value) as object),
      jokoManagedTaskKeys: taskKeys
    })),
    writeCurrent: vi.fn(async (_identity, value) => { current = value; }),
    reload: vi.fn(async () => undefined)
  };
}

function backupStore(initial?: DedicatedHardwareKeymapBackup): DedicatedHardwareKeymapBackupStore {
  const backups = new Map<string, DedicatedHardwareKeymapBackup>();
  if (initial !== undefined) backups.set(initial.deviceFirmwareIdentity, initial);
  return {
    listBackups: vi.fn(async () => [...backups.values()]),
    readBackup: vi.fn(async (identity) => backups.get(identity)),
    saveBackup: vi.fn(async (value) => {
      if (backups.has(value.deviceFirmwareIdentity)) throw new Error("exists");
      backups.set(value.deviceFirmwareIdentity, value);
    }),
    clearBackup: vi.fn(async (identity) => { backups.delete(identity); })
  };
}

const sdkIntegrity = `sha512-${"A".repeat(86)}==`;
const sdkManifestWithoutIntegrity = {
  version: 1 as const,
  packageName: "@worklouder/device-kit-oai" as const,
  packageVersion: "0.1.11",
  redistributionGrantId: "approved-grant",
  license: { relativePath: "LICENSE.vendor.txt", integrity: sdkIntegrity },
  target: {
    platform: "win32" as const,
    architecture: "x64" as const,
    electronModulesAbi: 148,
    nodeApiVersion: 10
  },
  entry: { relativePath: "adapter.mjs", integrity: sdkIntegrity },
  nativeAddons: [{
    identity: "@vendor/device-native@0.1.11",
    relativePath: "native/device.node",
    integrity: sdkIntegrity,
    abi: "electron-modules" as const
  }],
  files: [
    { relativePath: "LICENSE.vendor.txt", size: 1, integrity: sdkIntegrity },
    { relativePath: "adapter.mjs", size: 1, integrity: sdkIntegrity },
    { relativePath: "native/device.node", size: 1, integrity: sdkIntegrity }
  ],
  directoryIntegrity: sdkIntegrity
};
const stagedSdk = {
  kind: "staged" as const,
  stagingDirectory: process.platform === "win32" ? "D:\\Joko\\runtime\\device-kit" : "/opt/joko/device-kit",
  manifest: {
    ...sdkManifestWithoutIntegrity,
    manifestIntegrity: createDedicatedHardwareSdkManifestIntegrity(sdkManifestWithoutIntegrity)
  }
};
const keymapBackupDirectory = process.platform === "win32" ? "D:\\Joko\\keymap" : "/tmp/joko-keymap";

describe("dedicated hardware utility request handler", () => {
  it("handshakes and reports stable unavailable state without an SDK", async () => {
    const messages: unknown[] = [];
    const load = vi.fn();
    const handler = createDedicatedHardwareUtilityRequestHandler({
      postMessage: (message) => messages.push(message),
      loadStagedAdapter: load,
      openKeymapBackupStore: async () => backupStore()
    });
    await expect(handler.handle({
      version: 1, generation: 1, requestId: "g1:1", kind: "handshake", sdk: { kind: "unavailable" }, keymapBackupDirectory
    })).resolves.toBe("continue");
    expect(load).not.toHaveBeenCalled();
    expect(messages[0]).toEqual({ version: 1, generation: 1, requestId: "g1:1", kind: "ready" });
    expect(messages.slice(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "state", model: "codex-micro", status: "unavailable", reason: "sdk-unavailable" }),
      expect.objectContaining({ kind: "state", model: "creator-micro-2", status: "unavailable", reason: "sdk-unavailable" })
    ]));

    const settings = { ...createDefaultDedicatedHardwareSettings("codex-micro"), enabled: true };
    await handler.handle({
      version: 1, generation: 1, requestId: "g1:2", kind: "set-desired-state",
      model: "codex-micro", settings, preview: false
    });
    expect(messages.at(-2)).toEqual({ version: 1, generation: 1, requestId: "g1:2", kind: "ack" });
    expect(messages.at(-1)).toEqual(expect.objectContaining({ status: "unavailable", reason: "sdk-unavailable" }));

    const beforeLighting = messages.length;
    await expect(handler.handle({
      version: 1, generation: 1, requestId: "g1:3", kind: "set-lighting-state", model: "codex-micro",
      state: { version: 1, taskSlots: [null, null, null, null, null, null], revealOccurrence: "0", primaryVisible: false }
    })).resolves.toBe("continue");
    expect(messages.slice(beforeLighting)).toEqual([{ version: 1, generation: 1, requestId: "g1:3", kind: "ack" }]);

    await expect(handler.handle({
      version: 1, generation: 1, requestId: "g1:4", kind: "shutdown"
    })).resolves.toBe("stopped");
    expect(messages.at(-1)).toEqual({ version: 1, generation: 1, requestId: "g1:4", kind: "stopped" });
  });

  it("accepts a locked staged adapter and assigns monotonic input sequences", async () => {
    const messages: unknown[] = [];
    let sink: DedicatedHardwareUtilityAdapterSink | undefined;
    const adapter: DedicatedHardwareUtilityAdapter = {
      creatorKeymap: creatorKeymap(),
      setLightingState: vi.fn(() => new Promise<void>(() => undefined)),
      setDesiredState: vi.fn(async (model) => connected(model)),
      probe: vi.fn(async (model) => connected(model)),
      stop: vi.fn(async () => undefined)
    };
    const handler = createDedicatedHardwareUtilityRequestHandler({
      postMessage: (message) => messages.push(message),
      loadStagedAdapter: vi.fn(async (_identity, providedSink) => { sink = providedSink; return adapter; }),
      openKeymapBackupStore: async () => backupStore()
    });
    const sdk = stagedSdk;
    await handler.handle({ version: 1, generation: 2, requestId: "g2:1", kind: "handshake", sdk, keymapBackupDirectory });
    expect(messages[0]).toEqual({ version: 1, generation: 2, requestId: "g2:1", kind: "ready" });

    const settings = { ...createDefaultDedicatedHardwareSettings("creator-micro-2"), enabled: true };
    await handler.handle({
      version: 1, generation: 2, requestId: "g2:2", kind: "set-desired-state",
      model: "creator-micro-2", settings, preview: true
    });
    expect(adapter.setDesiredState).toHaveBeenCalledWith("creator-micro-2", { settings, preview: true });
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "state", status: "connected", keymap: expect.objectContaining({ phase: "occupied" }) })
    ]));
    expect(messages.at(-1)).toEqual({ version: 1, generation: 2, requestId: "g2:2", kind: "ack" });

    const lighting = {
      version: 1, taskSlots: [{ phase: "running", attention: false }, null, null, null, null, null],
      revealOccurrence: "0", primaryVisible: false
    } as const;
    const writes = vi.mocked(adapter.creatorKeymap.writeCurrent).mock.calls.length;
    await expect(handler.handle({
      version: 1, generation: 2, requestId: "g2:3", kind: "set-lighting-state", model: "creator-micro-2", state: lighting
    })).resolves.toBe("continue");
    expect(adapter.setLightingState).toHaveBeenCalledWith("creator-micro-2", lighting);
    expect(adapter.creatorKeymap.writeCurrent).toHaveBeenCalledTimes(writes);
    expect(messages.at(-1)).toEqual({ version: 1, generation: 2, requestId: "g2:3", kind: "ack" });

    sink!.publishInput("creator-micro-2", { kind: "key", key: "AG00", pressed: true });
    sink!.publishInput("creator-micro-2", { kind: "key", key: "AG00", pressed: false });
    expect(messages.slice(-2)).toEqual([
      expect.objectContaining({ kind: "input", sequence: 0, input: { kind: "key", key: "AG00", pressed: true } }),
      expect.objectContaining({ kind: "input", sequence: 1, input: { kind: "key", key: "AG00", pressed: false } })
    ]);

    const inputCount = messages.filter((message) => (message as { kind?: string }).kind === "input").length;
    sink!.publishState({
      ...connected("creator-micro-2"),
      status: "not-detected",
      reason: "device-disconnected",
      devicePresent: false,
      transport: null,
      firmwareVersion: null,
      batteryPercent: null,
      charging: null,
      keymapDeviceFirmwareIdentity: null
    });
    sink!.publishInput("creator-micro-2", { kind: "key", key: "AG01", pressed: true });
    expect(messages.filter((message) => (message as { kind?: string }).kind === "input")).toHaveLength(inputCount);

    await handler.handle({ version: 1, generation: 2, requestId: "g2:4", kind: "probe", model: "creator-micro-2" });
    expect(adapter.probe).toHaveBeenCalledWith("creator-micro-2");
    await expect(handler.handle({ version: 1, generation: 2, requestId: "g2:5", kind: "shutdown" })).resolves.toBe("stopped");
    expect(adapter.stop).toHaveBeenCalledOnce();
  });

  it("never publishes adapter state or input before the ready handshake", async () => {
    const messages: unknown[] = [];
    const handler = createDedicatedHardwareUtilityRequestHandler({
      postMessage: (message) => messages.push(message),
      openKeymapBackupStore: async () => backupStore(),
      loadStagedAdapter: async (_identity, sink) => {
        sink.publishState(connected("codex-micro"));
        sink.publishInput("codex-micro", { kind: "key", key: "AG00", pressed: true });
        return {
          creatorKeymap: creatorKeymap(),
          setLightingState: vi.fn(),
          setDesiredState: async (model) => connected(model),
          probe: async (model) => connected(model),
          stop: async () => undefined
        };
      }
    });
    await handler.handle({
      version: 1,
      generation: 5,
      requestId: "g5:1",
      kind: "handshake",
      sdk: stagedSdk,
      keymapBackupDirectory
    });
    expect(messages[0]).toEqual({ version: 1, generation: 5, requestId: "g5:1", kind: "ready" });
    expect(messages[1]).toEqual(expect.objectContaining({ kind: "state", model: "codex-micro" }));
    expect(messages.some((message) => (message as { kind?: string }).kind === "input")).toBe(false);
  });

  it("projects a durable recovery requirement during an all-disabled SDK-unavailable inspection", async () => {
    const messages: unknown[] = [];
    const original = JSON.stringify({ profiles: [{ layers: [{}] }] });
    const store = backupStore({
      version: 1,
      deviceFirmwareIdentity: "creator-a@firmware-1",
      contents: original
    });
    const handler = createDedicatedHardwareUtilityRequestHandler({
      postMessage: (message) => messages.push(message),
      loadStagedAdapter: vi.fn(),
      openKeymapBackupStore: async () => store
    });

    await handler.handle({
      version: 1,
      generation: 6,
      requestId: "g6:1",
      kind: "handshake",
      sdk: { kind: "unavailable" },
      keymapBackupDirectory
    });
    expect(messages).toContainEqual(expect.objectContaining({
      kind: "state",
      model: "creator-micro-2",
      status: "unavailable",
      keymap: { phase: "error", backupAvailable: true, failure: "recovery-required" }
    }));

    await handler.handle({
      version: 1,
      generation: 6,
      requestId: "g6:2",
      kind: "inspect-keymap",
      model: "creator-micro-2"
    });
    expect(messages.at(-2)).toEqual(expect.objectContaining({
      kind: "state",
      keymap: { phase: "error", backupAvailable: true, failure: "recovery-required" }
    }));
    expect(messages.at(-1)).toEqual({ version: 1, generation: 6, requestId: "g6:2", kind: "ack" });
  });

  it("automatically occupies the exact desired task keys after a later connected sink state", async () => {
    const messages: unknown[] = [];
    let sink: DedicatedHardwareUtilityAdapterSink | undefined;
    const keymap = creatorKeymap();
    const connecting: DedicatedHardwareUtilityDeviceSnapshot = {
      ...connected("creator-micro-2"),
      status: "connecting",
      reason: null,
      devicePresent: null,
      keymapDeviceFirmwareIdentity: null
    };
    const adapter: DedicatedHardwareUtilityAdapter = {
      creatorKeymap: keymap,
      setLightingState: vi.fn(),
      setDesiredState: vi.fn(async () => connecting),
      probe: vi.fn(async () => connected("creator-micro-2")),
      stop: vi.fn(async () => undefined)
    };
    const handler = createDedicatedHardwareUtilityRequestHandler({
      postMessage: (message) => messages.push(message),
      loadStagedAdapter: vi.fn(async (_identity, providedSink) => { sink = providedSink; return adapter; }),
      openKeymapBackupStore: async () => backupStore()
    });
    await handler.handle({
      version: 1, generation: 7, requestId: "g7:1", kind: "handshake", sdk: stagedSdk, keymapBackupDirectory
    });
    const defaults = createDefaultDedicatedHardwareSettings("creator-micro-2");
    const settings = {
      ...defaults,
      enabled: true,
      layout: { ...defaults.layout, taskKeys: ["AG00", "AG02"] as const }
    };
    await handler.handle({
      version: 1, generation: 7, requestId: "g7:2", kind: "set-desired-state",
      model: "creator-micro-2", settings, preview: false
    });
    expect(keymap.writeCurrent).not.toHaveBeenCalled();

    sink!.publishState(connected("creator-micro-2"));
    await handler.handle({
      version: 1, generation: 7, requestId: "g7:3", kind: "probe", model: "creator-micro-2"
    });
    expect(keymap.buildManaged).toHaveBeenCalledWith(expect.any(String), ["AG00", "AG02"]);
    expect(keymap.writeCurrent).toHaveBeenCalledOnce();
    expect(messages).toContainEqual(expect.objectContaining({
      kind: "state", status: "connected", keymap: { phase: "occupied", backupAvailable: true, failure: null }
    }));
  });

  it("keeps the real connected projection on apply failure and still acknowledges the desired request", async () => {
    const messages: unknown[] = [];
    const keymap = creatorKeymap();
    const write = vi.mocked(keymap.writeCurrent);
    const delegate = write.getMockImplementation()!;
    let writes = 0;
    write.mockImplementation(async (identity, value) => {
      writes += 1;
      if (writes === 1) throw new Error("apply failed");
      await delegate(identity, value);
    });
    const adapter: DedicatedHardwareUtilityAdapter = {
      creatorKeymap: keymap,
      setLightingState: vi.fn(),
      setDesiredState: vi.fn(async () => connected("creator-micro-2")),
      probe: vi.fn(async () => connected("creator-micro-2")),
      stop: vi.fn(async () => undefined)
    };
    const handler = createDedicatedHardwareUtilityRequestHandler({
      postMessage: (message) => messages.push(message),
      loadStagedAdapter: vi.fn(async () => adapter),
      openKeymapBackupStore: async () => backupStore()
    });
    await handler.handle({
      version: 1, generation: 8, requestId: "g8:1", kind: "handshake", sdk: stagedSdk, keymapBackupDirectory
    });
    const settings = { ...createDefaultDedicatedHardwareSettings("creator-micro-2"), enabled: true };
    await handler.handle({
      version: 1, generation: 8, requestId: "g8:2", kind: "set-desired-state",
      model: "creator-micro-2", settings, preview: false
    });

    expect(messages).toContainEqual(expect.objectContaining({
      kind: "state",
      model: "creator-micro-2",
      status: "connected",
      reason: null,
      keymap: { phase: "error", backupAvailable: false, failure: "apply" }
    }));
    expect(messages).not.toContainEqual(expect.objectContaining({
      model: "creator-micro-2", status: "error", reason: "device-disconnected"
    }));
    expect(messages.at(-1)).toEqual({ version: 1, generation: 8, requestId: "g8:2", kind: "ack" });
  });

  it("continues low-level disable and stop after restore fails, retaining explicit recovery", async () => {
    const messages: unknown[] = [];
    const keymap = creatorKeymap();
    const write = vi.mocked(keymap.writeCurrent);
    const delegate = write.getMockImplementation()!;
    let writes = 0;
    write.mockImplementation(async (identity, value) => {
      writes += 1;
      if (writes === 2) throw new Error("restore failed");
      await delegate(identity, value);
    });
    const disabled: DedicatedHardwareUtilityDeviceSnapshot = {
      ...connected("creator-micro-2"),
      status: "disabled",
      devicePresent: null,
      transport: null,
      firmwareVersion: null,
      batteryPercent: null,
      charging: null,
      keymapDeviceFirmwareIdentity: null
    };
    const adapter: DedicatedHardwareUtilityAdapter = {
      creatorKeymap: keymap,
      setLightingState: vi.fn(),
      setDesiredState: vi.fn(async (_model, desired) =>
        desired.settings.enabled ? connected("creator-micro-2") : disabled),
      probe: vi.fn(async () => connected("creator-micro-2")),
      stop: vi.fn(async () => undefined)
    };
    const handler = createDedicatedHardwareUtilityRequestHandler({
      postMessage: (message) => messages.push(message),
      loadStagedAdapter: vi.fn(async () => adapter),
      openKeymapBackupStore: async () => backupStore()
    });
    await handler.handle({
      version: 1, generation: 9, requestId: "g9:1", kind: "handshake", sdk: stagedSdk, keymapBackupDirectory
    });
    const enabled = { ...createDefaultDedicatedHardwareSettings("creator-micro-2"), enabled: true };
    await handler.handle({
      version: 1, generation: 9, requestId: "g9:2", kind: "set-desired-state",
      model: "creator-micro-2", settings: enabled, preview: false
    });
    const off = { ...enabled, enabled: false };
    await handler.handle({
      version: 1, generation: 9, requestId: "g9:3", kind: "set-desired-state",
      model: "creator-micro-2", settings: off, preview: false
    });

    expect(adapter.setDesiredState).toHaveBeenLastCalledWith("creator-micro-2", { settings: off, preview: false });
    expect(messages).toContainEqual(expect.objectContaining({
      kind: "state",
      status: "disabled",
      keymap: { phase: "error", backupAvailable: true, failure: "restore" }
    }));
    expect(messages.at(-1)).toEqual({ version: 1, generation: 9, requestId: "g9:3", kind: "ack" });

    await expect(handler.handle({
      version: 1, generation: 9, requestId: "g9:4", kind: "shutdown"
    })).resolves.toBe("stopped");
    expect(adapter.stop).toHaveBeenCalledOnce();
  });

  it("recovers then reoccupies the desired map in one serialized enabled-device request", async () => {
    const messages: unknown[] = [];
    const original = JSON.stringify({ profiles: [{ layers: [{}] }] });
    const store = backupStore({
      version: 1,
      deviceFirmwareIdentity: "creator-a@firmware-1",
      contents: original
    });
    const keymap = creatorKeymap();
    const adapter: DedicatedHardwareUtilityAdapter = {
      creatorKeymap: keymap,
      setLightingState: vi.fn(),
      setDesiredState: vi.fn(async () => connected("creator-micro-2")),
      probe: vi.fn(async () => connected("creator-micro-2")),
      stop: vi.fn(async () => undefined)
    };
    const handler = createDedicatedHardwareUtilityRequestHandler({
      postMessage: (message) => messages.push(message),
      loadStagedAdapter: vi.fn(async () => adapter),
      openKeymapBackupStore: async () => store
    });
    await handler.handle({
      version: 1, generation: 10, requestId: "g10:1", kind: "handshake", sdk: stagedSdk, keymapBackupDirectory
    });
    const defaults = createDefaultDedicatedHardwareSettings("creator-micro-2");
    const settings = {
      ...defaults,
      enabled: true,
      layout: { ...defaults.layout, taskKeys: ["AG01", "AG02"] as const }
    };
    await handler.handle({
      version: 1, generation: 10, requestId: "g10:2", kind: "set-desired-state",
      model: "creator-micro-2", settings, preview: false
    });
    expect(messages).toContainEqual(expect.objectContaining({
      kind: "state", status: "connected",
      keymap: { phase: "error", backupAvailable: true, failure: "recovery-required" }
    }));

    await handler.handle({
      version: 1, generation: 10, requestId: "g10:3", kind: "recover-keymap", model: "creator-micro-2"
    });
    expect(keymap.buildManaged).toHaveBeenLastCalledWith(original, ["AG01", "AG02"]);
    expect(messages.at(-2)).toEqual(expect.objectContaining({
      kind: "state", status: "connected",
      keymap: { phase: "occupied", backupAvailable: true, failure: null }
    }));
    expect(messages.at(-1)).toEqual({ version: 1, generation: 10, requestId: "g10:3", kind: "ack" });
  });

  it("forces low-level input disabled when post-recovery reoccupancy fails", async () => {
    const messages: unknown[] = [];
    let sink: DedicatedHardwareUtilityAdapterSink | undefined;
    const original = JSON.stringify({ profiles: [{ layers: [{}] }] });
    const store = backupStore({
      version: 1,
      deviceFirmwareIdentity: "creator-a@firmware-1",
      contents: original
    });
    const keymap = creatorKeymap();
    vi.mocked(keymap.buildManaged).mockImplementation(() => { throw new Error("transform failed"); });
    const disabled: DedicatedHardwareUtilityDeviceSnapshot = {
      ...connected("creator-micro-2"),
      status: "disabled",
      devicePresent: null,
      transport: null,
      firmwareVersion: null,
      batteryPercent: null,
      charging: null,
      keymapDeviceFirmwareIdentity: null
    };
    const adapter: DedicatedHardwareUtilityAdapter = {
      creatorKeymap: keymap,
      setLightingState: vi.fn(),
      setDesiredState: vi.fn(async (_model, desired) =>
        desired.settings.enabled ? connected("creator-micro-2") : disabled),
      probe: vi.fn(async () => connected("creator-micro-2")),
      stop: vi.fn(async () => undefined)
    };
    const handler = createDedicatedHardwareUtilityRequestHandler({
      postMessage: (message) => messages.push(message),
      loadStagedAdapter: vi.fn(async (_identity, providedSink) => { sink = providedSink; return adapter; }),
      openKeymapBackupStore: async () => store
    });
    await handler.handle({
      version: 1, generation: 11, requestId: "g11:1", kind: "handshake", sdk: stagedSdk, keymapBackupDirectory
    });
    const settings = { ...createDefaultDedicatedHardwareSettings("creator-micro-2"), enabled: true };
    await handler.handle({
      version: 1, generation: 11, requestId: "g11:2", kind: "set-desired-state",
      model: "creator-micro-2", settings, preview: true
    });
    await handler.handle({
      version: 1, generation: 11, requestId: "g11:3", kind: "recover-keymap", model: "creator-micro-2"
    });

    expect(adapter.setDesiredState).toHaveBeenLastCalledWith("creator-micro-2", {
      settings: { ...settings, enabled: false },
      preview: false
    });
    expect(messages.at(-2)).toEqual(expect.objectContaining({
      kind: "state",
      status: "disabled",
      keymap: { phase: "error", backupAvailable: false, failure: "transform" }
    }));
    expect(messages.at(-1)).toEqual({ version: 1, generation: 11, requestId: "g11:3", kind: "ack" });

    sink!.publishState(connected("creator-micro-2"));
    await handler.handle({
      version: 1, generation: 11, requestId: "g11:4", kind: "probe", model: "creator-micro-2"
    });
    expect(keymap.buildManaged).toHaveBeenCalledOnce();
  });

  it("drops Creator input when post-recovery reoccupancy and low-level disable both fail", async () => {
    const messages: unknown[] = [];
    let sink: DedicatedHardwareUtilityAdapterSink | undefined;
    const original = JSON.stringify({ profiles: [{ layers: [{}] }] });
    const keymap = creatorKeymap();
    vi.mocked(keymap.buildManaged).mockImplementation(() => { throw new Error("transform failed"); });
    const adapter: DedicatedHardwareUtilityAdapter = {
      creatorKeymap: keymap,
      setLightingState: vi.fn(),
      setDesiredState: vi.fn(async (_model, desired) => {
        if (!desired.settings.enabled) throw new Error("disable not confirmed");
        return connected("creator-micro-2");
      }),
      probe: vi.fn(async () => connected("creator-micro-2")),
      stop: vi.fn(async () => undefined)
    };
    const handler = createDedicatedHardwareUtilityRequestHandler({
      postMessage: (message) => messages.push(message),
      loadStagedAdapter: vi.fn(async (_identity, providedSink) => { sink = providedSink; return adapter; }),
      openKeymapBackupStore: async () => backupStore({
        version: 1,
        deviceFirmwareIdentity: "creator-a@firmware-1",
        contents: original
      })
    });
    await handler.handle({
      version: 1, generation: 12, requestId: "g12:1", kind: "handshake", sdk: stagedSdk, keymapBackupDirectory
    });
    const settings = { ...createDefaultDedicatedHardwareSettings("creator-micro-2"), enabled: true };
    await handler.handle({
      version: 1, generation: 12, requestId: "g12:2", kind: "set-desired-state",
      model: "creator-micro-2", settings, preview: false
    });
    await handler.handle({
      version: 1, generation: 12, requestId: "g12:3", kind: "recover-keymap", model: "creator-micro-2"
    });

    expect(adapter.setDesiredState).toHaveBeenLastCalledWith("creator-micro-2", {
      settings: { ...settings, enabled: false }, preview: false
    });
    expect(messages).toContainEqual(expect.objectContaining({
      kind: "state", status: "connected",
      keymap: { phase: "error", backupAvailable: false, failure: "transform" }
    }));
    sink!.publishInput("creator-micro-2", { kind: "key", key: "AG00", pressed: true });
    expect(messages.some((message) => (message as { kind?: string }).kind === "input")).toBe(false);
  });

  it("terminates on malformed, replayed, out-of-generation, or post-stop requests", async () => {
    const create = () => createDedicatedHardwareUtilityRequestHandler({
      postMessage: vi.fn(),
      loadStagedAdapter: vi.fn(async () => { throw new Error("missing"); }),
      openKeymapBackupStore: async () => backupStore()
    });
    await expect(create().handle({ version: 1, generation: 1, requestId: "bad", kind: "shutdown" })).resolves.toBe("terminate");

    const replay = create();
    const hello = {
      version: 1, generation: 1, requestId: "g1:1", kind: "handshake", sdk: { kind: "unavailable" }, keymapBackupDirectory
    } as const;
    await replay.handle(hello);
    await expect(replay.handle({
      version: 1, generation: 1, requestId: "g1:1", kind: "probe", model: "codex-micro"
    })).resolves.toBe("terminate");

    const wrongGeneration = create();
    await wrongGeneration.handle(hello);
    await expect(wrongGeneration.handle({
      version: 1, generation: 2, requestId: "g2:2", kind: "probe", model: "codex-micro"
    })).resolves.toBe("terminate");
  });

  it("fails adapter load and operations closed without carrying native error text", async () => {
    const messages: unknown[] = [];
    const handler = createDedicatedHardwareUtilityRequestHandler({
      postMessage: (message) => messages.push(message),
      loadStagedAdapter: async () => { throw new Error("secret native path"); },
      openKeymapBackupStore: async () => backupStore()
    });
    await handler.handle({
      version: 1,
      generation: 3,
      requestId: "g3:1",
      kind: "handshake",
      sdk: stagedSdk,
      keymapBackupDirectory
    });
    expect(JSON.stringify(messages)).not.toContain("secret native path");
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "state", status: "unavailable", reason: "sdk-unavailable" })
    ]));
  });
});
