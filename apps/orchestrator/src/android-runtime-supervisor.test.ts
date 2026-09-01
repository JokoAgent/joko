import { describe, expect, it, vi } from "vitest";

import type {
  AndroidAutomationRuntime,
  AndroidAutomationRuntimeFactory,
  AndroidRuntimeStatus,
  AndroidToolProvider
} from "@joko/tool-android";

import { AndroidRuntimeSupervisor } from "./android-runtime-supervisor.js";

describe("AndroidRuntimeSupervisor", () => {
  it("constructs without probing and safely swaps runtime configuration", async () => {
    const first = runtimeFixture(statusFixture());
    const second = runtimeFixture(statusFixture({ selectedDeviceSerial: "device-2" }));
    const create = vi.fn(() => first.runtime);
    const reconfigure = vi.fn(async () => second.runtime);
    const factory = { create, reconfigure } as unknown as AndroidAutomationRuntimeFactory;
    const supervisor = new AndroidRuntimeSupervisor({ factory });

    expect(first.status).not.toHaveBeenCalled();
    const firstProvider = supervisor.provider();
    await supervisor.applyConfiguration({ defaultDeviceSerial: "device-2" });

    expect(reconfigure).toHaveBeenCalledWith(first.runtime, { defaultDeviceSerial: "device-2" }, undefined);
    expect(supervisor.provider()).not.toBe(firstProvider);
    expect((await supervisor.status()).defaultDeviceSerial).toBe("device-2");
  });

  it("prepares without listing devices and maps the following bounded public probe", async () => {
    const fixture = runtimeFixture(statusFixture());
    const factory = {
      create: () => fixture.runtime,
      reconfigure: vi.fn()
    } as unknown as AndroidAutomationRuntimeFactory;
    const supervisor = new AndroidRuntimeSupervisor({ factory });

    await supervisor.prepare();
    const status = await supervisor.status({ fresh: true });

    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.status).not.toHaveBeenCalled();
    expect(fixture.probe).toHaveBeenCalledWith({
      fresh: true,
      allowPreparation: true,
      signal: undefined
    });
    expect(status).toMatchObject({
      support: "supported",
      adbAvailable: true,
      adbPathSource: "prepared",
      preparationSupported: true,
      preparationReady: true,
      defaultDeviceSerial: "device-1",
      issue: "unspecified"
    });
  });

  it("forwards a disabled manual status as candidate-only without preparation", async () => {
    const fixture = runtimeFixture(statusFixture());
    const factory = {
      create: () => fixture.runtime,
      reconfigure: vi.fn()
    } as unknown as AndroidAutomationRuntimeFactory;
    const supervisor = new AndroidRuntimeSupervisor({ factory });

    await supervisor.status({ fresh: true, allowPreparation: false });

    expect(fixture.status).not.toHaveBeenCalled();
    expect(fixture.probe).toHaveBeenCalledWith({
      fresh: true,
      allowPreparation: false,
      signal: undefined
    });
  });

  it("forwards session cleanup and disposes the final runtime", async () => {
    const fixture = runtimeFixture(statusFixture());
    const factory = {
      create: () => fixture.runtime,
      reconfigure: vi.fn()
    } as unknown as AndroidAutomationRuntimeFactory;
    const supervisor = new AndroidRuntimeSupervisor({ factory });

    supervisor.closeSession("session-1");
    await supervisor.dispose();

    expect(fixture.closeSession).toHaveBeenCalledWith("session-1");
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(() => supervisor.provider()).toThrow("closed");
  });
});

function runtimeFixture(value: AndroidRuntimeStatus) {
  const status = vi.fn(async () => value);
  const prepare = vi.fn(async () => undefined);
  const probe = vi.fn(async () => value);
  const closeSession = vi.fn();
  const dispose = vi.fn(async () => undefined);
  const runtime = {
    status,
    prepare,
    probe,
    closeSession,
    dispose
  } as unknown as AndroidAutomationRuntime;
  return { runtime, status, prepare, probe, closeSession, dispose };
}

function statusFixture(overrides: Partial<AndroidRuntimeStatus> = {}): AndroidRuntimeStatus {
  return {
    supported: true,
    platform: "win32",
    architecture: "x64",
    installation: {
      state: "installed",
      executablePath: "adb.exe",
      pathSource: "prepared",
      version: "1.0.41",
      preparation: { supported: true, attempted: true, ready: true }
    },
    server: { state: "running", port: 5037, managedByRuntime: true },
    devices: [{ serial: "device-1", state: "device" }],
    selectedDeviceSerial: "device-1",
    activityState: "idle",
    ...overrides
  };
}
