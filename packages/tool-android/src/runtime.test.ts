import { describe, expect, it, vi } from "vitest";

import type { AndroidAdbAdapter } from "./adb-adapter.js";
import {
  AndroidAutomationRuntime,
  normalizeAndroidPlatform,
  resolveAndroidAdbExecutable
} from "./runtime.js";
import {
  AndroidRuntimeError,
  type AndroidConnectedDevice,
  type AndroidDeviceSnapshot
} from "./types.js";

const READY_DEVICE: AndroidConnectedDevice = {
  serial: "emulator-5554",
  state: "device",
  model: "Pixel"
};

describe("AndroidAutomationRuntime status and resolution", () => {
  it("reports unsupported platforms without touching ADB", async () => {
    const adb = adapter();
    const runtime = new AndroidAutomationRuntime({ platform: "aix", adapter: adb });

    await expect(runtime.status()).resolves.toMatchObject({
      supported: false,
      platform: "unsupported",
      installation: { state: "unsupported" },
      issue: "unsupported_platform"
    });
    expect(adb.probe).not.toHaveBeenCalled();
    expect(normalizeAndroidPlatform("freebsd")).toBe("unsupported");
  });

  it("reports a missing executable with redacted diagnostics", async () => {
    const adb = adapter({
      probe: vi.fn(async () => {
        throw new Error("password=secret at D:\\private-home\\tools\\adb.exe");
      })
    });
    const runtime = new AndroidAutomationRuntime({
      platform: "win32",
      homeDirectory: "D:\\private-home",
      executablePath: "D:\\private-home\\tools\\adb.exe",
      adapter: adb,
      portProbe: async () => false
    });

    const status = await runtime.status();

    expect(status).toMatchObject({
      supported: true,
      installation: { state: "missing" },
      issue: "adb_not_found"
    });
    expect(status.error).toContain("password=[REDACTED]");
    expect(status.error).toContain("[PATH]\\tools\\adb.exe");
    expect(status.error).not.toContain("private-home");
  });

  it("reports installed state, default-device selection, and a redacted executable path", async () => {
    const adb = adapter({ listDevices: vi.fn(async () => [READY_DEVICE]) });
    const runtime = new AndroidAutomationRuntime({
      platform: "win32",
      architecture: "arm64",
      homeDirectory: "D:\\private-home",
      executablePath: "D:\\private-home\\tools\\adb.exe",
      pathSource: "bundled",
      defaultDeviceSerial: READY_DEVICE.serial,
      adapter: adb,
      portProbe: async () => true
    });

    await expect(runtime.status()).resolves.toEqual({
      supported: true,
      platform: "win32",
      architecture: "arm64",
      installation: {
        state: "installed",
        executablePath: "[PATH]\\tools\\adb.exe",
        pathSource: "bundled",
        version: "Android Debug Bridge 35"
      },
      server: { state: "running", port: 5037, managedByRuntime: false },
      devices: [READY_DEVICE],
      configuredDefaultDeviceSerial: READY_DEVICE.serial,
      selectedDeviceSerial: READY_DEVICE.serial,
      activityState: "idle"
    });
  });

  it("keeps preparation side-effect free from device enumeration", async () => {
    const adb = adapter({ listDevices: vi.fn(async () => [READY_DEVICE]) });
    const runtime = new AndroidAutomationRuntime({
      platform: "linux",
      adapter: adb,
      portProbe: async () => false
    });

    await runtime.prepare();

    expect(adb.probe).toHaveBeenCalledTimes(1);
    expect(adb.listDevices).not.toHaveBeenCalled();
  });

  it("preserves strict custom and environment precedence in the synchronous descriptor helper", () => {
    const base = {
      platform: "linux" as const,
      environment: {},
      homeDirectory: "/home/tester",
      bundledPaths: ["/app/adb"],
      preparedPath: "/prepared/adb",
      pathExists: (path: string) => path === "/app/adb" || path === "/prepared/adb"
    };
    expect(resolveAndroidAdbExecutable(base)).toEqual({
      executablePath: "/app/adb",
      pathSource: "bundled"
    });
    expect(resolveAndroidAdbExecutable({ ...base, explicitPath: "/custom/adb" })).toEqual({
      executablePath: "/custom/adb",
      pathSource: "custom"
    });
    expect(resolveAndroidAdbExecutable({
      ...base,
      environment: { JOKO_ANDROID_ADB_PATH: "/environment/adb" }
    })).toEqual({ executablePath: "/environment/adb", pathSource: "environment" });
  });
});

