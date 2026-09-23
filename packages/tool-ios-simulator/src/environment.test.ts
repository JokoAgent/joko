import { expect, it } from "vitest";
import { createNodeSimulatorCommandRunner, createSimulatorEnvironmentRuntime, parseSimulatorListJson, type SimulatorCommandRunner, type SimulatorCommandResult } from "./environment.js";

const DEVICE_ID = "11111111-2222-4333-8444-555555555555";
const CATALOG = JSON.stringify({
  runtimes: [
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-0", name: "iOS 18.0", version: "18.0", isAvailable: true },
    { identifier: "com.apple.CoreSimulator.SimRuntime.tvOS-18-0", name: "tvOS 18.0", version: "18.0", isAvailable: true }
  ],
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
      { udid: DEVICE_ID, name: "iPhone Simulator", state: "Booted", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone" },
      { udid: "22222222-2222-4222-8222-222222222222", name: "iPad Simulator", state: "Shutdown", isAvailable: false, availabilityError: "/private/host-secret" }
    ],
    "com.apple.CoreSimulator.SimRuntime.tvOS-18-0": [
      { udid: "33333333-2222-4333-8333-333333333333", name: "TV", state: "Booted", isAvailable: true }
    ]
  }
});

function runnerFor(...results: SimulatorCommandResult[]): { runner: SimulatorCommandRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: { run: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return results.shift() ?? { stdout: "", stderr: "", exitCode: null, failed: true };
    } }
  };
}

const ok = (stdout: string): SimulatorCommandResult => ({ stdout, stderr: "", exitCode: 0 });

it("discovers only iOS runtimes and exact device states without exposing host diagnostics", async () => {
  const { runner, calls } = runnerFor(ok("/Applications/Xcode.app/Contents/Developer\n"), ok("Xcode 16.0\nBuild version 16A\n"), ok(CATALOG));
  const report = await createSimulatorEnvironmentRuntime({ platform: "darwin", runner }).inspect();
  expect(report).toMatchObject({ supported: true, ready: true, xcodeVersion: "Xcode 16.0\nBuild version 16A", issue: null });
  expect(report.runtimes).toHaveLength(1);
  expect(report.devices.map(device => [device.udid, device.state, device.isAvailable])).toEqual([
    [DEVICE_ID, "Booted", true], ["22222222-2222-4222-8222-222222222222", "Shutdown", false]
  ]);
  expect(JSON.stringify(report)).not.toContain("host-secret");
  expect(JSON.stringify(report)).not.toContain("/Applications/");
  expect(calls).toEqual(["/usr/bin/xcode-select -p", "/usr/bin/xcodebuild -version", "/usr/bin/xcrun simctl list -j"]);
  expect(() => parseSimulatorListJson("not-json")).toThrow();
});

it("keeps unsupported platform, host startup failures and missing device states reachable", async () => {
  const unsupportedRunner = runnerFor(ok("unused"));
  expect(await createSimulatorEnvironmentRuntime({ platform: "win32", runner: unsupportedRunner.runner }).inspect())
    .toMatchObject({ supported: false, ready: false, issue: "UNSUPPORTED_PLATFORM" });
  expect(unsupportedRunner.calls).toEqual([]);
  const xcodeFailure = runnerFor({ stdout: "", stderr: "/private/secret", exitCode: null, failed: true });
  const xcodeReport = await createSimulatorEnvironmentRuntime({ platform: "darwin", runner: xcodeFailure.runner }).inspect();
  expect(xcodeReport.issue).toBe("XCODE_NOT_FOUND");
  expect(JSON.stringify(xcodeReport)).not.toContain("secret");
  const timeout = runnerFor(ok("selected"), ok("Xcode 16"), { stdout: "", stderr: "", exitCode: null, timedOut: true });
  expect((await createSimulatorEnvironmentRuntime({ platform: "darwin", runner: timeout.runner }).inspect()).issue).toBe("PROBE_TIMEOUT");
  const malformed = runnerFor(ok("selected"), ok("Xcode 16"), ok("{"));
  expect((await createSimulatorEnvironmentRuntime({ platform: "darwin", runner: malformed.runner }).inspect()).issue).toBe("INVALID_SIMCTL_OUTPUT");
  const noRuntime = runnerFor(ok("selected"), ok("Xcode 16"), ok(JSON.stringify({ runtimes: [], devices: {} })));
  expect((await createSimulatorEnvironmentRuntime({ platform: "darwin", runner: noRuntime.runner }).inspect()).issue).toBe("IOS_RUNTIME_NOT_FOUND");
  const noDevice = runnerFor(ok("selected"), ok("Xcode 16"), ok(JSON.stringify({ runtimes: [{ identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-0", name: "iOS 18" }], devices: {} })));
  expect((await createSimulatorEnvironmentRuntime({ platform: "darwin", runner: noDevice.runner }).inspect()).issue).toBe("NO_SIMULATOR_DEVICES");
});

it("bounds actual argv child output and handles missing executables and cancellation", async () => {
  const runner = createNodeSimulatorCommandRunner();
  expect(await runner.run(joinMissingCommand(), [])).toMatchObject({ failed: true, exitCode: null });
  const aborted = new AbortController();
  aborted.abort();
  expect(await runner.run(process.execPath, ["-e", "process.exit(0)"], aborted.signal)).toMatchObject({ aborted: true, exitCode: null });
  expect(await runner.run(process.execPath, ["-e", "process.stdout.write('x'.repeat(5*1024*1024))"]))
    .toMatchObject({ outputTruncated: true });
});

function joinMissingCommand(): string {
  return process.platform === "win32" ? "C:\\joko-missing-simulator-probe.exe" : "/joko-missing-simulator-probe";
}
