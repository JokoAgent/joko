import { expect, it } from "vitest";
import { createWdaBuildPlan, createWdaOwnerFingerprint } from "./wda-build-plan.js";
import { inspectWdaOrphanProcesses, type WdaProcessInventoryReader } from "./wda-orphan-inspector.js";
import { WDA_SOURCE_PIN } from "./wda-source-pin.js";

const CACHE = "/private/joko/driver-cache";
const CORE = "/Users/joko/Library/Developer/CoreSimulator";
const UDID = "A0123456-1234-1234-1234-123456789ABC";
const INSTANCE = "instance-1";
const FINGERPRINT = createWdaOwnerFingerprint({ cacheRoot: CACHE, instanceId: INSTANCE, simulatorUdid: UDID });
const PROJECT = `${CACHE}/sources/${WDA_SOURCE_PIN.revision}/WebDriverAgent.xcodeproj`;
const DERIVED = `${CACHE}/builds/${"a".repeat(64)}`;
const plan = createWdaBuildPlan({ checkoutPath: `${CACHE}/sources/${WDA_SOURCE_PIN.revision}`,
  derivedDataPath: DERIVED, simulatorUdid: UDID, ownerFingerprint: FINGERPRINT,
  architecture: "arm64", controlPort: 18100, mjpegPort: 19100 });

function inventory(rows: readonly string[], commands: ReadonlyMap<number, string | null>,
  calls: Array<{ pid: number; env: boolean }> = []): WdaProcessInventoryReader {
  return { listExecutables: async () => [`${process.pid} 777 /usr/local/bin/node`, ...rows].join("\n"),
    readCandidate: async (pid, env) => { calls.push({ pid, env }); return commands.get(pid) ?? null; } };
}

function inspect(reader: WdaProcessInventoryReader, signal?: AbortSignal) {
  return inspectWdaOrphanProcesses({ cacheRoot: CACHE, instanceId: INSTANCE, simulatorUdid: UDID,
    coreSimulatorRoot: CORE, platform: "darwin", reader, signal });
}

it("proves an exact current build or launch controller without reading unrelated process argv", async () => {
  const launch = `${plan.launch.command} ${plan.launch.args.join(" ")}`;
  const build = `${plan.build.command} ${plan.build.args.join(" ")}`;
  const calls: Array<{ pid: number; env: boolean }> = [];
  const reader = inventory(["301 301 /usr/bin/xcodebuild", "302 302 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild",
    "303 303 /usr/bin/git"], new Map([
    [301, `301 301 ${launch}`],
    [302, `302 302 ${build.replace("/usr/bin/xcodebuild", "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild")}`]
  ]), calls);
  expect(await inspect(reader)).toEqual({ ownedGroupIds: [301, 302], conflict: false });
  expect(calls).toEqual([{ pid: 301, env: false }, { pid: 302, env: false }]);
});

it("keeps same-device foreign or altered commands as conflicts and never grants them ownership", async () => {
  const launch = `${plan.launch.command} ${plan.launch.args.join(" ")}`;
  const foreign = launch.replace(FINGERPRINT, "b".repeat(64));
  const wrongProject = launch.replace(PROJECT, "/private/other/WebDriverAgent.xcodeproj");
  const unrelated = launch.replace(UDID, "B0123456-1234-1234-1234-123456789ABC");
  const alternateDestination = launch.replace(`platform=iOS Simulator,id=${UDID},arch=arm64`, `id=${UDID},arch=arm64`);
  const reader = inventory(["311 311 /usr/bin/xcodebuild", "312 312 /usr/bin/xcodebuild",
    "313 313 /usr/bin/xcodebuild", "314 777 /usr/bin/xcodebuild", "315 315 /usr/bin/xcodebuild"], new Map([
    [311, `311 311 ${foreign}`], [312, `312 312 ${wrongProject}`],
    [313, `313 313 ${unrelated}`], [314, `314 777 ${launch}`],
    [315, `315 315 ${alternateDestination}`]
  ]));
  expect(await inspect(reader)).toEqual({ ownedGroupIds: [], conflict: true });
  expect(await inspect(inventory(["315 315 /usr/bin/xcodebuild"],
    new Map([[315, `315 315 ${alternateDestination}`]]))))
    .toEqual({ ownedGroupIds: [], conflict: true });
});

it("reads environment only for the exact Simulator runner and requires one owner marker", async () => {
  const executable = `${CORE}/Devices/${UDID}/data/Containers/Bundle/Application/` +
    "B0123456-1234-1234-1234-123456789ABC/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner";
  const otherDevice = executable.replace(UDID, "C0123456-1234-1234-1234-123456789ABC");
  const calls: Array<{ pid: number; env: boolean }> = [];
  const reader = inventory([`401 401 ${executable}`, `402 402 ${executable}`, `403 403 ${otherDevice}`],
    new Map([[401, `401 401 ${executable} UPGRADE_TIMESTAMP=${FINGERPRINT} OTHER_PRIVATE=value`],
      [402, `402 402 ${executable} UPGRADE_TIMESTAMP=${FINGERPRINT} UPGRADE_TIMESTAMP=${FINGERPRINT}`]]), calls);
  expect(await inspect(reader)).toEqual({ ownedGroupIds: [401], conflict: true });
  expect(calls).toEqual([{ pid: 401, env: true }, { pid: 402, env: true }]);
});

it("fails closed on changed PID identity, bounded inventory and cancellation without returning process text", async () => {
  const launch = `${plan.launch.command} ${plan.launch.args.join(" ")}`;
  const changed = inventory(["501 501 /usr/bin/xcodebuild"], new Map([[501, `501 502 ${launch} SECRET=value`]]));
  await expect(inspect(changed)).rejects.toMatchObject({ code: "INSPECTION_FAILED",
    message: "Driver process ownership could not be verified." });
  const many = inventory(Array.from({ length: 129 }, (_, i) => `${i + 1000} ${i + 1000} /usr/bin/xcodebuild`), new Map());
  await expect(inspect(many)).rejects.toMatchObject({ code: "INSPECTION_FAILED" });
  const oversized = inventory(["502 502 /usr/bin/xcodebuild"],
    new Map([[502, `502 502 ${launch}${"X".repeat(65_536)}`]]));
  await expect(inspect(oversized)).rejects.toMatchObject({ code: "INSPECTION_FAILED" });
  const vanished = inventory(["503 503 /usr/bin/xcodebuild"], new Map([[503, null]]));
  expect(await inspect(vanished)).toEqual({ ownedGroupIds: [], conflict: false });
  const controller = new AbortController();
  const aborting: WdaProcessInventoryReader = { listExecutables: async () => { controller.abort(); return ""; },
    readCandidate: async () => { throw new Error("must not read"); } };
  await expect(inspect(aborting, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  await expect(inspectWdaOrphanProcesses({ cacheRoot: CACHE, instanceId: INSTANCE,
    simulatorUdid: UDID, platform: "win32" })).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
});
