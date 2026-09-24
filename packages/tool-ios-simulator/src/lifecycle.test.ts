import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createNodeSimulatorCommandRunner, type SimulatorCommandResult, type SimulatorCommandRunner } from "./environment.js";
import { createSimulatorLifecycleRuntime } from "./lifecycle.js";

const UDID = "A0123456-1234-1234-1234-123456789ABC";
const XCRUN = "/usr/bin/xcrun";
const ok = (stdout = ""): SimulatorCommandResult => ({ stdout, stderr: "", exitCode: 0 });
const deviceList = (state: string): SimulatorCommandResult => ok(JSON.stringify({
  runtimes: [{ identifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", name: "iOS 19.0", isAvailable: true }],
  devices: { "com.apple.CoreSimulator.SimRuntime.iOS-19-0": [{ udid: UDID, name: "iPhone test", state,
    isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" }] }
}));

function scripted(...steps: { args: readonly string[]; result: SimulatorCommandResult }[]): {
  runner: SimulatorCommandRunner; calls: string[][]; remaining(): number;
} {
  const pending = [...steps];
  const calls: string[][] = [];
  return { calls, remaining: () => pending.length, runner: { run: async (command, args) => {
    expect(command).toBe(XCRUN);
    calls.push([...args]);
    const step = pending.shift();
    expect(args).toEqual(step?.args);
    return step?.result ?? { stdout: "", stderr: "", exitCode: null, failed: true };
  } } };
}

it("uses exact bounded simctl routes for boot and shutdown, including already terminal states", async () => {
  const boot = scripted(
    { args: ["simctl", "list", "-j"], result: deviceList("Shutdown") },
    { args: ["simctl", "boot", UDID], result: ok() },
    { args: ["simctl", "list", "-j"], result: deviceList("Booted") },
    { args: ["simctl", "bootstatus", UDID, "-b"], result: ok() },
    { args: ["simctl", "list", "-j"], result: deviceList("Booted") }
  );
  expect(await createSimulatorLifecycleRuntime({ platform: "darwin", runner: boot.runner }).bootExact(UDID))
    .toMatchObject({ udid: UDID, state: "Booted" });
  expect(boot.remaining()).toBe(0);

  const shutdown = scripted(
    { args: ["simctl", "list", "-j"], result: deviceList("Booted") },
    { args: ["simctl", "shutdown", UDID], result: ok() },
    { args: ["simctl", "list", "-j"], result: deviceList("Shutdown") }
  );
  await createSimulatorLifecycleRuntime({ platform: "darwin", runner: shutdown.runner }).shutdownExact(UDID);
  expect(shutdown.remaining()).toBe(0);

  const stopped = scripted({ args: ["simctl", "list", "-j"], result: deviceList("Shutdown") });
  await createSimulatorLifecycleRuntime({ platform: "darwin", runner: stopped.runner }).shutdownExact(UDID);
  expect(stopped.calls).toHaveLength(1);

  const starting = scripted(
    { args: ["simctl", "list", "-j"], result: deviceList("Shutdown") },
    { args: ["simctl", "boot", UDID], result: { stdout: "", stderr: "transition in progress", exitCode: 1 } },
    { args: ["simctl", "list", "-j"], result: deviceList("Booting") },
    { args: ["simctl", "list", "-j"], result: deviceList("Booted") },
    { args: ["simctl", "bootstatus", UDID, "-b"], result: ok() },
    { args: ["simctl", "list", "-j"], result: deviceList("Booted") }
  );
  expect(await createSimulatorLifecycleRuntime({ platform: "darwin", runner: starting.runner }).bootExact(UDID))
    .toMatchObject({ state: "Booted" });
  expect(starting.remaining()).toBe(0);
});

it("fails closed on unsupported hosts, invalid routes and uncertain command outcomes", async () => {
  const unsupported = scripted();
  await expect(createSimulatorLifecycleRuntime({ platform: "win32", runner: unsupported.runner }).bootExact(UDID))
    .rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
  expect(unsupported.calls).toEqual([]);
  await expect(createSimulatorLifecycleRuntime({ platform: "darwin", runner: unsupported.runner }).findExact("booted"))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(unsupported.calls).toEqual([]);

  const unknown = scripted(
    { args: ["simctl", "list", "-j"], result: deviceList("Shutdown") },
    { args: ["simctl", "boot", UDID], result: { stdout: "", stderr: "/private/secret", exitCode: null, timedOut: true } }
  );
  await expect(createSimulatorLifecycleRuntime({ platform: "darwin", runner: unknown.runner }).bootExact(UDID))
    .rejects.toMatchObject({ code: "SIMULATOR_BOOT_UNKNOWN" });
  expect(unknown.remaining()).toBe(0);

  const malformed = scripted({ args: ["simctl", "list", "-j"], result: ok("{") });
  await expect(createSimulatorLifecycleRuntime({ platform: "darwin", runner: malformed.runner }).findExact(UDID))
    .rejects.toMatchObject({ code: "INVALID_SIMCTL_OUTPUT" });
  expect(JSON.stringify(malformed.calls)).not.toContain("secret");

  const cancelled = new AbortController();
  cancelled.abort();
  await expect(createSimulatorLifecycleRuntime({ platform: "darwin", runner: unsupported.runner }).bootExact(UDID, cancelled.signal))
    .rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
  expect(unsupported.calls).toEqual([]);

  const shutdownUnknown = scripted(
    { args: ["simctl", "list", "-j"], result: deviceList("Booted") },
    { args: ["simctl", "shutdown", UDID], result: { stdout: "", stderr: "/private/secret", exitCode: null, timedOut: true } }
  );
  await expect(createSimulatorLifecycleRuntime({ platform: "darwin", runner: shutdownUnknown.runner }).shutdownExact(UDID))
    .rejects.toMatchObject({ code: "SIMULATOR_SHUTDOWN_UNKNOWN" });
  expect(shutdownUnknown.remaining()).toBe(0);

  let now = 0;
  const stalled = scripted(
    { args: ["simctl", "list", "-j"], result: deviceList("Booted") },
    { args: ["simctl", "list", "-j"], result: deviceList("Booted") },
    { args: ["simctl", "bootstatus", UDID, "-b"], result: { stdout: "", stderr: "", exitCode: 1 } }
  );
  await expect(createSimulatorLifecycleRuntime({ platform: "darwin", runner: stalled.runner,
    bootTimeoutMs: 1_000, clock: { now: () => now, sleep: async (ms) => { now += ms; } } }).bootExact(UDID))
    .rejects.toMatchObject({ code: "SIMULATOR_BOOT_TIMEOUT" });
  expect(stalled.remaining()).toBe(0);
});

it("uses a caller bounded timeout and terminates a real child that does not exit", async () => {
  const result = await createNodeSimulatorCommandRunner().run(process.execPath,
    ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 30 });
  expect(result).toMatchObject({ timedOut: true, exitCode: null });
});

it("uses exact bounded simctl ui routes for appearance, contrast and content size", async () => {
  const controls = scripted(
    { args: ["simctl", "ui", UDID, "appearance", "dark"], result: ok() },
    { args: ["simctl", "ui", UDID, "increase_contrast", "enabled"], result: ok() },
    { args: ["simctl", "ui", UDID, "increase_contrast", "disabled"], result: ok() },
    { args: ["simctl", "ui", UDID, "content_size", "accessibility-extra-large"], result: ok() }
  );
  const runtime = createSimulatorLifecycleRuntime({ platform: "darwin", runner: controls.runner });
  await runtime.setAppearance!(UDID.toLowerCase(), "dark");
  await runtime.setIncreaseContrast!(UDID, true);
  await runtime.setIncreaseContrast!(UDID, false);
  await runtime.setContentSize!(UDID, "accessibility-extra-large");
  expect(controls.remaining()).toBe(0);
});

it("rejects invalid system controls before dispatch and fences uncertain results", async () => {
  const unused = scripted();
  const runtime = createSimulatorLifecycleRuntime({ platform: "darwin", runner: unused.runner });
  await expect(runtime.setAppearance!(UDID, "blue" as "dark"))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.setIncreaseContrast!(UDID, "yes" as unknown as boolean))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.setContentSize!(UDID, "huge" as "large"))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(unused.calls).toEqual([]);

  await expect(createSimulatorLifecycleRuntime({ platform: "win32", runner: unused.runner })
    .setAppearance!(UDID, "light")).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
  expect(unused.calls).toEqual([]);

  const rejected = scripted({ args: ["simctl", "ui", UDID, "appearance", "light"],
    result: { stdout: "", stderr: "/private/secret", exitCode: 1 } });
  await expect(createSimulatorLifecycleRuntime({ platform: "darwin", runner: rejected.runner })
    .setAppearance!(UDID, "light")).rejects.toMatchObject({ code: "SIMULATOR_CONTROL_FAILED" });

  const unknown = scripted({ args: ["simctl", "ui", UDID, "content_size", "large"],
    result: { stdout: "", stderr: "/private/secret", exitCode: null, timedOut: true } });
  await expect(createSimulatorLifecycleRuntime({ platform: "darwin", runner: unknown.runner })
    .setContentSize!(UDID, "large")).rejects.toMatchObject({ code: "SIMULATOR_CONTROL_UNKNOWN" });
});

it("uses exact bounded simctl location routes for point, route and clear", async () => {
  const controls = scripted(
    { args: ["simctl", "location", UDID, "set", "31.2304,121.4737"], result: ok() },
    { args: ["simctl", "location", UDID, "start", "--speed=12", "--interval=0.5",
      "31.2304,121.4737", "31.233,121.48"], result: ok() },
    { args: ["simctl", "location", UDID, "start", "--distance=25",
      "0,0", "1,-1"], result: ok() },
    { args: ["simctl", "location", UDID, "clear"], result: ok() }
  );
  const runtime = createSimulatorLifecycleRuntime({ platform: "darwin", runner: controls.runner });
  await runtime.setLocation!(UDID.toLowerCase(), 31.2304, 121.4737);
  await runtime.startLocationRoute!(UDID, { waypoints: [
    { latitude: 31.2304, longitude: 121.4737 },
    { latitude: 31.233, longitude: 121.48 }
  ], speedMetersPerSecond: 12, intervalSeconds: 0.5 });
  await runtime.startLocationRoute!(UDID, { waypoints: [
    { latitude: 0, longitude: 0 }, { latitude: 1, longitude: -1 }
  ], distanceMeters: 25 });
  await runtime.clearLocation!(UDID);
  expect(controls.remaining()).toBe(0);
});

it("rejects invalid location controls before dispatch and fences uncertain outcomes", async () => {
  const unused = scripted();
  const runtime = createSimulatorLifecycleRuntime({ platform: "darwin", runner: unused.runner });
  await expect(runtime.setLocation!(UDID, 91, 0))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.setLocation!(UDID, 0, Number.NaN))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.startLocationRoute!(UDID, { waypoints: [{ latitude: 0, longitude: 0 }] }))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.startLocationRoute!(UDID, { waypoints: [
    { latitude: 0, longitude: 0 }, { latitude: 1, longitude: 1 }
  ], intervalSeconds: 1, distanceMeters: 1 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.startLocationRoute!(UDID, { waypoints: [
    { latitude: 0, longitude: 0 }, { latitude: 1, longitude: 1 }
  ], speedMetersPerSecond: 10_001 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(unused.calls).toEqual([]);

  await expect(createSimulatorLifecycleRuntime({ platform: "win32", runner: unused.runner })
    .clearLocation!(UDID)).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
  expect(unused.calls).toEqual([]);

  const rejected = scripted({ args: ["simctl", "location", UDID, "clear"],
    result: { stdout: "", stderr: "/private/secret", exitCode: 1 } });
  await expect(createSimulatorLifecycleRuntime({ platform: "darwin", runner: rejected.runner })
    .clearLocation!(UDID)).rejects.toMatchObject({ code: "SIMULATOR_CONTROL_FAILED" });

  const unknown = scripted({ args: ["simctl", "location", UDID, "set", "0,0"],
    result: { stdout: "", stderr: "/private/secret", exitCode: null, aborted: true } });
  await expect(createSimulatorLifecycleRuntime({ platform: "darwin", runner: unknown.runner })
    .setLocation!(UDID, 0, 0)).rejects.toMatchObject({ code: "SIMULATOR_CONTROL_UNKNOWN" });
});

it("uses exact simctl privacy and ordered status-bar routes", async () => {
  const controls = scripted(
    { args: ["simctl", "privacy", UDID, "grant", "camera", "app.joko.fixture"], result: ok() },
    { args: ["simctl", "privacy", UDID, "reset", "all"], result: ok() },
    { args: ["simctl", "status_bar", UDID, "override",
      "--time", "09:41", "--dataNetwork", "5g", "--wifiMode", "active",
      "--cellularMode", "searching", "--wifiBars", "3", "--cellularBars", "4",
      "--operatorName", "Joko", "--batteryState", "charged", "--batteryLevel", "100"],
    result: ok() },
    { args: ["simctl", "status_bar", UDID, "clear"], result: ok() }
  );
  const runtime = createSimulatorLifecycleRuntime({ platform: "darwin", runner: controls.runner });
  await runtime.setPrivacy!(UDID.toLowerCase(), "grant", "camera", "app.joko.fixture");
  await runtime.setPrivacy!(UDID, "reset", "all");
  await runtime.setStatusBar!(UDID, { time: "09:41", dataNetwork: "5g", wifiMode: "active",
    wifiBars: 3, cellularMode: "searching", cellularBars: 4, operatorName: "Joko",
    batteryState: "charged", batteryLevel: 100 });
  await runtime.clearStatusBar!(UDID);
  expect(controls.remaining()).toBe(0);
});

it("rejects invalid privacy/status-bar controls before dispatch and fences unknown results", async () => {
  const unused = scripted();
  const runtime = createSimulatorLifecycleRuntime({ platform: "darwin", runner: unused.runner });
  await expect(runtime.setPrivacy!(UDID, "grant", "camera"))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.setPrivacy!(UDID, "reset", "Camera"))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.setPrivacy!(UDID, "reset", "all", "invalid bundle"))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.setStatusBar!(UDID, {}))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.setStatusBar!(UDID, { wifiBars: 4 }))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.setStatusBar!(UDID, { time: "\n" }))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(unused.calls).toEqual([]);

  await expect(createSimulatorLifecycleRuntime({ platform: "win32", runner: unused.runner })
    .clearStatusBar!(UDID)).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
  expect(unused.calls).toEqual([]);

  const rejected = scripted({ args: ["simctl", "privacy", UDID, "revoke", "camera", "app.joko.fixture"],
    result: { stdout: "", stderr: "/private/secret", exitCode: 1 } });
  await expect(createSimulatorLifecycleRuntime({ platform: "darwin", runner: rejected.runner })
    .setPrivacy!(UDID, "revoke", "camera", "app.joko.fixture"))
    .rejects.toMatchObject({ code: "SIMULATOR_CONTROL_FAILED" });

  const unknown = scripted({ args: ["simctl", "status_bar", UDID, "clear"],
    result: { stdout: "", stderr: "/private/secret", exitCode: null, timedOut: true } });
  await expect(createSimulatorLifecycleRuntime({ platform: "darwin", runner: unknown.runner })
    .clearStatusBar!(UDID)).rejects.toMatchObject({ code: "SIMULATOR_CONTROL_UNKNOWN" });
});

