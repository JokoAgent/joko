import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AutomationPermissionState,
  CapabilitySupport,
  ComputerAutomationRuntimeState,
  ComputerAutomationUpdatePhase
} from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ComputerAutomationSettingsController,
  type ComputerAutomationProbe,
  type ComputerAutomationRuntime,
  type ComputerAutomationUpdateCheck
} from "./computer-automation-settings.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("ComputerAutomationSettingsController", () => {
  it("keeps opt-in separate from installed and runtime readiness", async () => {
    const fixture = createFixture({ probe: readyProbe({ daemonRunning: false, ready: false }) });
    await fixture.controller.probe(true);
    expect(fixture.controller.snapshot()).toMatchObject({
      enabled: false,
      installed: true,
      daemonRunning: false,
      ready: false,
      runtimeState: ComputerAutomationRuntimeState.DISABLED
    });
  });

  it("installs missing runtime before persisting enable and refreshes only future generations", async () => {
    const fixture = createFixture({
      probe: missingProbe(),
      afterInstall: readyProbe(),
      refreshGeneration: async () => { fixture.calls.push("refresh"); }
    });
    const updated = await fixture.controller.setEnabled(true);
    expect(fixture.calls).toEqual(["probe", "install", "probe", "refresh"]);
    expect(updated).toMatchObject({
      enabled: true,
      support: CapabilitySupport.SUPPORTED,
      installed: true,
      ready: true,
      accessibilityPermission: AutomationPermissionState.NOT_REQUIRED
    });
    expect(fixture.store.getSetting("service", "orchestrator", "settings.automation.computer").value)
      .toEqual({ format: 1, enabled: true });
  });

  it("runs the system permission flow before refusing an incomplete enable", async () => {
    const fixture = createFixture({
      probe: readyProbe({
        platform: "darwin",
        accessibilityPermission: "missing",
        screenRecordingPermission: "granted",
        ready: false,
        failureReason: "Accessibility permission is required."
      })
    });
    await expect(fixture.controller.setEnabled(true)).rejects.toThrow("Accessibility permission is required");
    expect(fixture.controller.enabled()).toBe(false);
    expect(fixture.calls).toEqual(["probe", "permission:all", "probe"]);
  });

  it("installs, grants required system access, and persists one macOS enable flow", async () => {
    const fixture = createFixture({
      probe: missingProbe({ platform: "darwin" }),
      afterInstall: readyProbe({
        platform: "darwin",
        accessibilityPermission: "missing",
        screenRecordingPermission: "missing",
        screenRecordingCapturable: false,
        ready: false
      }),
      afterPermission: readyProbe({ platform: "darwin" })
    });
    const updated = await fixture.controller.setEnabled(true);
    expect(fixture.calls).toEqual(["probe", "install", "probe", "permission:all", "probe"]);
    expect(updated.enabled).toBe(true);
    expect(updated.ready).toBe(true);
  });

  it("routes explicit permission requests and refreshes the cached projection", async () => {
    const fixture = createFixture({
      probe: readyProbe({
        platform: "darwin",
        accessibilityPermission: "missing",
        screenRecordingPermission: "missing",
        ready: false
      }),
      afterPermission: readyProbe({ platform: "darwin" })
    });
    const updated = await fixture.controller.requestPermission("accessibility");
    expect(fixture.calls).toEqual(["permission:accessibility", "probe"]);
    expect(updated.accessibilityPermission).toBe(AutomationPermissionState.GRANTED);
  });

  it("opens a fixed permission capability separately and forwards cancellation immediately", async () => {
    const cancelPermissionRequest = vi.fn();
    const fixture = createFixture({
      probe: readyProbe({ platform: "darwin" }),
      cancelPermissionRequest
    });

    await fixture.controller.openPermissionSettings("accessibility");
    fixture.controller.cancelPermissionRequest();

    expect(fixture.calls).toEqual(["open-settings:accessibility"]);
    expect(cancelPermissionRequest).toHaveBeenCalledOnce();
  });

  it("publishes runtime readiness changes to sessions created after a probe", async () => {
    const fixture = createFixture({
      probe: readyProbe(),
      refreshGeneration: async () => { fixture.calls.push("refresh"); }
    });
    await fixture.controller.setEnabled(true);
    fixture.calls.length = 0;
    fixture.setProbe(readyProbe({ daemonRunning: false, ready: false, failureReason: "Driver stopped." }));

    await fixture.controller.probe(true);

    expect(fixture.calls).toEqual(["probe", "refresh"]);
    expect(fixture.controller.availableForNewSessions()).toBe(false);
  });

  it("keeps update discovery quiet and completes a version-pinned runtime update with progress", async () => {
    const fixture = createFixture({
      probe: readyProbe({ driverVersion: "1.2.3" }),
      updateCheck: {
        currentVersion: "1.2.3",
        latestVersion: "1.3.0",
        updateAvailable: true,
        updating: false
      },
      afterUpdate: readyProbe({ driverVersion: "1.3.0" })
    });
    await fixture.controller.probe();

    await expect(fixture.controller.checkForUpdate()).resolves.toMatchObject({
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      updateAvailable: true,
      updating: false
    });
    expect(fixture.controller.snapshot()).toMatchObject({
      updateCurrentVersion: "1.2.3",
      updateLatestVersion: "1.3.0",
      updateAvailable: true,
      updateInProgress: false,
      updatePhase: ComputerAutomationUpdatePhase.UNSPECIFIED
    });
    const phases: string[] = [];
    await expect(fixture.controller.updateDriver({
      onProgress: (progress) => phases.push(progress.phase)
    })).resolves.toMatchObject({ driverVersion: "1.3.0" });

    expect(fixture.calls).toEqual(["probe", "check-update", "update", "probe"]);
    expect(phases).toEqual(["downloading", "installing", "done"]);
    expect(fixture.controller.updateSnapshot()).toEqual({ updateAvailable: false, updating: false });
    expect(fixture.controller.snapshot()).toMatchObject({
      updateCurrentVersion: "1.3.0",
      updateAvailable: false,
      updateInProgress: false,
      updatePhase: ComputerAutomationUpdatePhase.DONE
    });
  });
});

