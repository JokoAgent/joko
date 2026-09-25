import { expect, it } from "vitest";
import { createWdaBuildPlan, createWdaOwnerFingerprint } from "./wda-build-plan.js";
import { cleanupWdaOrphanProcesses, type WdaOrphanCleanupInput } from "./wda-orphan-cleaner.js";
import type { WdaProcessInventoryReader } from "./wda-orphan-inspector.js";
import { WDA_SOURCE_PIN } from "./wda-source-pin.js";

const CACHE = "/private/joko/driver-cache";
const UDID = "A0123456-1234-1234-1234-123456789ABC";
const FINGERPRINT = createWdaOwnerFingerprint({ cacheRoot: CACHE, instanceId: "instance-1", simulatorUdid: UDID });
const plan = createWdaBuildPlan({ checkoutPath: `${CACHE}/sources/${WDA_SOURCE_PIN.revision}`,
  derivedDataPath: `${CACHE}/builds/${"a".repeat(64)}`, simulatorUdid: UDID,
  ownerFingerprint: FINGERPRINT, architecture: "arm64", controlPort: 18100, mjpegPort: 19100 });
const COMMAND = `${plan.launch.command} ${plan.launch.args.join(" ")}`;
const OWN_ROW = `${process.pid} 777 /usr/local/bin/node`;
const CANDIDATE = "301 301 /usr/bin/xcodebuild";

function input(reader: WdaProcessInventoryReader, extra: Partial<WdaOrphanCleanupInput> = {}): WdaOrphanCleanupInput {
  return { cacheRoot: CACHE, instanceId: "instance-1", simulatorUdid: UDID,
    coreSimulatorRoot: "/Users/joko/Library/Developer/CoreSimulator", platform: "darwin", reader, ...extra };
}

it("re-reads the exact leader before signalling, waits for exit and checks the device again", async () => {
  let alive = true;
  let listCount = 0;
  let readCount = 0;
  const signals: number[] = [];
  const reader: WdaProcessInventoryReader = {
    listExecutables: async () => { listCount += 1; return [OWN_ROW, ...(alive ? [CANDIDATE] : [])].join("\n"); },
    readCandidate: async () => { readCount += 1; return `301 301 ${COMMAND}`; }
  };
  await cleanupWdaOrphanProcesses(input(reader, { groupControl: {
    signal: (id, signal) => { expect(signal).toBe("SIGKILL"); signals.push(id); alive = false; },
    isAlive: () => alive
  } }));
  expect(signals).toEqual([301]);
  expect(listCount).toBe(3);
  expect(readCount).toBe(2);
});

it("does not signal a reused PID or a foreign same-device controller", async () => {
  let reads = 0;
  const signals: number[] = [];
  const changed = COMMAND.replace(FINGERPRINT, "b".repeat(64));
  const reader: WdaProcessInventoryReader = {
    listExecutables: async () => `${OWN_ROW}\n${CANDIDATE}`,
    readCandidate: async () => { reads += 1; return `301 301 ${reads === 1 ? COMMAND : changed}`; }
  };
  await expect(cleanupWdaOrphanProcesses(input(reader, { groupControl: {
    signal: id => { signals.push(id); }, isAlive: () => true
  } }))).rejects.toMatchObject({ code: "CONFLICT" });
  expect(signals).toEqual([]);
  expect(reads).toBe(3);
});

it("reports signal failure and a still-running group without claiming cleanup", async () => {
  const reader: WdaProcessInventoryReader = {
    listExecutables: async () => `${OWN_ROW}\n${CANDIDATE}`,
    readCandidate: async () => `301 301 ${COMMAND}`
  };
  await expect(cleanupWdaOrphanProcesses(input(reader, { groupControl: {
    signal: () => { throw new Error("private host failure"); }, isAlive: () => true
  } }))).rejects.toMatchObject({ code: "TERMINATION_FAILED",
    message: "Owned driver process could not be terminated." });
  let now = 0;
  await expect(cleanupWdaOrphanProcesses(input(reader, { groupControl: {
    signal: () => undefined, isAlive: () => true
  }, clock: { now: () => now, sleep: async () => { now += 1_000; } } })))
    .rejects.toMatchObject({ code: "TERMINATION_FAILED" });
});

it("propagates cancellation during revalidation without signalling", async () => {
  const controller = new AbortController();
  let reads = 0;
  const signals: number[] = [];
  const reader: WdaProcessInventoryReader = {
    listExecutables: async () => `${OWN_ROW}\n${CANDIDATE}`,
    readCandidate: async () => { reads += 1; if (reads === 2) controller.abort(); return `301 301 ${COMMAND}`; }
  };
  await expect(cleanupWdaOrphanProcesses(input(reader, { signal: controller.signal,
    groupControl: { signal: id => { signals.push(id); }, isAlive: () => true } })))
    .rejects.toMatchObject({ code: "CANCELLED" });
  expect(signals).toEqual([]);
});
