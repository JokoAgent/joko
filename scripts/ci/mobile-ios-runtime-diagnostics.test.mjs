import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoNotificationStartupError, isUiRunnerAccessibilityStartupFailure, parseCrashReport, parseVirtualMemory, projectOwnedCrash, projectOwnedStartupLogs, summarizeProcesses } from "./mobile-ios-runtime-diagnostics.mjs";

test("retries only the pre-test accessibility runner failure with no application requests", () => {
  const failure = { targetName: "JokoCIUITests", testIdentifierString: "JokoCIUITests-Runner (25861) encountered an error",
    failureText: "The test runner failed to initialize for UI testing. (Underlying Error: Timed out waiting for AX loaded notification)" };
  const summary = { result: "Failed", totalTestCount: 1, passedTests: 0, failedTests: 1, skippedTests: 0, testFailures: [failure] };
  assert.equal(isUiRunnerAccessibilityStartupFailure(summary, 0, 0), true);
  for (const changed of [undefined, {}, { ...summary, passedTests: 1 }, { ...summary, skippedTests: 1 },
    { ...summary, testFailures: [failure, failure] }, { ...summary, testFailures: [{ ...failure, failureText: "Assertion failed" }] },
    { ...summary, testFailures: [{ ...failure, testIdentifierString: "JokoConnectionUITests/testConnectionPageInteractions" }] }]) {
    assert.equal(isUiRunnerAccessibilityStartupFailure(changed, 0, 0), false);
  }
  assert.equal(isUiRunnerAccessibilityStartupFailure(summary, 1, 0), false);
  assert.equal(isUiRunnerAccessibilityStartupFailure(summary, 0, 1), false);
});

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

test("projects only fixed WebKit startup counters for the exact pre-input process and time window", () => {
  const startedAt = Date.parse("2026-10-24T21:12:00Z"), finishedAt = startedAt + 180_000;
  const startupOwner = { ...owner, startup: { pid: 412, startedAt, finishedAt } };
  const record = { processID: 412, processImagePath: owner.installedExecutable, timestamp: "2026-10-24 21:12:05.123456+0000",
    subsystem: "com.apple.WebKit", eventMessage: "WebProcessProxy::didFinishLaunching: Invalid connection identifier private-credential-value" };
  const result = projectOwnedStartupLogs([record,
    { ...record, processID: 413 },
    { ...record, processImagePath: owner.installedExecutable.replace("/current/", "/previous/") },
    { ...record, timestamp: "2026-10-24T21:11:59Z" },
    { ...record, timestamp: "2026-10-24T21:15:01Z" },
    { ...record, timestamp: "private-credential-value" },
    { ...record, subsystem: "unrelated.application" },
    { ...record, eventMessage: "WebProcessProxy::didBecomeUnresponsive: https://private.example/token" }
  ], startupOwner);
  assert.deepEqual(result, { examinedRecords: 8, ownedRecords: 3, webKitRecords: 2,
    events: { launchMessages: 1, launchFailures: 1, processTerminations: 0, unresponsive: 1,
      provisionalLoadFailures: 0, loadFailures: 0, finishedLoads: 0 } });
  assert.doesNotMatch(JSON.stringify(result), /private|token|https|Users|Joko/u);
  for (const changed of [{ ...startupOwner, startup: undefined }, { ...startupOwner, installedExecutable: undefined },
    { ...startupOwner, simulatorUdid: "other-device" }, { ...startupOwner, startup: { pid: -1, startedAt, finishedAt } }]) {
    assert.throws(() => projectOwnedStartupLogs([record], changed));
  }
});