function createFixture(options: {
  readonly probe: ComputerAutomationProbe;
  readonly afterInstall?: ComputerAutomationProbe;
  readonly afterPermission?: ComputerAutomationProbe;
  readonly updateCheck?: ComputerAutomationUpdateCheck;
  readonly afterUpdate?: ComputerAutomationProbe;
  readonly refreshGeneration?: () => Promise<void>;
  readonly cancelPermissionRequest?: () => void;
}) {
  const root = mkdtempSync(join(tmpdir(), "joko-computer-automation-"));
  const store = new OperationalStore(join(root, "operational.sqlite"));
  const calls: string[] = [];
  let probe = options.probe;
  const runtime: ComputerAutomationRuntime = {
    async probe() {
      calls.push("probe");
      return probe;
    },
    async install() {
      calls.push("install");
      probe = options.afterInstall ?? probe;
    },
    async requestPermission(permission) {
      calls.push(`permission:${permission}`);
      probe = options.afterPermission ?? probe;
    },
    async openPermissionSettings(permission) {
      calls.push(`open-settings:${permission}`);
    },
    ...(options.cancelPermissionRequest === undefined
      ? {}
      : { cancelPermissionRequest: options.cancelPermissionRequest }),
    async checkForUpdate() {
      calls.push("check-update");
      return options.updateCheck ?? { updateAvailable: false, updating: false };
    },
    async updateDriver(updateOptions) {
      calls.push("update");
      updateOptions?.onProgress?.({ phase: "downloading", downloadedBytes: 10, totalBytes: 20 });
      updateOptions?.onProgress?.({ phase: "installing", downloadedBytes: null, totalBytes: 20 });
      probe = options.afterUpdate ?? probe;
      updateOptions?.onProgress?.({ phase: "done", downloadedBytes: null, totalBytes: null });
    }
  };
  const controller = new ComputerAutomationSettingsController({
    store,
    runtime,
    refreshGeneration: options.refreshGeneration
  });
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { controller, store, calls, setProbe: (value: ComputerAutomationProbe) => { probe = value; } };
}

function readyProbe(overrides: Partial<ComputerAutomationProbe> = {}): ComputerAutomationProbe {
  return {
    support: "supported",
    installed: true,
    driverVersion: "1.2.3",
    daemonRunning: true,
    accessibilityPermission: "granted",
    screenRecordingPermission: "granted",
    screenRecordingCapturable: true,
    ready: true,
    platform: "win32",
    ...overrides
  };
}

function missingProbe(overrides: Partial<ComputerAutomationProbe> = {}): ComputerAutomationProbe {
  return {
    support: "upstreamMissing",
    supportReason: "Driver not installed.",
    installed: false,
    daemonRunning: false,
    accessibilityPermission: "notRequired",
    screenRecordingPermission: "notRequired",
    screenRecordingCapturable: false,
    ready: false,
    platform: "win32",
    ...overrides
  };
}
