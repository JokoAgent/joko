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