it("delivers a bounded push through an exact private temporary file and removes it", async () => {
  const payload = { aps: { alert: "Hello" }, marker: "private push body" };
  let payloadPath = "";
  const runner: SimulatorCommandRunner = { run: async (command, args, options) => {
    expect(command).toBe(XCRUN);
    expect(args.slice(0, 4)).toEqual(["simctl", "push", UDID, "app.joko.fixture"]);
    expect(options?.timeoutMs).toBe(15_000);
    payloadPath = args[4]!;
    expect(payloadPath).toMatch(/joko-ios-push-[^\\/]+[\\/]payload\.json$/u);
    expect(await readFile(payloadPath, "utf8")).toBe(JSON.stringify(payload));
    if (process.platform !== "win32") expect((await stat(payloadPath)).mode & 0o777).toBe(0o600);
    return ok();
  } };
  await createSimulatorLifecycleRuntime({ platform: "darwin", runner })
    .pushNotification!(UDID.toLowerCase(), "app.joko.fixture", payload);
  await expect(stat(payloadPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects malformed push bodies before dispatch and cleans an uncertain delivery", async () => {
  let calls = 0;
  const payloadPaths: string[] = [];
  const runner: SimulatorCommandRunner = { run: async (_command, args) => {
    calls += 1;
    payloadPaths.push(args[4]!);
    expect(await readFile(args[4]!, "utf8")).toContain("private push body");
    return calls === 1
      ? { stdout: "", stderr: "private host output", exitCode: 1 }
      : { stdout: "", stderr: "private host output", exitCode: null, timedOut: true };
  } };
  const runtime = createSimulatorLifecycleRuntime({ platform: "darwin", runner });
  await expect(runtime.pushNotification!(UDID, "invalid bundle", { aps: {} }))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.pushNotification!(UDID, "app.joko.fixture", { marker: "missing aps" }))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.pushNotification!(UDID, "app.joko.fixture", { aps: {}, alert: "界".repeat(1_400) }))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  const cycle: Record<string, unknown> = { aps: {} };
  cycle["cycle"] = cycle;
  await expect(runtime.pushNotification!(UDID, "app.joko.fixture", cycle))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  const controller = new AbortController();
  controller.abort();
  await expect(runtime.pushNotification!(UDID, "app.joko.fixture", { aps: {} }, controller.signal))
    .rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
  expect(calls).toBe(0);
  await expect(runtime.pushNotification!(UDID, "app.joko.fixture",
    { aps: { alert: "private push body" } })).rejects.toMatchObject({ code: "SIMULATOR_CONTROL_FAILED" });
  await expect(stat(payloadPaths[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(runtime.pushNotification!(UDID, "app.joko.fixture",
    { aps: { alert: "private push body" } })).rejects.toMatchObject({ code: "SIMULATOR_CONTROL_UNKNOWN" });
  expect(calls).toBe(2);
  await expect(stat(payloadPaths[1]!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("installs only an absolute app on the exact simulator with bounded unknown outcomes", async () => {
  const appPath = resolve("Application.app");
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number | undefined }> = [];
  let result: SimulatorCommandResult = ok();
  const runner: SimulatorCommandRunner = { run: async (command, args, options) => {
    calls.push({ command, args, timeoutMs: options?.timeoutMs });
    return result;
  } };
  const runtime = createSimulatorLifecycleRuntime({ platform: "darwin", runner });
  await runtime.installApp!(UDID.toLowerCase(), appPath);
  expect(calls).toEqual([{ command: XCRUN,
    args: ["simctl", "install", UDID, appPath], timeoutMs: 120_000 }]);
  await expect(runtime.installApp!(UDID, "relative.app"))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  const controller = new AbortController();
  controller.abort();
  await expect(runtime.installApp!(UDID, appPath, controller.signal))
    .rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
  expect(calls).toHaveLength(1);
  result = { stdout: "", stderr: "private host output", exitCode: 1 };
  await expect(runtime.installApp!(UDID, appPath))
    .rejects.toMatchObject({ code: "APP_INSTALL_FAILED" });
  result = { stdout: "", stderr: "private host output", exitCode: null, timedOut: true };
  await expect(runtime.installApp!(UDID, appPath))
    .rejects.toMatchObject({ code: "APP_INSTALL_UNKNOWN" });
  expect(calls).toHaveLength(3);
  await expect(createSimulatorLifecycleRuntime({ platform: "win32", runner }).installApp!(UDID, appPath))
    .rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
});
