import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AndroidAdbPathSource,
  AndroidAutomationIssue,
  AndroidAutomationRuntimeState,
  CapabilitySupport
} from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  AndroidAutomationSettingsController,
  type AndroidAutomationConfiguration,
  type AndroidAutomationProbe,
  type AndroidAutomationRuntimeController
} from "./android-automation-settings.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("AndroidAutomationSettingsController", () => {
  it("does not probe on mount or prepare while disabled, but allows an explicit fresh status", async () => {
    const fixture = createFixture();

    expect(fixture.controller.snapshot()).toMatchObject({
      enabled: false,
      support: CapabilitySupport.SUPPORTED,
      runtimeState: AndroidAutomationRuntimeState.DISABLED,
      statusObserved: false
    });
    await fixture.controller.prepare();
    expect(fixture.calls).toEqual([]);

    const refreshed = await fixture.controller.probe(true);

    expect(fixture.calls).toEqual(["configure:{}", "status:fresh"]);
    expect(fixture.statusRequests).toEqual([{
      fresh: true,
      allowPreparation: false,
      signal: undefined
    }]);
    expect(refreshed.statusObserved).toBe(true);
    expect(refreshed.devices).toHaveLength(1);
    expect(refreshed.runtimeState).toBe(AndroidAutomationRuntimeState.DISABLED);
    expect(fixture.controller.availableForNewSessions()).toBe(false);
  });

  it("persists and publishes opt-in before strict prepare then status", async () => {
    const fixture = createFixture({
      refreshGeneration: async () => {
        expect(fixture.store.getSetting("service", "orchestrator", "settings.automation.android").value)
          .toEqual({ format: 1, enabled: true });
        fixture.calls.push("refresh");
      }
    });

    const result = await fixture.controller.setEnabled(true);

    expect(fixture.calls).toEqual(["refresh", "configure:{}", "prepare", "status:cached"]);
    expect(result).toMatchObject({
      enabled: true,
      adbAvailable: true,
      adbPathSource: AndroidAdbPathSource.PREPARED,
      issue: AndroidAutomationIssue.UNSPECIFIED,
      runtimeState: AndroidAutomationRuntimeState.READY
    });
    expect(fixture.controller.availableForNewSessions()).toBe(true);
  });

  it("keeps opt-in durable and projects a bounded failure when preparation fails", async () => {
    const fixture = createFixture({ prepareError: new Error("platform-tools unavailable") });

    const result = await fixture.controller.setEnabled(true);

    expect(result.enabled).toBe(true);
    expect(result.runtimeState).toBe(AndroidAutomationRuntimeState.ERROR);
    expect(result.issue).toBe(AndroidAutomationIssue.DRIVER_ERROR);
    expect(result.preparationError).toBe("platform-tools unavailable");
    expect(fixture.store.getSetting("service", "orchestrator", "settings.automation.android").value)
      .toEqual({ format: 1, enabled: true });
  });

  it("persists device selection before applying it and refreshes status without changing grants", async () => {
    const fixture = createFixture();
    await fixture.controller.setEnabled(true);
    fixture.calls.length = 0;

    const result = await fixture.controller.selectDevice("emulator-5554");

    expect(fixture.calls).toEqual([
      'configure:{"defaultDeviceSerial":"emulator-5554"}',
      "status:fresh"
    ]);
    expect(result.configuredDefaultDeviceSerial).toBe("emulator-5554");
    expect(fixture.store.getSetting("service", "orchestrator", "settings.automation.android").value)
      .toEqual({ format: 1, enabled: true, defaultDeviceSerial: "emulator-5554" });
  });

  it("applies an absolute custom ADB path and restores automatic resolution", async () => {
    const fixture = createFixture();
    await fixture.controller.setEnabled(true);
    fixture.calls.length = 0;

    const custom = await fixture.controller.setAdbPath("D:\\tools\\adb.exe");
    expect(custom.adbPathOverride).toBe("D:\\tools\\adb.exe");
    expect(custom.adbPathSource).toBe(AndroidAdbPathSource.CUSTOM);
    expect(fixture.calls).toEqual([
      'configure:{"adbPathOverride":"D:\\\\tools\\\\adb.exe"}',
      "prepare",
      "status:cached"
    ]);

    fixture.calls.length = 0;
    const automatic = await fixture.controller.setAdbPath();
    expect(automatic.adbPathOverride).toBe("");
    expect(automatic.adbPathSource).toBe(AndroidAdbPathSource.PREPARED);
    expect(fixture.calls).toEqual(["configure:{}", "prepare", "status:cached"]);
  });

  it("turns off without probing and only changes future session grants", async () => {
    const fixture = createFixture({
      refreshGeneration: async () => { fixture.calls.push("refresh"); }
    });
    await fixture.controller.setEnabled(true);
    fixture.calls.length = 0;

    const result = await fixture.controller.setEnabled(false);

    expect(fixture.calls).toEqual(["refresh"]);
    expect(result.runtimeState).toBe(AndroidAutomationRuntimeState.DISABLED);
    expect(result.statusObserved).toBe(false);
    expect(result.devices).toEqual([]);
    expect(fixture.controller.availableForNewSessions()).toBe(false);

    const refreshed = await fixture.controller.probe(true);
    expect(fixture.calls).toEqual(["refresh", "status:fresh"]);
    expect(refreshed.statusObserved).toBe(true);
    expect(refreshed.devices).toHaveLength(1);
  });

  it("projects every connected device past the former 256-device window", async () => {
    const devices = Array.from({ length: 257 }, (_, index) => ({
      deviceSerial: `device-${index}`,
      state: "device",
      model: `Model_${index}`
    }));
    const fixture = createFixture({ probe: readyProbe({ devices, defaultDeviceSerial: "device-0" }) });

    const refreshed = await fixture.controller.probe(true);

    expect(refreshed.devices).toHaveLength(257);
    expect(refreshed.devices.at(-1)).toMatchObject({ deviceSerial: "device-256", model: "Model_256" });
  });

  it("rejects relative ADB paths before touching durable settings or runtime", async () => {
    const fixture = createFixture();
    await expect(fixture.controller.setAdbPath("tools/adb")).rejects.toThrow("absolute service-node path");
    expect(fixture.calls).toEqual([]);
    expect(fixture.store.getSetting("service", "orchestrator", "settings.automation.android").value)
      .toEqual({ format: 1, enabled: false });
  });
});

