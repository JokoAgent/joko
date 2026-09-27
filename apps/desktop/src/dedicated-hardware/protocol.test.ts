import { describe, expect, it } from "vitest";

import { createDedicatedHardwareSdkManifestIntegrity } from "../dedicated-hardware-sdk.js";
import {
  decodeDedicatedHardwareUtilityMessage,
  decodeDedicatedHardwareUtilityRequest,
  encodeDedicatedHardwareUtilityRequest,
  parseDedicatedHardwareSdkIdentity,
  parseDedicatedHardwareUtilityMessage,
  parseDedicatedHardwareUtilityRequest
} from "./protocol.js";
import { createDefaultDedicatedHardwareSettings } from "./settings.js";

describe("dedicated hardware utility protocol", () => {
  it("accepts explicit unavailable or fully locked staged SDK identity and no path-only shape", () => {
    const keymapBackupDirectory = process.platform === "win32" ? "D:\\Joko\\keymap" : "/tmp/joko-keymap";
    const unavailable = {
      version: 1, generation: 1, requestId: "g1:1", kind: "handshake", sdk: { kind: "unavailable" }, keymapBackupDirectory
    } as const;
    expect(parseDedicatedHardwareUtilityRequest(unavailable)).toEqual(unavailable);

    const integrity = `sha512-${"A".repeat(86)}==`;
    const manifestWithoutIntegrity = {
      version: 1 as const,
      packageName: "@worklouder/device-kit-oai" as const,
      packageVersion: "0.1.11",
      redistributionGrantId: "approved-grant",
      license: { relativePath: "LICENSE.vendor.txt", integrity },
      target: {
        platform: "win32" as const,
        architecture: "x64" as const,
        electronModulesAbi: 148,
        nodeApiVersion: 10
      },
      entry: { relativePath: "adapter.mjs", integrity },
      nativeAddons: [{
        identity: "@vendor/device-native@0.1.11",
        relativePath: "native/device.node",
        integrity,
        abi: "electron-modules" as const
      }],
      files: [
        { relativePath: "LICENSE.vendor.txt", size: 1, integrity },
        { relativePath: "adapter.mjs", size: 1, integrity },
        { relativePath: "native/device.node", size: 1, integrity }
      ],
      directoryIntegrity: integrity
    };
    const manifest = {
      ...manifestWithoutIntegrity,
      manifestIntegrity: createDedicatedHardwareSdkManifestIntegrity(manifestWithoutIntegrity)
    };
    const staged = {
      version: 1,
      generation: 2,
      requestId: "g2:1",
      kind: "handshake",
      sdk: {
        kind: "staged",
        stagingDirectory: process.platform === "win32" ? "D:\\Joko\\runtime\\device-kit" : "/opt/joko/device-kit",
        manifest
      },
      keymapBackupDirectory
    } as const;
    expect(parseDedicatedHardwareSdkIdentity(staged.sdk)).toEqual(staged.sdk);
    expect(parseDedicatedHardwareSdkIdentity({ ...staged.sdk, legacyEntryPath: staged.sdk.stagingDirectory }))
      .toBeUndefined();
    expect(parseDedicatedHardwareSdkIdentity({ kind: "unavailable", stagingDirectory: staged.sdk.stagingDirectory }))
      .toBeUndefined();
    expect(decodeDedicatedHardwareUtilityRequest(encodeDedicatedHardwareUtilityRequest(staged))).toEqual(staged);
    expect(parseDedicatedHardwareUtilityRequest({
      version: 1, generation: 1, requestId: "g1:1", kind: "handshake", sdkEntryPath: staged.sdk.stagingDirectory
    })).toBeUndefined();
    expect(parseDedicatedHardwareUtilityRequest({
      ...staged, sdk: { ...staged.sdk, manifest: { ...manifest, packageName: "device-kit" } }
    })).toBeUndefined();
    expect(parseDedicatedHardwareUtilityRequest({
      ...staged, sdk: { ...staged.sdk, manifest: { ...manifest, manifestIntegrity: "latest" } }
    })).toBeUndefined();
  });

  it("parses only exact bounded desired-state, probe, and shutdown requests", () => {
    const settings = createDefaultDedicatedHardwareSettings("creator-micro-2");
    const desired = {
      version: 1, generation: 8, requestId: "g8:2", kind: "set-desired-state",
      model: "creator-micro-2", settings, preview: true
    } as const;
    expect(parseDedicatedHardwareUtilityRequest(desired)).toEqual(desired);
    expect(parseDedicatedHardwareUtilityRequest({ ...desired, settings: { ...settings, extra: true } })).toBeUndefined();
    expect(parseDedicatedHardwareUtilityRequest({ ...desired, preview: 1 })).toBeUndefined();
    expect(parseDedicatedHardwareUtilityRequest({
      version: 1, generation: 8, requestId: "g8:3", kind: "probe", model: "codex-micro"
    })).toBeDefined();
    expect(parseDedicatedHardwareUtilityRequest({
      version: 1, generation: 8, requestId: "g8:4", kind: "shutdown"
    })).toBeDefined();
    expect(parseDedicatedHardwareUtilityRequest({
      version: 1, generation: 0, requestId: "bad id", kind: "shutdown"
    })).toBeUndefined();
  });

  it("parses all bounded connection metadata without accepting extra diagnostic text", () => {
    const state = {
      version: 1,
      generation: 3,
      kind: "state",
      model: "codex-micro",
      status: "connected",
      reason: null,
      devicePresent: true,
      transport: "usb",
      firmwareVersion: "1.2.3",
      batteryPercent: 87,
      charging: false,
      inputPermission: "not-required",
      keymap: null
    } as const;
    expect(parseDedicatedHardwareUtilityMessage(state)).toEqual(state);
    for (const reason of [
      "sdk-unavailable", "permission-required", "device-in-use", "connection-timeout",
      "host-crash", "device-disconnected"
    ] as const) {
      expect(parseDedicatedHardwareUtilityMessage({ ...state, status: "error", reason })).toBeDefined();
    }
    expect(parseDedicatedHardwareUtilityMessage({ ...state, batteryPercent: 101 })).toBeUndefined();
    expect(parseDedicatedHardwareUtilityMessage({ ...state, detail: "native error" })).toBeUndefined();
    expect(parseDedicatedHardwareUtilityMessage({ ...state, firmwareVersion: "x".repeat(129) })).toBeUndefined();
  });

  it("strictly bounds key, stick, and encoder input previews", () => {
    const base = { version: 1 as const, generation: 4, kind: "input" as const, model: "creator-micro-2" as const };
    expect(parseDedicatedHardwareUtilityMessage({
      ...base, sequence: 0, input: { kind: "key", key: "AG00", pressed: true }
    })).toBeDefined();
    expect(parseDedicatedHardwareUtilityMessage({
      ...base, sequence: 1, input: { kind: "stick", x: -1, y: 1, pressed: false }
    })).toBeDefined();
    expect(parseDedicatedHardwareUtilityMessage({
      ...base, sequence: 2, input: { kind: "encoder", delta: -1, pressed: false }
    })).toBeDefined();
    expect(parseDedicatedHardwareUtilityMessage({
      ...base, sequence: 3, input: { kind: "stick", x: 1.01, y: 0, pressed: false }
    })).toBeUndefined();
    expect(parseDedicatedHardwareUtilityMessage({
      ...base, sequence: 4, input: { kind: "encoder", delta: 2, pressed: false }
    })).toBeUndefined();
    expect(parseDedicatedHardwareUtilityMessage({
      ...base, sequence: 5, input: { kind: "key", key: "ACT10_ACT11", pressed: true }
    })).toBeUndefined();
  });

  it("rejects malformed, non-UTF8, and oversized frames before publication", () => {
    expect(decodeDedicatedHardwareUtilityMessage("{not-json")).toBeUndefined();
    expect(decodeDedicatedHardwareUtilityMessage(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
    expect(decodeDedicatedHardwareUtilityMessage(`{"padding":"${"x".repeat(33 * 1024)}"}`)).toBeUndefined();
  });
});