describe("AndroidAutomationRuntime service lifecycle", () => {
  it("probes the same server port configured for ADB through the environment", async () => {
    const portProbe = vi.fn(async () => true);
    const runtime = new AndroidAutomationRuntime({
      platform: "linux",
      environment: { ANDROID_ADB_SERVER_PORT: "6040" },
      adapter: adapter({ listDevices: vi.fn(async () => []) }),
      portProbe
    });

    await runtime.listDevices();
    expect(portProbe).toHaveBeenCalledWith(6040);
  });

  it("marks only a service it started as managed and stops it during disposal", async () => {
    const adb = adapter({ listDevices: vi.fn(async () => []) });
    const probes = [false, true];
    const runtime = new AndroidAutomationRuntime({
      platform: "linux",
      executablePath: "/managed/platform-tools/adb",
      pathSource: "prepared",
      adapter: adb,
      portProbe: async () => probes.shift() ?? true
    });

    await runtime.listDevices();
    expect(runtime.managedServer).toBe(true);
    await runtime.dispose();
    expect(adb.killServer).toHaveBeenCalledTimes(1);
  });

  it("never owns daemons launched through host-controlled ADB sources", async () => {
    const unmanagedSources = ["custom", "environment", "fallback", "path", "sdk"] as const;
    const operations = ["list", "start", "connect"] as const;

    for (const pathSource of unmanagedSources) {
      for (const operation of operations) {
        const adb = adapter({ listDevices: vi.fn(async () => []) });
        const probes = [false, true];
        const runtime = new AndroidAutomationRuntime({
          platform: "linux",
          executablePath: `/host/${pathSource}/adb`,
          pathSource,
          adapter: adb,
          portProbe: async () => probes.shift() ?? true
        });

        if (operation === "list") await runtime.listDevices();
        if (operation === "start") await runtime.startServer();
        if (operation === "connect") await runtime.connectDevice("example.test:5555");

        expect(runtime.managedServer, `${pathSource}:${operation}`).toBe(false);
        await expect(runtime.stopManagedServer()).rejects.toMatchObject({ code: "server_not_owned" });
        await runtime.dispose();
        expect(adb.killServer, `${pathSource}:${operation}`).not.toHaveBeenCalled();
      }
    }
  });

  it("never kills a service that pre-existed this runtime", async () => {
    const adb = adapter({ listDevices: vi.fn(async () => []) });
    const runtime = new AndroidAutomationRuntime({
      platform: "linux",
      adapter: adb,
      portProbe: async () => true
    });

    await runtime.listDevices();
    await expect(runtime.stopManagedServer()).rejects.toMatchObject({ code: "server_not_owned" });
    await runtime.dispose();
    expect(adb.killServer).not.toHaveBeenCalled();
  });

  it("recovers a cold daemon with one start and bounded polling", async () => {
    let now = 0;
    const listDevices = vi.fn()
      .mockRejectedValueOnce(new AndroidRuntimeError("command_failed", "ADB command timed out."))
      .mockRejectedValueOnce(new AndroidRuntimeError("command_failed", "daemon not running"))
      .mockResolvedValueOnce([READY_DEVICE]);
    const startServer = vi.fn()
      .mockRejectedValueOnce(new AndroidRuntimeError("command_failed", "cannot connect to daemon"))
      .mockResolvedValueOnce(undefined);
    const adb = adapter({ listDevices, startServer });
    const delay = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    const runtime = new AndroidAutomationRuntime({
      platform: "linux",
      adapter: adb,
      portProbe: async () => true,
      coldStartTimeoutMs: 100,
      coldStartPollIntervalMs: 10,
      now: () => now,
      delay
    });

    await expect(runtime.listDevices()).resolves.toEqual([READY_DEVICE]);
    expect(adb.startServer).toHaveBeenCalledTimes(2);
    expect(listDevices).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledWith(10, undefined);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent device-list requests", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const listDevices = vi.fn(async () => {
      await gate;
      return [READY_DEVICE];
    });
    const runtime = new AndroidAutomationRuntime({
      platform: "linux",
      adapter: adapter({ listDevices }),
      portProbe: async () => true
    });

    const first = runtime.listDevices();
    const second = runtime.listDevices();
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([[READY_DEVICE], [READY_DEVICE]]);
    expect(listDevices).toHaveBeenCalledTimes(1);
  });
});

