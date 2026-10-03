import { describe, expect, it, vi } from "vitest";

import { createDedicatedHardwareSdkManifestIntegrity } from "../dedicated-hardware-sdk.js";
import type {
  DedicatedHardwareKeymapBackup,
  DedicatedHardwareKeymapBackupStore
} from "./keymap-controller.js";
import type { DedicatedHardwareModelId } from "./settings.js";
import { createDefaultDedicatedHardwareSettings } from "./settings.js";
import type {
  DedicatedHardwareSdkIdentity,
  DedicatedHardwareUtilityMessage
} from "./protocol.js";
import {
  createDedicatedHardwareUtilityRequestHandler,
  type DedicatedHardwareUtilityAdapterSink
} from "./utility-handler.js";
import { createDedicatedHardwareVendorAdapter } from "./vendor-adapter.js";

const CREATOR = "creator-micro-2";
const CODEX = "codex-micro";
const ORIGINAL = JSON.stringify({
  metadata: { keep: "document" },
  profiles: [
    { layers: [{ layout: { keymap: [["first-profile"]] } }] },
    {
      layers: [
        { layout: { keymap: [["inactive-layer"]] } },
        {
          id: 8,
          name: "active",
          layout: {
            keymap: [["factory"]],
            encoders: [["old"]],
            buttons: [],
            joystick: { type: "other" },
            metadata: { keep: true }
          }
        }
      ]
    }
  ]
}, null, 2) + "\n";

function status() {
  return {
    ok: true,
    value: {
      firmwareVersion: "1.2.3",
      batteryPercentage: 71,
      isCharging: false,
      profileIndex: 1,
      layerIndex: 2
    }
  };
}

function desired(model: DedicatedHardwareModelId, enabled = true) {
  const defaults = createDefaultDedicatedHardwareSettings(model);
  return {
    settings: {
      ...defaults,
      enabled,
      layout: { ...defaults.layout, taskKeys: ["AG03", "ACT10"] as const }
    },
    preview: false
  };
}

function sdkFixture(options: { synchronousNotification?: boolean } = {}) {
  const order: string[] = [];
  let current = ORIGINAL;
  let deviceStatus: unknown = status();
  let writeResult: unknown = { ok: true, value: null };
  let readResult: unknown | undefined;
  let connectResult = true;
  let serialNumber: string | undefined = "controlled-device-a";
  const devices = { [CODEX]: "codex", [CREATOR]: "creator" } as const;
  const discovery = vi.fn((filter: unknown[]) => {
    const model = filter[0] === devices[CREATOR] ? CREATOR : CODEX;
    return [{ model, serialNumber, isUsbConnection: true }];
  });

  class Comm {
    model: DedicatedHardwareModelId | undefined;
    rpcResponse = "";
    readonly connect = vi.fn(async (device: { model: DedicatedHardwareModelId }) => {
      order.push("connect");
      this.model = device.model;
      return connectResult;
    });
    readonly disconnect = vi.fn(async () => { order.push("disconnect"); });
    parseRpcData(_data: string): boolean { return false; }
  }
  const comms: Comm[] = [];
  const apis: Api[] = [];
  class Api {
    readonly hidListeners: Array<(event: unknown) => void> = [];
    readonly joystickListeners: Array<(event: unknown) => void> = [];
    readonly unsubscribeHid = vi.fn();
    readonly unsubscribeJoystick = vi.fn();
    readonly api = {
      readFile: vi.fn(async (fileName: string) => {
        expect(fileName).toBe("keymap.json");
        order.push("read-keymap");
        return readResult ?? { ok: true, value: current };
      }),
      writeFile: vi.fn(async (fileName: string, contents: unknown) => {
        expect(fileName).toBe("keymap.json");
        expect(typeof contents).toBe("string");
        order.push(contents === ORIGINAL ? "write-original" : "write-managed");
        if ((writeResult as { ok?: unknown }).ok === true) current = contents as string;
        return writeResult;
      })
    };
    readonly getDeviceStatus = vi.fn(async () => {
      order.push("read-status");
      return deviceStatus;
    });
    constructor(readonly comm: Comm) { apis.push(this); }
    onHidReceived(listener: (event: unknown) => void) {
      this.hidListeners.push(listener);
      if (options.synchronousNotification) listener({ key: "AG00", act: 1 });
      return this.unsubscribeHid;
    }
    onJoystickMove(listener: (event: unknown) => void) {
      this.joystickListeners.push(listener);
      return this.unsubscribeJoystick;
    }
    emitHid(event: unknown) { for (const listener of this.hidListeners) listener(event); }
    emitJoystick(event: unknown) { for (const listener of this.joystickListeners) listener(event); }
  }

  const sdk = {
    DeviceType: { CodexMicro: devices[CODEX], CreatorMicroV2: devices[CREATOR] },
    WLDeviceDiscovery: class {
      readonly findWLDevices = discovery;
    },
    WLDeviceCommImpl: class extends Comm {
      constructor() { super(); comms.push(this); }
    },
    RPCApiOAI: Api
  };
  return {
    sdk, order, comms, apis, discovery,
    current: () => current,
    setStatus: (value: unknown) => { deviceStatus = value; },
    setWriteResult: (value: unknown) => { writeResult = value; },
    setReadResult: (value: unknown) => { readResult = value; },
    setConnectResult: (value: boolean) => { connectResult = value; },
    setSerialNumber: (value: string | undefined) => { serialNumber = value; }
  };
}

