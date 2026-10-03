import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDedicatedHardwareSdkDirectoryIntegrity,
  createDedicatedHardwareSdkManifestIntegrity,
  resolveDedicatedHardwareSdkIdentity,
  type DedicatedHardwareSdkLock,
  type DedicatedHardwareSdkRuntimeTarget
} from "../dedicated-hardware-sdk.js";
import { loadDedicatedHardwareStagedAdapter } from "./utility-entry.js";
import { createDefaultDedicatedHardwareSettings } from "./settings.js";

const cleanups: string[] = [];
const runtimeTarget: DedicatedHardwareSdkRuntimeTarget = {
  platform: process.platform as DedicatedHardwareSdkRuntimeTarget["platform"],
  architecture: process.arch as DedicatedHardwareSdkRuntimeTarget["architecture"],
  electronModulesAbi: Number(process.versions.modules),
  nodeApiVersion: Number(process.versions.napi)
};

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("dedicated hardware utility SDK admission", () => {
  it("reverifies the complete handed identity immediately before importing the staged entry", async () => {
    const staged = await stageAdapter();
    const identity = await resolveDedicatedHardwareSdkIdentity({
      stagingDirectory: staged.root,
      approvedArtifacts: [staged.lock],
      runtimeTarget
    });
    if (identity.kind !== "staged") throw new Error("Expected a staged identity.");
    const sink = { publishState: vi.fn(), publishInput: vi.fn() };
    const adapter = await loadDedicatedHardwareStagedAdapter(identity, sink);
    expect(await adapter.setDesiredState("codex-micro", {
      settings: { ...createDefaultDedicatedHardwareSettings("codex-micro"), enabled: true },
      preview: false
    })).toMatchObject({
      model: "codex-micro", status: "connected", transport: "usb", firmwareVersion: "1.2.3",
      keymapDeviceFirmwareIdentity: null
    });
    await adapter.stop();

    await writeFile(resolve(staged.root, staged.lock.entry.relativePath), "export const replaced = true;\n");
    await expect(loadDedicatedHardwareStagedAdapter(identity, sink))
      .rejects.toThrow("identity could not be reverified");
  });
});

async function stageAdapter(): Promise<Readonly<{ root: string; lock: DedicatedHardwareSdkLock }>> {
  const parent = await mkdtemp(join(tmpdir(), "joko-sdk-utility-"));
  cleanups.push(parent);
  const root = resolve(parent, "dedicated-hardware-sdk");
  await mkdir(resolve(root, "native"), { recursive: true });
  const payloads = [
    { relativePath: "LICENSE.vendor.txt", bytes: new TextEncoder().encode("licensed fixture\n") },
    {
      relativePath: "adapter.mjs",
      bytes: new TextEncoder().encode([
        "export const DeviceType = { CodexMicro: 1, CreatorMicroV2: 2 };",
        "export class WLDeviceDiscovery {",
        "  findWLDevices(filter) { return [{ isUsbConnection: true, serialNumber: 'controlled-device-a' }]; }",
        "}",
        "export class WLDeviceCommImpl {",
        "  rpcResponse = '';",
        "  async connect(device) { return true; }",
        "  async disconnect() {}",
        "  parseRpcData(data) { return false; }",
        "}",
        "export class RPCApiOAI {",
        "  api = {",
        "    async readFile(name) { return { ok: true, value: '{\"profiles\":[{\"layers\":[{\"layout\":{}}]}]}' }; },",
        "    async writeFile(name, contents) { return { ok: true, value: null }; }",
        "  };",
        "  constructor(comm, logger) {}",
        "  async getDeviceStatus() { return { ok: true, value: { firmwareVersion: '1.2.3', batteryPercentage: 71, isCharging: false, profileIndex: 0, layerIndex: 1 } }; }",
        "  async sendLightingConfig(config) { return { ok: true, value: null }; }",
        "  async sendThreadsLighting(threads) { return { ok: true, value: null }; }",
        "  onHidReceived(listener) { return () => {}; }",
        "  onJoystickMove(listener) { return () => {}; }",
        "}",
        ""
      ].join("\n"))
    },
    { relativePath: "native/device.node", bytes: new TextEncoder().encode("native fixture bytes\n") }
  ].sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  for (const payload of payloads) await writeFile(resolve(root, ...payload.relativePath.split("/")), payload.bytes);
  const files = payloads.map((payload) => ({
    relativePath: payload.relativePath,
    size: payload.bytes.byteLength,
    integrity: integrity(payload.bytes)
  }));
  const file = (relativePath: string) => files.find((candidate) => candidate.relativePath === relativePath)!;
  const withoutManifestIntegrity = {
    version: 1 as const,
    packageName: "@worklouder/device-kit-oai" as const,
    packageVersion: "0.2.1",
    redistributionGrantId: "utility-test-grant",
    license: { relativePath: "LICENSE.vendor.txt", integrity: file("LICENSE.vendor.txt").integrity },
    target: runtimeTarget,
    entry: { relativePath: "adapter.mjs", integrity: file("adapter.mjs").integrity },
    nativeAddons: [{
      identity: "@vendor/device-native@0.2.1",
      relativePath: "native/device.node",
      integrity: file("native/device.node").integrity,
      abi: "electron-modules" as const
    }],
    files,
    directoryIntegrity: createDedicatedHardwareSdkDirectoryIntegrity(payloads.map((payload, index) => ({
      ...files[index]!, bytes: payload.bytes
    })))
  };
  const lock: DedicatedHardwareSdkLock = Object.freeze({
    ...withoutManifestIntegrity,
    manifestIntegrity: createDedicatedHardwareSdkManifestIntegrity(withoutManifestIntegrity)
  });
  await writeFile(resolve(root, "joko-dedicated-hardware-sdk.lock.json"), JSON.stringify(lock));
  return Object.freeze({ root, lock });
}

function integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