describe("AndroidAutomationRuntime devices and actions", () => {
  it("classifies multiple, unauthorized, offline, and absent devices", async () => {
    for (const [devices, code] of [
      [[READY_DEVICE, { ...READY_DEVICE, serial: "serial2" }], "multiple_devices"],
      [[{ serial: "serial1", state: "unauthorized" }], "device_unauthorized"],
      [[{ serial: "serial1", state: "offline" }], "device_offline"],
      [[], "no_device"]
    ] as const) {
      const runtime = new AndroidAutomationRuntime({
        platform: "linux",
        adapter: adapter({ listDevices: vi.fn(async () => devices) }),
        portProbe: async () => true
      });
      await expect(runtime.snapshot({ sessionId: "session-1" })).rejects.toMatchObject({ code });
    }
  });

  it("keeps node snapshots isolated by session and invalidates them after a mutation", async () => {
    const adb = adapter({
      listDevices: vi.fn(async () => [READY_DEVICE]),
      snapshot: vi.fn(async () => snapshot(READY_DEVICE.serial))
    });
    const runtime = new AndroidAutomationRuntime({
      platform: "linux",
      adapter: adb,
      portProbe: async () => true,
      now: () => 1_000
    });

    await runtime.snapshot({ sessionId: "session-a" });
    await expect(runtime.tap({ sessionId: "session-b", elementIndex: 1 }))
      .rejects.toMatchObject({ code: "invalid_node" });
    await expect(runtime.tap({ sessionId: "session-a", elementIndex: 1 })).resolves.toEqual({
      deviceSerial: READY_DEVICE.serial,
      point: { x: 60, y: 120 }
    });
    expect(adb.tap).toHaveBeenCalledWith(READY_DEVICE.serial, { x: 60, y: 120 }, undefined);
    await expect(runtime.tap({ sessionId: "session-a", elementIndex: 1 }))
      .rejects.toMatchObject({ code: "invalid_node" });
  });

  it("expires old snapshots before node-index actions", async () => {
    let now = 0;
    const runtime = new AndroidAutomationRuntime({
      platform: "linux",
      adapter: adapter({
        listDevices: vi.fn(async () => [READY_DEVICE]),
        snapshot: vi.fn(async () => snapshot(READY_DEVICE.serial))
      }),
      portProbe: async () => true,
      snapshotMaximumAgeMs: 50,
      now: () => now
    });

    await runtime.snapshot({ sessionId: "session-a" });
    now = 51;
    await expect(runtime.tap({ sessionId: "session-a", elementIndex: 1 }))
      .rejects.toMatchObject({ code: "invalid_node" });
  });

  it("checks direct tap and swipe coordinates against the actual screen", async () => {
    const adb = adapter({
      listDevices: vi.fn(async () => [READY_DEVICE]),
      snapshot: vi.fn(async () => snapshot(READY_DEVICE.serial))
    });
    const runtime = new AndroidAutomationRuntime({
      platform: "linux",
      adapter: adb,
      portProbe: async () => true
    });

    await expect(runtime.tap({ sessionId: "session-a", point: { x: 1079, y: 2399 } }))
      .resolves.toMatchObject({ point: { x: 1079, y: 2399 } });
    await expect(runtime.swipe({
      sessionId: "session-a",
      start: { x: 0, y: 0 },
      end: { x: 1080, y: 1 }
    })).rejects.toMatchObject({ code: "invalid_coordinate" });
  });

  it("never echoes text input and clears the calling session snapshot", async () => {
    const adb = adapter({
      listDevices: vi.fn(async () => [READY_DEVICE]),
      snapshot: vi.fn(async () => snapshot(READY_DEVICE.serial))
    });
    const runtime = new AndroidAutomationRuntime({
      platform: "linux",
      adapter: adb,
      portProbe: async () => true
    });
    await runtime.snapshot({ sessionId: "session-a" });

    const result = await runtime.inputText({ sessionId: "session-a", text: "hello world" });

    expect(result).toEqual({ deviceSerial: READY_DEVICE.serial, characterCount: 11 });
    expect(JSON.stringify(result)).not.toContain("hello");
    expect(runtime.cachedSnapshotCount).toBe(0);
  });

  it("exposes connection and approved install as host operations without adding tool-catalog entries", async () => {
    const adb = adapter({ listDevices: vi.fn(async () => [READY_DEVICE]) });
    const runtime = new AndroidAutomationRuntime({
      platform: "linux",
      adapter: adb,
      portProbe: async () => true
    });

    await expect(runtime.connectDevice("example.test:5555")).resolves.toMatchObject({
      endpoint: "example.test:5555",
      devices: [READY_DEVICE]
    });
    await expect(runtime.installArtifact({
      sessionId: "session-a",
      artifactPath: "/approved/application.apk"
    })).resolves.toMatchObject({ installed: true, deviceSerial: READY_DEVICE.serial });
  });
});

function adapter(overrides: Partial<AndroidAdbAdapter> = {}): AndroidAdbAdapter & {
  readonly [key: string]: unknown;
} {
  return {
    probe: vi.fn(async () => "Android Debug Bridge 35"),
    listDevices: vi.fn(async () => []),
    startServer: vi.fn(async () => undefined),
    killServer: vi.fn(async () => undefined),
    connect: vi.fn(async (endpoint) => ({ endpoint, output: "connected" })),
    disconnect: vi.fn(async (endpoint) => ({ endpoint, output: "disconnected" })),
    snapshot: vi.fn(async (serial) => snapshot(serial)),
    tap: vi.fn(async () => undefined),
    swipe: vi.fn(async () => undefined),
    inputText: vi.fn(async () => undefined),
    pressKey: vi.fn(async () => 4),
    launchApp: vi.fn(async () => "started"),
    installArtifact: vi.fn(async () => "Success"),
    ...overrides
  };
}

function snapshot(serial: string): AndroidDeviceSnapshot {
  return {
    deviceSerial: serial,
    screen: { width: 1080, height: 2400, density: 420 },
    currentApp: { packageName: "com.example.app", activity: ".MainActivity" },
    screenshot: { mimeType: "image/png", dataBase64: "iVBORw==", byteLength: 4 },
    nodes: [{
      index: 1,
      text: "Continue",
      bounds: { x1: 10, y1: 100, x2: 110, y2: 140 },
      clickable: true,
      enabled: true
    }],
    nodesTruncated: false,
    capturedAt: 0
  };
}