function sinkFixture() {
  return { publishState: vi.fn(), publishInput: vi.fn() } satisfies DedicatedHardwareUtilityAdapterSink;
}

function backupFixture(order: string[]) {
  const sessions = new Map<string, DedicatedHardwareKeymapBackup>();
  const store: DedicatedHardwareKeymapBackupStore = {
    listBackups: async () => [...sessions.values()],
    readBackup: async (identity) => sessions.get(identity),
    saveBackup: async (backup) => {
      if (sessions.has(backup.deviceFirmwareIdentity)) throw new Error("Session already exists.");
      order.push("save-backup");
      sessions.set(backup.deviceFirmwareIdentity, backup);
    },
    clearBackup: async (identity) => {
      order.push("clear-backup");
      sessions.delete(identity);
    }
  };
  return { store, sessions };
}

function stagedIdentity(): Extract<DedicatedHardwareSdkIdentity, { kind: "staged" }> {
  const integrity = `sha512-${"A".repeat(86)}==`;
  const manifest = {
    version: 1 as const,
    packageName: "@worklouder/device-kit-oai" as const,
    packageVersion: "0.2.1",
    redistributionGrantId: "controlled-namespace-test",
    license: { relativePath: "LICENSE.vendor.txt", integrity },
    target: { platform: "win32" as const, architecture: "x64" as const, electronModulesAbi: 148, nodeApiVersion: 10 },
    entry: { relativePath: "index.mjs", integrity },
    nativeAddons: [{ identity: "@vendor/device-native@0.2.1", relativePath: "native/device.node", integrity, abi: "node-api" as const }],
    files: [
      { relativePath: "LICENSE.vendor.txt", size: 1, integrity },
      { relativePath: "index.mjs", size: 1, integrity },
      { relativePath: "native/device.node", size: 1, integrity }
    ],
    directoryIntegrity: integrity
  };
  return {
    kind: "staged",
    stagingDirectory: process.platform === "win32" ? "D:\\Joko\\controlled-sdk" : "/tmp/joko-controlled-sdk",
    manifest: { ...manifest, manifestIntegrity: createDedicatedHardwareSdkManifestIntegrity(manifest) }
  };
}