function createFixture(options: {
  readonly probe?: AndroidAutomationProbe;
  readonly prepareError?: Error;
  readonly refreshGeneration?: () => Promise<void>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "joko-android-automation-"));
  const store = new OperationalStore(join(root, "operational.sqlite"));
  const calls: string[] = [];
  const statusRequests: Array<{
    readonly fresh?: boolean;
    readonly allowPreparation?: boolean;
    readonly signal?: AbortSignal;
  }> = [];
  let configuration: AndroidAutomationConfiguration = {};
  const runtime: AndroidAutomationRuntimeController = {
    async applyConfiguration(value) {
      configuration = value;
      calls.push(`configure:${JSON.stringify(value)}`);
    },
    async prepare() {
      calls.push("prepare");
      if (options.prepareError !== undefined) throw options.prepareError;
    },
    async status(statusOptions) {
      statusRequests.push({
        fresh: statusOptions?.fresh,
        allowPreparation: statusOptions?.allowPreparation,
        signal: statusOptions?.signal
      });
      calls.push(`status:${statusOptions?.fresh === true ? "fresh" : "cached"}`);
      const value = options.probe ?? readyProbe();
      return {
        ...value,
        ...(configuration.defaultDeviceSerial === undefined
          ? {}
          : { defaultDeviceSerial: configuration.defaultDeviceSerial }),
        ...(configuration.adbPathOverride === undefined
          ? {}
          : { adbPath: configuration.adbPathOverride, adbPathSource: "custom" as const })
      };
    }
  };
  const controller = new AndroidAutomationSettingsController({
    store,
    runtime,
    refreshGeneration: options.refreshGeneration
  });
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { controller, store, calls, statusRequests };
}

function readyProbe(overrides: Partial<AndroidAutomationProbe> = {}): AndroidAutomationProbe {
  return {
    support: "supported",
    adbAvailable: true,
    adbPath: "adb.exe",
    adbPathSource: "prepared",
    preparationSupported: true,
    preparationReady: true,
    adbVersion: "1.0.41",
    devices: [{ deviceSerial: "emulator-5554", state: "device", model: "Pixel_8" }],
    defaultDeviceSerial: "emulator-5554",
    issue: "unspecified",
    platform: "win32",
    ...overrides
  };
}
