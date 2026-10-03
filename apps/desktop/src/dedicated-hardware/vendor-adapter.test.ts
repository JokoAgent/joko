import { afterEach, describe, expect, it, vi } from "vitest";

import { createDedicatedHardwareSdkManifestIntegrity } from "../dedicated-hardware-sdk.js";
import type {
  DedicatedHardwareKeymapBackup,
  DedicatedHardwareKeymapBackupStore
} from "./keymap-controller.js";
import type { DedicatedHardwareModelId } from "./settings.js";
import { createDefaultDedicatedHardwareSettings } from "./settings.js";
import type {
  DedicatedHardwareSdkIdentity,
  DedicatedHardwareLightingState,
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
      layout: model === CREATOR ? { ...defaults.layout, taskKeys: ["AG03", "ACT10"] as const } : defaults.layout
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
  let lightingResult: unknown = { ok: true, value: null };
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
    readonly sendLightingConfig = vi.fn(async (_config: unknown) => {
      order.push("lighting-config");
      return lightingResult;
    });
    readonly sendThreadsLighting = vi.fn(async (_threads: unknown) => {
      order.push("lighting-threads");
      return { ok: true, value: null };
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
    setLightingResult: (value: unknown) => { lightingResult = value; },
    setConnectResult: (value: boolean) => { connectResult = value; },
    setSerialNumber: (value: string | undefined) => { serialNumber = value; }
  };
}

function sinkFixture() {
  return { publishState: vi.fn(), publishInput: vi.fn() } satisfies DedicatedHardwareUtilityAdapterSink;
}

function lightingState(phase: "running" | "completed" = "running"): DedicatedHardwareLightingState {
  return {
    version: 1, taskSlots: [{ phase, attention: false }, null, null, null, null, null],
    revealOccurrence: "0", primaryVisible: false
  };
}

async function settleLighting(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
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
  afterEach(() => vi.useRealTimers());

  it("spends a bounded stop budget waiting for the real lighting RPC and disconnects without racing an off write", async () => {
    vi.useFakeTimers();
    const fixture = sdkFixture();
    let release!: (value: unknown) => void;
    fixture.setLightingResult(new Promise((resolve) => { release = resolve; }));
    const adapter = createDedicatedHardwareVendorAdapter({ sdk: fixture.sdk, sink: sinkFixture(), platform: "win32" });
    adapter.setLightingState(CODEX, lightingState());
    await adapter.setDesiredState(CODEX, desired(CODEX));
    const api = fixture.apis[0]!;
    expect(api.sendLightingConfig).toHaveBeenCalledOnce();
    const stopped = adapter.stop().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(499);
    expect(fixture.comms[0]!.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await stopped).toBeInstanceOf(Error);
    expect(fixture.comms[0]!.disconnect).toHaveBeenCalledOnce();
    expect(api.sendLightingConfig).toHaveBeenCalledOnce();
    expect(api.sendThreadsLighting).not.toHaveBeenCalled();
    release({ ok: true, value: null });
    await settleLighting();
    expect(api.sendThreadsLighting).not.toHaveBeenCalled();
  });

  it("caches lighting without connecting and fences the second shared-API write after disable while retaining HID on RPC failure", async () => {
    const fixture = sdkFixture();
    const sink = sinkFixture();
    let release!: (value: unknown) => void;
    fixture.setLightingResult(new Promise((resolve) => { release = resolve; }));
    const adapter = createDedicatedHardwareVendorAdapter({ sdk: fixture.sdk, sink, platform: "win32" });
    try {
      adapter.setLightingState(CODEX, lightingState());
      expect(fixture.comms).toHaveLength(0);
      await adapter.setDesiredState(CODEX, desired(CODEX));
      const api = fixture.apis[0]!;
      expect(fixture.apis).toHaveLength(1);
      expect(api.sendLightingConfig).toHaveBeenCalledOnce();
      expect(api.sendThreadsLighting).not.toHaveBeenCalled();
      const disable = adapter.setDesiredState(CODEX, desired(CODEX, false));
      release({ ok: true, value: null });
      expect((await disable).status).toBe("disabled");
      await settleLighting();
      expect(api.sendThreadsLighting).toHaveBeenCalledOnce();
      expect(api.sendLightingConfig.mock.lastCall).toEqual([expect.objectContaining({
        ambient: expect.objectContaining({ brightness: 0 }), keys: expect.objectContaining({ brightness: 0 })
      })]);
      expect(fixture.comms[0]!.disconnect).not.toHaveBeenCalled();

      fixture.setLightingResult({ ok: false, value: null });
      await adapter.setDesiredState(CODEX, desired(CODEX));
      await settleLighting();
      expect(api.sendLightingConfig).toHaveBeenCalledTimes(3);
      expect(api.sendThreadsLighting).toHaveBeenCalledOnce();
      await settleLighting();
      expect(api.sendLightingConfig).toHaveBeenCalledTimes(3);
      api.emitHid({ key: "AG00", act: 1 });
      expect(sink.publishInput).toHaveBeenLastCalledWith(CODEX, { kind: "key", key: "AG00", pressed: true });
    } finally {
      fixture.setLightingResult({ ok: true, value: null });
      await adapter.stop();
    }
  });

  it("records disabled off timeout while retaining the maintenance connection and fencing the unfinished off before re-enable", async () => {
    vi.useFakeTimers();
    const fixture = sdkFixture();
    const sink = sinkFixture();
    const adapter = createDedicatedHardwareVendorAdapter({ sdk: fixture.sdk, sink, platform: "win32" });
    adapter.setLightingState(CODEX, lightingState());
    await adapter.setDesiredState(CODEX, desired(CODEX));
    await settleLighting();
    const api = fixture.apis[0]!;
    let release!: (value: unknown) => void;
    fixture.setLightingResult(new Promise((resolve) => { release = resolve; }));
    const disable = adapter.setDesiredState(CODEX, desired(CODEX, false));
    await vi.advanceTimersByTimeAsync(500);
    expect(await disable).toMatchObject({ status: "error", reason: "connection-timeout" });
    expect(fixture.comms[0]!.disconnect).not.toHaveBeenCalled();
    api.emitHid({ key: "AG00", act: 1 });
    expect(sink.publishInput).not.toHaveBeenCalled();
    expect(api.sendLightingConfig).toHaveBeenCalledTimes(2);
    await adapter.setDesiredState(CODEX, desired(CODEX));
    await settleLighting();
    expect(api.sendLightingConfig).toHaveBeenCalledTimes(2);
    fixture.setLightingResult({ ok: true, value: null });
    release({ ok: true, value: null });
    await settleLighting();
    adapter.setLightingState(CODEX, lightingState("completed"));
    await settleLighting();
    expect(api.sendLightingConfig).toHaveBeenCalledTimes(3);
    await adapter.stop();
  });

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
    await handler.handle({
      version: 1, generation: 1, requestId: "g1:2", kind: "set-lighting-state", model: CREATOR, state: lightingState()
    });
    expect(messages.at(-1)).toMatchObject({ kind: "ack", requestId: "g1:2" });
    expect(fixture.comms).toHaveLength(0);
    const enabled = desired(CREATOR);
    const occupy = handler.handle({
      version: 1, generation: 1, requestId: "g1:3", kind: "set-desired-state", model: CREATOR, ...enabled
    });
    await settleStarted;
    const api = fixture.apis.at(-1)!;
    expect(api.sendLightingConfig).not.toHaveBeenCalled();
    api.emitHid({ key: "AG00", act: 1 });
    expect(messages.filter((message) => message.kind === "input")).toHaveLength(0);
    expect([...backup.sessions.values()][0]?.contents).toBe(ORIGINAL);
    expect(fixture.order.indexOf("save-backup")).toBeLessThan(fixture.order.indexOf("write-managed"));
    releaseSettle();
    await occupy;
    await settleLighting();
    expect(api.sendLightingConfig).toHaveBeenCalledOnce();
    expect(api.sendThreadsLighting).toHaveBeenCalledOnce();
    const writes = api.api.writeFile.mock.calls.length;
    let releaseLighting!: (value: unknown) => void;
    fixture.setLightingResult(new Promise((resolve) => { releaseLighting = resolve; }));
    await handler.handle({
      version: 1, generation: 1, requestId: "g1:4", kind: "set-lighting-state", model: CREATOR,
      state: lightingState("completed")
    });
    expect(messages.at(-1)).toMatchObject({ kind: "ack", requestId: "g1:4" });
    expect(api.api.writeFile).toHaveBeenCalledTimes(writes);
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
      version: 1, generation: 1, requestId: "g1:5", kind: "set-desired-state", model: CODEX, ...desired(CODEX)
    });
    const codexApi = fixture.apis.find((candidate) => candidate.comm.model === CODEX)!;
    const disable = handler.handle({
      version: 1, generation: 1, requestId: "g1:6", kind: "set-desired-state", model: CREATOR, ...desired(CREATOR, false)
    });
    await settleLighting();
    expect(api.api.writeFile).toHaveBeenCalledTimes(writes);
    fixture.setLightingResult({ ok: true, value: null });
    releaseLighting({ ok: true, value: null });
    await disable;
    expect(fixture.current()).toBe(ORIGINAL);
    expect(backup.sessions.size).toBe(0);
    const restoredAt = fixture.order.indexOf("write-original");
    const restoreConfirmation = fixture.order.indexOf("read-keymap", restoredAt + 1);
    expect(restoreConfirmation).toBeGreaterThan(restoredAt);
    expect(fixture.order.indexOf("clear-backup")).toBeGreaterThan(restoreConfirmation);
    expect(api.sendLightingConfig.mock.lastCall).toEqual([expect.objectContaining({
      ambient: expect.objectContaining({ brightness: 0 }), keys: expect.objectContaining({ brightness: 0 })
    })]);
    expect(fixture.order.lastIndexOf("lighting-config")).toBeGreaterThan(fixture.order.indexOf("clear-backup"));
    expect(fixture.comms.every((comm) => comm.disconnect.mock.calls.length === 0)).toBe(true);
    expect(messages).toContainEqual(expect.objectContaining({
      kind: "state", model: CREATOR, status: "disabled",
      keymap: { phase: "idle", backupAvailable: false, failure: null }
    }));
    api.emitHid({ key: "AG00", act: 1 });
    expect(messages.filter((message) => message.kind === "input")).toHaveLength(2);
    codexApi.emitHid({ key: "AG00", act: 1 });
    expect(messages.at(-1)).toMatchObject({ kind: "input", model: CODEX, input: { pressed: true } });
    await expect(handler.handle({ version: 1, generation: 1, requestId: "g1:7", kind: "shutdown" }))
      .resolves.toBe("stopped");
    expect(fixture.order.lastIndexOf("disconnect")).toBeGreaterThan(fixture.order.indexOf("clear-backup"));
    api.emitHid({ key: "AG01", act: 1 });
    expect(messages.filter((message) => message.kind === "input")).toHaveLength(3);
  });
});
