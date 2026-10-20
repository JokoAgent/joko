import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveDedicatedHardwareRuntime, reverifyDedicatedHardwareRuntime } from "./dedicated-hardware-runtime.js";
import { parseDedicatedHardwareUtilityRequest } from "./dedicated-hardware/protocol.js";
import { loadDedicatedHardwareAdapter } from "./dedicated-hardware/utility-entry.js";
import { createDefaultDedicatedHardwareSettings } from "./dedicated-hardware/settings.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("installed hardware runtime", () => {
  it("loads the installed SDK's nested filesystem API for a Bluetooth Creator", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-creator-sdk-"));
    directories.push(root);
    const sdk = join(root, "sdk");
    const kit = join(sdk, "node_modules", "@worklouder", "wl-device-kit");
    await mkdir(kit, { recursive: true });
    await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@worklouder/device-kit-oai",
      version: "0.2.1", main: "index.cjs" }));
    await writeFile(join(kit, "package.json"), JSON.stringify({ name: "@worklouder/wl-device-kit", main: "index.cjs" }));
    await writeFile(join(kit, "index.cjs"), [
      "exports.WLRPCApi = class {",
      "  constructor(comm) { this.comm = comm; }",
      "  async readFile() { return { ok: true, value: this.comm.contents }; }",
      "  async writeFile(name, contents) { this.comm.contents = contents; return { ok: true, value: null }; }",
      "};"
    ].join("\n"));
    await writeFile(join(sdk, "index.cjs"), [
      "exports.DeviceType = { CodexMicro: 1, CreatorMicroV2: 2 };",
      "exports.WLDeviceDiscovery = class { findWLDevices(filter) { return filter[0] === 2 ? [{ isUsbConnection: false, serialNumber: 'controlled-creator' }] : []; } };",
      "exports.WLDeviceCommImpl = class {",
      "  contents = JSON.stringify({ profiles: [{ layers: [{ layout: { keymap: [['factory']] } }] }] });",
      "  async connect() { return true; }",
      "  async disconnect() {}",
      "  parseRpcData() { return false; }",
      "};",
      "exports.RPCApiOAI = class {",
      "  async getDeviceStatus() { return { version: '1.2.3', battery: 71, is_charging: false, profile_index: 0, layer_index: 1 }; }",
      "  async sendLightingConfig() { return { ok: true }; }",
      "  async sendThreadsLighting() { return { ok: true }; }",
      "  onHidReceived() { return () => {}; }",
      "  onJoystickMove() { return () => {}; }",
      "};"
    ].join("\n"));
    const identity = await resolveDedicatedHardwareRuntime({ stagingDirectory: join(root, "absent-staging"),
      nativeDirectory: join(root, "absent-native"), packageDirectories: [sdk] });
    if (identity.kind !== "installed") throw new Error("Expected installed hardware runtime.");
    const adapter = await loadDedicatedHardwareAdapter(identity, { publishState() {}, publishInput() {} });
    try {
      expect(await adapter.setDesiredState("creator-micro-2", {
        settings: { ...createDefaultDedicatedHardwareSettings("creator-micro-2"), enabled: true }, preview: false
      })).toMatchObject({ status: "connected", transport: "bluetooth", firmwareVersion: "1.2.3" });
      const device = await adapter.creatorKeymap.readDeviceFirmwareIdentity();
      const original = await adapter.creatorKeymap.readCurrent(device);
      expect(adapter.creatorKeymap.buildManaged(original, ["AG00"])).toContain("KV_OAI_AG00");
    } finally { await adapter.stop(); }
  });

  it("admits an installed package without a redistribution lock and detects replacement before utility loading", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-local-hardware-"));
    directories.push(root);
    const sdk = join(root, "sdk");
    await mkdir(sdk);
    await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@worklouder/device-kit-oai",
      version: "0.2.1", main: "index.cjs" }));
    await writeFile(join(sdk, "index.cjs"), [
      "exports.DeviceType = { CodexMicro: 1, CreatorMicroV2: 2 };",
      "exports.WLDeviceDiscovery = class { findWLDevices() { return []; } };",
      "exports.WLDeviceCommImpl = class {};",
      "exports.RPCApiOAI = class {};"
    ].join("\n"));
    const identity = await resolveDedicatedHardwareRuntime({ stagingDirectory: join(root, "absent-staging"),
      nativeDirectory: join(root, "absent-native"), packageDirectories: [sdk] });
    expect(identity).toMatchObject({ kind: "installed", packageDirectory: sdk, packageVersion: "0.2.1" });
    if (identity.kind !== "installed") throw new Error("Expected installed hardware runtime.");
    const request = { version: 1, generation: 1, requestId: "1", kind: "handshake", sdk: identity,
      keymapBackupDirectory: join(root, "keymap") };
    expect(parseDedicatedHardwareUtilityRequest(request)?.kind).toBe("handshake");
    expect(parseDedicatedHardwareUtilityRequest({ ...request, sdk: { ...identity, token: "unexpected" } })).toBeUndefined();
    expect(await reverifyDedicatedHardwareRuntime(identity)).toBe(true);
    const sink = { publishState() {}, publishInput() {} };
    const adapter = await loadDedicatedHardwareAdapter(identity, sink);
    expect(await adapter.setDesiredState("codex-micro", {
      settings: { ...createDefaultDedicatedHardwareSettings("codex-micro"), enabled: true }, preview: false
    })).toMatchObject({ status: "not-detected", devicePresent: false });
    await adapter.stop();
    await writeFile(join(sdk, "index.cjs"), "throw new Error('replaced entry must not run');");
    expect(await reverifyDedicatedHardwareRuntime(identity)).toBe(false);
    await expect(loadDedicatedHardwareAdapter(identity, sink)).rejects.toThrow("changed before loading");
  });
});
