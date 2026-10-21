import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoNotificationStartupError, parseCrashReport, parseVirtualMemory, projectOwnedCrash, summarizeProcesses } from "./mobile-ios-runtime-diagnostics.mjs";

test("rejects the observed native initialization error without rejecting intended local transport errors", () => {
  assert.throws(() => assertNoNotificationStartupError("ERROR [expo-notifications] Error reading persisted server registration info: private-value"),
    { message: "Native notification Keychain initialization failed; see metro.log." });
  assert.doesNotThrow(() => assertNoNotificationStartupError("CI local identity probe unavailable: 503"));
  assert.doesNotThrow(() => assertNoNotificationStartupError("iOS Bundled apps/mobile/index.ts"));
});

test("aggregates numeric OS workload groups without retaining process identity or arbitrary text", () => {
  const result = summarizeProcesses(" 31.5 2048 U /System/Library/mdworker_shared\n"
    + " 10.1 1024 R+ /Library/Developer/CoreSimulator/Volumes/private-name/installd\n"
    + " 0.2 512 S /private-credential-value/private-process\n"
    + " -1 100 R invalid\n 0 9007199254740992 R invalid\n");
  assert.deepEqual(result.total, { count: 3, cpuPercent: 41.8, rssKiB: 3584, running: 1, uninterruptible: 1 });
  assert.equal(result.groups.spotlight.uninterruptible, 1);
  assert.equal(result.groups.installer.running, 1);
  assert.equal(result.groups.other.count, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|Library|installd|mdworker/u);
  assert.throws(() => summarizeProcesses("not a process observation"));
});

test("projects page size and selected VM counters without preserving unknown fields", () => {
  const result = parseVirtualMemory("Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
    + "Pages free: 123.\nPages occupied by compressor: 456.\nSwapouts: 789.\n"
    + "private-credential-value: 42.\nPages active: invalid\n");
  assert.deepEqual(result, { pageSizeBytes: 16384, counters: { free: 123, compressor: 456, swapouts: 789 } });
  assert.throws(() => parseVirtualMemory("unknown output"));
});

const simulatorUdid = "12345678-1234-1234-1234-123456789ABC";
const suffix = `/${simulatorUdid}/data/Containers/Bundle/Application/current/Joko.app/Joko`;
const owner = { simulatorUdid, bundleId: "app.joko.mobile", installedExecutable: `/Users/runner/Devices${suffix}` };
const report = () => ({ pid: 412, procPath: owner.installedExecutable,
  bundleInfo: { CFBundleIdentifier: owner.bundleId }, exception: { type: "EXC_CRASH", signal: "SIGKILL" },
  termination: { namespace: "SPRINGBOARD", code: 0x8badf00d } });

test("reads the current two-object IPS shape and projects an owned watchdog termination", () => {
  const decoded = parseCrashReport(JSON.stringify({ bug_type: "309" }) + "\n" + JSON.stringify(report(), null, 2));
  const result = projectOwnedCrash(decoded, owner);
  assert.equal(result?.termination.code, 0x8badf00d);
  assert.equal(result?.termination.namespace, "SPRINGBOARD");
  assert.equal(result?.exception.signal, "SIGKILL");
});

test("requires the exact device and installed occurrence even when the home prefix is redacted", () => {
  assert.equal(projectOwnedCrash({ ...report(), procPath: `/Users/USER/*${suffix}` }, owner)?.pid, 412);
  assert.equal(projectOwnedCrash({ ...report(), procPath: owner.installedExecutable.replace("/current/", "/previous/") }, owner), undefined);
  assert.equal(projectOwnedCrash(report(), { ...owner, simulatorUdid: "87654321-1234-1234-1234-123456789ABC" }), undefined);
  assert.equal(projectOwnedCrash({ ...report(), procPath: "/Users/USER/*/Joko.app/Joko" }, owner), undefined);
});

test("rejects other applications and reports without an installed executable", () => {
  assert.equal(projectOwnedCrash({ ...report(), bundleInfo: { CFBundleIdentifier: "other.application" } }, owner), undefined);
  assert.equal(projectOwnedCrash(report(), { ...owner, installedExecutable: undefined }), undefined);
  assert.equal(projectOwnedCrash({ ...report(), pid: -1 }, owner), undefined);
});

test("never projects arbitrary strings, paths, arguments, credentials or report contents", () => {
  const privateValue = "private-credential-value";
  const input = { ...report(), procArgs: [privateValue], threads: [{ text: privateValue }],
    exception: { type: privateValue, signal: privateValue, reason: privateValue },
    termination: { namespace: privateValue, code: privateValue, indicator: privateValue } };
  const projected = projectOwnedCrash(input, owner);
  assert.deepEqual(projected, { pid: 412, exception: { type: null, signal: null }, termination: { namespace: null, code: null } });
  assert.equal(JSON.stringify(projected).includes(privateValue), false);
  assert.equal(JSON.stringify(projected).includes("/Users/"), false);
});
