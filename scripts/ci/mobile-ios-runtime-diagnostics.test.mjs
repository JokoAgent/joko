import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoNotificationStartupError, isUiRunnerAccessibilityStartupFailure, locateInstalledSimulatorApplication, parseCrashReport, parseVirtualMemory, projectOwnedCrash, projectOwnedStartupLogs, requireSimulatorApplicationContainer, summarizeProcesses } from "./mobile-ios-runtime-diagnostics.mjs";

function containerLookup(replies) {
  const calls = [], controller = new AbortController();
  const owner = { simulatorUdid: "12345678-1234-1234-1234-123456789ABC", bundleId: "app.joko.mobile", deviceName: "joko-ci-owned" };
  let receipt, current = true, retries = 0;
  return { calls, controller, retire: () => { current = false; }, get retries() { return retries; },
    options: { owner, signal: controller.signal, isCurrent: () => current, getReceipt: () => receipt,
      onRetry: () => { retries++; }, command: async (binary, args, options) => {
        calls.push({ binary, args: [...args], ...options });
        const reply = replies.shift();
        assert.notEqual(reply, undefined, "The lookup issued an unexpected extra query.");
        receipt = { step: options.startupLabel, timeoutMs: options.timeout, elapsedMs: 1,
          result: "passed", exitCode: 0, signal: null, killed: false, cancelled: false,
          stdoutBytes: typeof reply === "string" ? Buffer.byteLength(reply) : 0, ...reply?.receipt };
        if (reply?.error) throw reply.error;
        return reply;
      } } };
}

test("reads only the exact owned application and repeats an empty host reply once", async () => {
  const container = "/Users/runner/Devices/owned/Joko.app";
  for (const replies of [[container], ["", container]]) {
    const lookup = containerLookup([...replies]);
    assert.equal(await locateInstalledSimulatorApplication(lookup.options), container);
    assert.equal(lookup.calls.length, replies.length);
    assert.equal(lookup.retries, replies.length - 1);
    for (const call of lookup.calls) {
      assert.equal(call.binary, "xcrun");
      assert.deepEqual(call.args, ["simctl", "get_app_container", lookup.options.owner.simulatorUdid, "app.joko.mobile", "app"]);
      assert.equal(call.timeout, 30_000);
    }
    assert.deepEqual(lookup.calls.map(call => call.startupLabel),
      replies.length === 1 ? ["locate-installed-application"] : ["locate-installed-application", "retry-locate-installed-application"]);
  }
});

test("rejects empty, relative and multiline container paths without resolving against the repository", async () => {
  for (const value of ["", "Joko.app", "./Joko.app", "../Joko.app", " /Users/runner/Joko.app", "/Users/runner/Joko.app\nother", "C:\\Joko.app"]) {
    assert.throws(() => requireSimulatorApplicationContainer(value), /absolute container path/u);
  }
  for (const replies of [["", ""], ["", "relative/Joko.app"], ["relative/Joko.app"]]) {
    const lookup = containerLookup([...replies]);
    await assert.rejects(locateInstalledSimulatorApplication(lookup.options), /absolute container path/u);
    assert.equal(lookup.calls.length, replies.length);
  }
});

test("keeps the previous killed-query recovery bounded to one read and rejects other command failures", async () => {
  const error = new Error("The host query failed.");
  const killed = { error, receipt: { result: "failed", exitCode: null, errorCode: null, signal: "SIGTERM", killed: true, elapsedMs: 30_001 } };
  const lookup = containerLookup([killed, "/Users/runner/Devices/owned/Joko.app"]);
  await locateInstalledSimulatorApplication(lookup.options);
  assert.equal(lookup.calls.length, 2);
  for (const changed of [{ signal: "SIGKILL" }, { exitCode: 1 }, { cancelled: true }, { elapsedMs: 29_999 }]) {
    const rejected = containerLookup([{ error, receipt: { ...killed.receipt, ...changed } }]);
    await assert.rejects(locateInstalledSimulatorApplication(rejected.options), error);
    assert.equal(rejected.calls.length, 1);
  }
});

test("never repeats a query after owner replacement or cancellation", async () => {
  for (const retire of [lookup => lookup.retire(), lookup => lookup.controller.abort()]) {
    const lookup = containerLookup([""]);
    const command = lookup.options.command;
    lookup.options.command = async (...args) => { const result = await command(...args); retire(lookup); return result; };
    await assert.rejects(locateInstalledSimulatorApplication(lookup.options));
    assert.equal(lookup.calls.length, 1);
    assert.equal(lookup.retries, 0);
  }
});

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