describe("dedicated hardware vendor adapter", () => {
  it("requires the declared raw namespace and fences construction, retired, disabled, and stopped callbacks", async () => {
    const fixture = sdkFixture({ synchronousNotification: true });
    const sink = sinkFixture();
    expect(() => createDedicatedHardwareVendorAdapter({ sdk: { default: fixture.sdk }, sink, platform: "win32" }))
      .toThrow();
    const adapter = createDedicatedHardwareVendorAdapter({ sdk: fixture.sdk, sink, platform: "win32", settle: async () => undefined });
    expect(fixture.comms).toHaveLength(0);
    const connected = await adapter.setDesiredState(CODEX, desired(CODEX));
    expect(connected).toMatchObject({ model: CODEX, status: "connected", keymapDeviceFirmwareIdentity: null });
    expect(fixture.discovery).toHaveBeenCalledWith([fixture.sdk.DeviceType.CodexMicro]);
    expect(sink.publishInput).not.toHaveBeenCalled();
    const api = fixture.apis.at(-1)!;
    api.emitHid({ key: "AG00", act: 1 });
    expect(sink.publishInput).toHaveBeenLastCalledWith(CODEX, { kind: "key", key: "AG00", pressed: true });
    let count = sink.publishInput.mock.calls.length;
    fixture.setStatus({ ok: false, value: status().value });
    expect((await adapter.probe(CODEX)).status).toBe("error");
    api.emitHid({ key: "AG00", act: 0 });
    expect(sink.publishInput).toHaveBeenCalledTimes(count);
    fixture.setStatus(status());
    await adapter.setDesiredState(CODEX, desired(CODEX));
    const replacement = fixture.apis.at(-1)!;
    expect(replacement).not.toBe(api);
    api.emitHid({ key: "AG01", act: 1 });
    expect(sink.publishInput).toHaveBeenCalledTimes(count);
    replacement.emitHid({ key: "AG01", act: 1 });
    expect(sink.publishInput).toHaveBeenLastCalledWith(CODEX, { kind: "key", key: "AG01", pressed: true });
    count += 1;
    const disabled = await adapter.setDesiredState(CODEX, desired(CODEX, false));
    expect(disabled.status).toBe("disabled");
    replacement.emitHid({ key: "AG01", act: 0 });
    replacement.emitJoystick({ angle: 0, distance: 1 });
    expect(sink.publishInput).toHaveBeenCalledTimes(count);
    await adapter.stop();
    replacement.emitHid({ key: "AG00", act: 1 });
    expect(sink.publishInput).toHaveBeenCalledTimes(count);
  });

  it.each([
    ["missing serial", (fixture: ReturnType<typeof sdkFixture>) => fixture.setSerialNumber(undefined)],
    ["rejected status", (fixture: ReturnType<typeof sdkFixture>) => fixture.setStatus({ ok: false, value: status().value })],
    ["missing active context", (fixture: ReturnType<typeof sdkFixture>) => fixture.setStatus({ ok: true, value: { firmwareVersion: "1.2.3" } })],
    ["connect false", (fixture: ReturnType<typeof sdkFixture>) => fixture.setConnectResult(false)]
  ] as const)("cannot write from %s", async (_name, invalidate) => {
    const fixture = sdkFixture();
    invalidate(fixture);
    const adapter = createDedicatedHardwareVendorAdapter({ sdk: fixture.sdk, sink: sinkFixture(), platform: "win32", settle: async () => undefined });
    try {
      await adapter.setDesiredState(CREATOR, desired(CREATOR));
      await expect(adapter.creatorKeymap.readDeviceFirmwareIdentity()
        .then((identity) => adapter.creatorKeymap.readCurrent(identity))).rejects.toThrow();
      expect(fixture.order).not.toContain("write-managed");
      expect(fixture.current()).toBe(ORIGINAL);
    } finally {
      await adapter.stop();
    }
  });

  it("keeps disabled input closed while keymap maintenance connects without a probe", async () => {
    const fixture = sdkFixture();
    const sink = sinkFixture();
    const adapter = createDedicatedHardwareVendorAdapter({ sdk: fixture.sdk, sink, platform: "win32", settle: async () => undefined });
    try {
      expect((await adapter.setDesiredState(CREATOR, desired(CREATOR, false))).status).toBe("disabled");
      expect(fixture.comms).toHaveLength(0);
      const identity = await adapter.creatorKeymap.readDeviceFirmwareIdentity();
      expect(await adapter.creatorKeymap.readCurrent(identity)).toBe(ORIGINAL);
      expect(fixture.discovery).toHaveBeenCalledWith([fixture.sdk.DeviceType.CreatorMicroV2]);
      fixture.apis.at(-1)!.emitHid({ key: "AG00", act: 1 });
      expect(sink.publishInput).not.toHaveBeenCalled();
    } finally {
      await adapter.stop();
    }
  });

  it("rejects identity drift and unsuccessful filesystem envelopes before confirming a managed map", async () => {
    const fixture = sdkFixture();
    const sink = sinkFixture();
    const adapter = createDedicatedHardwareVendorAdapter({ sdk: fixture.sdk, sink, platform: "win32", settle: async () => undefined });
    try {
      await adapter.setDesiredState(CREATOR, desired(CREATOR));
      const identity = await adapter.creatorKeymap.readDeviceFirmwareIdentity();
      const original = await adapter.creatorKeymap.readCurrent(identity);
      const managed = adapter.creatorKeymap.buildManaged(original, ["AG03", "ACT10"]);
      fixture.setStatus({ ...status(), value: { ...status().value, firmwareVersion: "2.0.0" } });
      await expect(adapter.creatorKeymap.writeCurrent(identity, managed)).rejects.toThrow();
      expect(fixture.order).not.toContain("write-managed");
      fixture.setStatus(status());
      fixture.setWriteResult({ ok: false, value: null });
      await expect(adapter.creatorKeymap.writeCurrent(identity, managed)).rejects.toThrow();
      const api = fixture.apis.at(-1)!;
      api.emitHid({ key: "AG00", act: 1 });
      expect(sink.publishInput).not.toHaveBeenCalled();
      fixture.setWriteResult({ ok: true, value: null });
      await adapter.creatorKeymap.writeCurrent(identity, managed);
      fixture.setReadResult({ ok: false, value: managed });
      await expect(adapter.creatorKeymap.reload(identity)).rejects.toThrow();
      api.emitHid({ key: "AG00", act: 1 });
      expect(sink.publishInput).not.toHaveBeenCalled();
    } finally {
      await adapter.stop();
    }
  });

  it("occupies the active layer through the utility owner, admits the confirmed inverse map, and restores exact bytes before stop", async () => {
    const fixture = sdkFixture();
    const backup = backupFixture(fixture.order);
    const messages: DedicatedHardwareUtilityMessage[] = [];
    let releaseSettle!: () => void;
    let notifySettle!: () => void;
    const firstSettle = new Promise<void>((resolve) => { releaseSettle = resolve; });
    const settleStarted = new Promise<void>((resolve) => { notifySettle = resolve; });
    let settling = 0;
    const handler = createDedicatedHardwareUtilityRequestHandler({
      postMessage: (message) => messages.push(message),
      openKeymapBackupStore: async () => backup.store,
      loadStagedAdapter: async (_identity, sink) => createDedicatedHardwareVendorAdapter({
        sdk: fixture.sdk,
        sink,
        platform: "win32",
        settle: async () => {
          fixture.order.push("settle");
          if (++settling === 1) { notifySettle(); await firstSettle; }
        }
      })
    });
    await handler.handle({
      version: 1, generation: 1, requestId: "g1:1", kind: "handshake", sdk: stagedIdentity(),
      keymapBackupDirectory: process.platform === "win32" ? "D:\\Joko\\controlled-keymap" : "/tmp/joko-controlled-keymap"
    });
    const enabled = desired(CREATOR);
    const occupy = handler.handle({
      version: 1, generation: 1, requestId: "g1:2", kind: "set-desired-state", model: CREATOR, ...enabled
    });
    await settleStarted;
    const api = fixture.apis.at(-1)!;
    api.emitHid({ key: "AG00", act: 1 });
    expect(messages.filter((message) => message.kind === "input")).toHaveLength(0);
    expect([...backup.sessions.values()][0]?.contents).toBe(ORIGINAL);
    expect(fixture.order.indexOf("save-backup")).toBeLessThan(fixture.order.indexOf("write-managed"));
    releaseSettle();
    await occupy;
    const source = JSON.parse(ORIGINAL) as { profiles: Array<{ layers: unknown[] }>; metadata: unknown };
    const next = JSON.parse(fixture.current()) as typeof source;
    expect(next.profiles[0]).toEqual(source.profiles[0]);
    expect(next.profiles[1]!.layers[0]).toEqual(source.profiles[1]!.layers[0]);
    expect(next.metadata).toEqual(source.metadata);
    expect(next.profiles[1]!.layers[1]).not.toEqual(source.profiles[1]!.layers[1]);
    expect(messages).toContainEqual(expect.objectContaining({
      kind: "state", model: CREATOR, status: "connected",
      keymap: { phase: "occupied", backupAvailable: true, failure: null }
    }));
    api.emitHid({ key: "AG00", act: 1 });
    api.emitHid({ key: "AG00", act: 0 });
    expect(messages.filter((message) => message.kind === "input")).toEqual([
      expect.objectContaining({ model: CREATOR, sequence: 0, input: { kind: "key", key: "AG03", pressed: true } }),
      expect.objectContaining({ model: CREATOR, sequence: 1, input: { kind: "key", key: "AG03", pressed: false } })
    ]);
    await handler.handle({
      version: 1, generation: 1, requestId: "g1:3", kind: "set-desired-state", model: CREATOR, ...desired(CREATOR, false)
    });
    expect(fixture.current()).toBe(ORIGINAL);
    expect(backup.sessions.size).toBe(0);
    const restoredAt = fixture.order.indexOf("write-original");
    const restoreConfirmation = fixture.order.indexOf("read-keymap", restoredAt + 1);
    expect(restoreConfirmation).toBeGreaterThan(restoredAt);
    expect(fixture.order.indexOf("clear-backup")).toBeGreaterThan(restoreConfirmation);
    expect(messages).toContainEqual(expect.objectContaining({
      kind: "state", model: CREATOR, status: "disabled",
      keymap: { phase: "idle", backupAvailable: false, failure: null }
    }));
    api.emitHid({ key: "AG00", act: 1 });
    expect(messages.filter((message) => message.kind === "input")).toHaveLength(2);
    await expect(handler.handle({ version: 1, generation: 1, requestId: "g1:4", kind: "shutdown" }))
      .resolves.toBe("stopped");
    expect(fixture.order.lastIndexOf("disconnect")).toBeGreaterThan(fixture.order.indexOf("clear-backup"));
    api.emitHid({ key: "AG01", act: 1 });
    expect(messages.filter((message) => message.kind === "input")).toHaveLength(2);
  });
});
