import { expect, it } from "vitest";
import { createSimulatorCreateRuntime, type SimulatorPendingCreateEvidence } from "./create.js";
import type { SimulatorCommandResult, SimulatorCommandRunner } from "./environment.js";

const UDID = "A0123456-1234-1234-1234-123456789ABC";
const MARKER = `joko_ios_pending__${"a".repeat(32)}__b0123456-1234-1234-1234-123456789abc`;
const input = {
  markerName: MARKER,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17"
} as const;
const ok = (stdout = ""): SimulatorCommandResult => ({ stdout, stderr: "", exitCode: 0 });
const list = (name?: string, deviceTypeIdentifier: string = input.deviceTypeIdentifier): SimulatorCommandResult => ok(JSON.stringify({
  runtimes: [{ identifier: input.runtimeIdentifier, name: "iOS 19.0", isAvailable: true }],
  devices: { [input.runtimeIdentifier]: name === undefined ? [] : [{ udid: UDID, name, state: "Shutdown",
    isAvailable: true, deviceTypeIdentifier }] }
}));

function scripted(...steps: { readonly args: readonly string[]; readonly result: SimulatorCommandResult }[]): {
  readonly runner: SimulatorCommandRunner;
  readonly calls: string[][];
  remaining(): number;
} {
  const pending = [...steps];
  const calls: string[][] = [];
  return { calls, remaining: () => pending.length, runner: { run: async (command, args, options) => {
    expect(command).toBe("/usr/bin/xcrun");
    expect(options?.timeoutMs).toBeGreaterThan(0);
    calls.push([...args]);
    const step = pending.shift();
    expect(args).toEqual(step?.args);
    return step?.result ?? { stdout: "", stderr: "", exitCode: null, failed: true };
  } } };
}

function evidence(events: string[]): SimulatorPendingCreateEvidence {
  return {
    arm: (marker) => { expect(marker).toBe(MARKER); events.push("arm"); },
    clear: (marker) => { expect(marker).toBe(MARKER); events.push("clear"); }
  };
}

it("arms evidence before create, confirms the exact marker, and renames only that device", async () => {
  const events: string[] = [];
  const commands = scripted(
    { args: ["simctl", "create", MARKER, input.deviceTypeIdentifier, input.runtimeIdentifier], result: ok(UDID) },
    { args: ["simctl", "list", "-j"], result: list(MARKER) },
    { args: ["simctl", "list", "-j"], result: list(MARKER) },
    { args: ["simctl", "rename", UDID, "Joko iPhone"], result: ok() },
    { args: ["simctl", "list", "-j"], result: list("Joko iPhone") }
  );
  const runner: SimulatorCommandRunner = { run: async (...args) => {
    if (commands.calls.length === 0) expect(events).toEqual(["arm"]);
    return commands.runner.run(...args);
  } };
  const runtime = createSimulatorCreateRuntime({ platform: "darwin", runner });
  const created = await runtime.createExact(input, evidence(events));
  expect(created).toEqual({ ...input, udid: UDID });
  expect(events).toEqual(["arm"]);
  await runtime.renameExact({ ...created, name: "Joko iPhone" });
  expect(commands.remaining()).toBe(0);
  expect(commands.calls.some(args => args.includes("delete"))).toBe(false);
});

