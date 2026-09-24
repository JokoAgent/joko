import { expect, it } from "vitest";
import { createSimulatorOwnedDeleteRuntime } from "./delete.js";
import type { SimulatorCommandResult, SimulatorCommandRunner } from "./environment.js";

const identity = { udid: "A0123456-1234-1234-1234-123456789ABC", name: "Joko iPhone",
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" } as const;
const ok = (stdout = ""): SimulatorCommandResult => ({ stdout, stderr: "", exitCode: 0 });
function list(name?: string, state = "Shutdown"): SimulatorCommandResult {
  return ok(JSON.stringify({
    runtimes: [{ identifier: identity.runtimeIdentifier, name: "iOS 19.0", isAvailable: true }],
    devices: { [identity.runtimeIdentifier]: name === undefined ? [] : [{ udid: identity.udid,
      name, state, isAvailable: true, deviceTypeIdentifier: identity.deviceTypeIdentifier }] }
  }));
}
function scripted(...steps: { readonly args: readonly string[]; readonly result: SimulatorCommandResult }[]) {
  const pending = [...steps];
  const calls: string[][] = [];
  const runner: SimulatorCommandRunner = { run: async (command, args, options) => {
    expect(command).toBe("/usr/bin/xcrun");
    expect(options?.timeoutMs).toBeGreaterThan(0);
    calls.push([...args]);
    const step = pending.shift();
    expect(args).toEqual(step?.args);
    return step?.result ?? { stdout: "", stderr: "", exitCode: null, failed: true };
  } };
  return { runner, calls, remaining: () => pending.length };
}

it("deletes only an exact shut down device and confirms its absence", async () => {
  const commands = scripted(
    { args: ["simctl", "list", "-j"], result: list(identity.name) },
    { args: ["simctl", "delete", identity.udid], result: ok() },
    { args: ["simctl", "list", "-j"], result: list() },
    { args: ["simctl", "list", "-j"], result: list() }
  );
  const runtime = createSimulatorOwnedDeleteRuntime({ platform: "darwin", runner: commands.runner });
  await runtime.deleteExact(identity);
  await runtime.deleteExact(identity);
  expect(commands.remaining()).toBe(0);
  expect(commands.calls.filter(args => args[1] === "delete")).toHaveLength(1);
});

it("refuses changed identity or a running device before any delete command", async () => {
  const changed = scripted({ args: ["simctl", "list", "-j"], result: list("Another device") });
  await expect(createSimulatorOwnedDeleteRuntime({ platform: "darwin", runner: changed.runner })
    .deleteExact(identity)).rejects.toMatchObject({ code: "DEVICE_IDENTITY_CHANGED" });
  expect(changed.remaining()).toBe(0);
  const running = scripted({ args: ["simctl", "list", "-j"], result: list(identity.name, "Booted") });
  await expect(createSimulatorOwnedDeleteRuntime({ platform: "darwin", runner: running.runner })
    .deleteExact(identity)).rejects.toMatchObject({ code: "DEVICE_NOT_SHUTDOWN" });
  expect(running.remaining()).toBe(0);
});

it("reobserves an uncertain delete, but never reports success while the device remains", async () => {
  const removed = scripted(
    { args: ["simctl", "list", "-j"], result: list(identity.name) },
    { args: ["simctl", "delete", identity.udid], result: { ...ok(), timedOut: true } },
    { args: ["simctl", "list", "-j"], result: list() }
  );
  await createSimulatorOwnedDeleteRuntime({ platform: "darwin", runner: removed.runner })
    .deleteExact(identity);
  const retained = scripted(
    { args: ["simctl", "list", "-j"], result: list(identity.name) },
    { args: ["simctl", "delete", identity.udid], result: { ...ok(), timedOut: true } },
    { args: ["simctl", "list", "-j"], result: list(identity.name) }
  );
  await expect(createSimulatorOwnedDeleteRuntime({ platform: "darwin", runner: retained.runner })
    .deleteExact(identity)).rejects.toMatchObject({ code: "SIMULATOR_DELETE_UNKNOWN" });
  await expect(createSimulatorOwnedDeleteRuntime({ platform: "win32", runner: retained.runner })
    .deleteExact(identity)).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
});