it("cleans a failed exact create with independent reads, and keeps uncertain evidence when identity changes", async () => {
  const events: string[] = [];
  const cleanup = scripted(
    { args: ["simctl", "create", MARKER, input.deviceTypeIdentifier, input.runtimeIdentifier],
      result: { stdout: "", stderr: "/private/secret", exitCode: 1 } },
    { args: ["simctl", "list", "-j"], result: list(MARKER) },
    { args: ["simctl", "list", "-j"], result: list(MARKER) },
    { args: ["simctl", "delete", UDID], result: ok() },
    { args: ["simctl", "list", "-j"], result: list() }
  );
  await expect(createSimulatorCreateRuntime({ platform: "darwin", runner: cleanup.runner })
    .createExact(input, evidence(events))).rejects.toMatchObject({ code: "SIMULATOR_CREATE_FAILED" });
  expect(events).toEqual(["arm", "clear"]);
  expect(cleanup.remaining()).toBe(0);

  const retained: string[] = [];
  const drift = scripted(
    { args: ["simctl", "create", MARKER, input.deviceTypeIdentifier, input.runtimeIdentifier],
      result: { stdout: "", stderr: "/private/secret", exitCode: null, timedOut: true } },
    { args: ["simctl", "list", "-j"], result: list(MARKER, "com.apple.CoreSimulator.SimDeviceType.iPad-17") }
  );
  await expect(createSimulatorCreateRuntime({ platform: "darwin", runner: drift.runner })
    .createExact(input, evidence(retained))).rejects.toMatchObject({ code: "SIMULATOR_CREATE_CLEANUP_REQUIRED" });
  expect(retained).toEqual(["arm"]);
  expect(drift.remaining()).toBe(0);
  expect(drift.calls.some(args => args.includes("delete"))).toBe(false);

  const staleRename = scripted({ args: ["simctl", "list", "-j"], result: list("Renamed elsewhere") });
  await expect(createSimulatorCreateRuntime({ platform: "darwin", runner: staleRename.runner })
    .renameExact({ ...input, udid: UDID, name: "Joko iPhone" })).rejects.toMatchObject({ code: "SIMULATOR_RENAME_FAILED" });
  expect(staleRename.remaining()).toBe(0);
});

it("rejects non-macOS, invalid markers and failed evidence before a create command", async () => {
  const commands = scripted();
  const unsupported = createSimulatorCreateRuntime({ platform: "win32", runner: commands.runner });
  await expect(unsupported.createExact(input, evidence([]))).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
  const runtime = createSimulatorCreateRuntime({ platform: "darwin", runner: commands.runner });
  await expect(runtime.createExact({ ...input, markerName: "other-app" }, evidence([])))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(runtime.createExact(input, { arm: () => { throw new Error("/private/secret"); }, clear: () => undefined }))
    .rejects.toMatchObject({ code: "CREATE_EVIDENCE_FAILED" });
  expect(commands.calls).toEqual([]);
});

it("cleans a cancelled create with an independent bounded probe", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const commands = scripted(
    { args: ["simctl", "create", MARKER, input.deviceTypeIdentifier, input.runtimeIdentifier],
      result: { stdout: "", stderr: "", exitCode: null, aborted: true } },
    { args: ["simctl", "list", "-j"], result: list(MARKER) },
    { args: ["simctl", "list", "-j"], result: list(MARKER) },
    { args: ["simctl", "delete", UDID], result: ok() },
    { args: ["simctl", "list", "-j"], result: list() }
  );
  const runner: SimulatorCommandRunner = { run: async (command, args, options) => {
    if (args[1] === "create") {
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
    } else {
      expect(options?.signal?.aborted).not.toBe(true);
    }
    return commands.runner.run(command, args, options);
  } };
  await expect(createSimulatorCreateRuntime({ platform: "darwin", runner })
    .createExact(input, evidence(events), controller.signal)).rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
  expect(events).toEqual(["arm", "clear"]);
  expect(commands.remaining()).toBe(0);
});

it("retains evidence when create returned a UUID but its marker cannot be confirmed", async () => {
  const events: string[] = [];
  const commands = scripted(
    { args: ["simctl", "create", MARKER, input.deviceTypeIdentifier, input.runtimeIdentifier], result: ok(UDID) },
    { args: ["simctl", "list", "-j"], result: list("Unexpected name") }
  );
  await expect(createSimulatorCreateRuntime({ platform: "darwin", runner: commands.runner })
    .createExact(input, evidence(events))).rejects.toMatchObject({ code: "SIMULATOR_CREATE_UNKNOWN" });
  expect(events).toEqual(["arm"]);
  expect(commands.calls.some(args => args.includes("delete"))).toBe(false);
});
