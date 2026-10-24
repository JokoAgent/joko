import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { availableParallelism, freemem, homedir, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function isUiRunnerAccessibilityStartupFailure(summary, identityRequests, unexpectedRequests) {
  const failure = summary?.testFailures?.[0];
  return identityRequests === 0 && unexpectedRequests === 0
    && summary?.result === "Failed" && summary.totalTestCount === 1
    && summary.passedTests === 0 && summary.failedTests === 1 && summary.skippedTests === 0
    && Array.isArray(summary.testFailures) && summary.testFailures.length === 1 && failure?.targetName === "JokoCIUITests"
    && /^JokoCIUITests-Runner \(\d+\) encountered an error$/.test(failure.testIdentifierString)
    && failure.failureText === "The test runner failed to initialize for UI testing. (Underlying Error: Timed out waiting for AX loaded notification)";
}
const processGroups = new Map([
  ["mds", "spotlight"], ["mds_stores", "spotlight"], ["mdworker", "spotlight"], ["mdworker_shared", "spotlight"],
  ["simdiskimaged", "runtimeImages"], ["com.apple.CoreSimulator.CoreSimulatorService", "simulatorService"],
  ["CoreSimulatorService", "simulatorService"], ["launchd_sim", "simulatorLaunchd"], ["Simulator", "simulatorWindow"],
  ["SpringBoard", "springboard"], ["backboardd", "backboard"], ["installd", "installer"],
  ["trustd", "trust"], ["PosterBoard", "wallpaper"], ["WallpaperAgent", "wallpaper"],
  ["swift-frontend", "compiler"], ["swiftc", "compiler"], ["clang", "compiler"], ["xcodebuild", "compiler"],
  ["node", "node"]
]);
const memoryCounters = new Map([
  ["Pages free", "free"], ["Pages active", "active"], ["Pages inactive", "inactive"],
  ["Pages speculative", "speculative"], ["Pages wired down", "wired"], ["Pages purgeable", "purgeable"],
  ["Pages stored in compressor", "storedInCompressor"], ["Pages occupied by compressor", "compressor"],
  ["Pageouts", "pageouts"], ["Swapins", "swapins"], ["Swapouts", "swapouts"]
]);

export function summarizeProcesses(text) {
  const empty = () => ({ count: 0, cpuPercent: 0, rssKiB: 0, running: 0, uninterruptible: 0 });
  const result = { total: empty(), groups: {} };
  for (const line of text.split("\n")) {
    const row = /^\s*(\d+(?:\.\d+)?)\s+(\d+)\s+([A-Z][A-Za-z+<>-]*)\s+(.+)$/u.exec(line);
    if (!row) continue;
    const cpuPercent = Number(row[1]), rssKiB = Number(row[2]);
    if (!Number.isFinite(cpuPercent) || !Number.isSafeInteger(rssKiB)) continue;
    const name = row[4].slice(row[4].lastIndexOf("/") + 1);
    const group = processGroups.get(name) ?? "other";
    result.groups[group] ??= empty();
    for (const values of [result.total, result.groups[group]]) {
      values.count++; values.cpuPercent += cpuPercent; values.rssKiB += rssKiB;
      if (row[3].startsWith("R")) values.running++;
      if (row[3].startsWith("U")) values.uninterruptible++;
    }
  }
  if (!result.total.count) throw new Error("No numeric process observations were available.");
  for (const values of [result.total, ...Object.values(result.groups)]) values.cpuPercent = Math.round(values.cpuPercent * 100) / 100;
  // RSS sums include shared pages; neither names, paths, arguments nor PIDs are retained.
  return result;
}

export function parseVirtualMemory(text) {
  const header = /Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)/u.exec(text);
  const pageSizeBytes = Number(header?.[1]);
  if (!Number.isSafeInteger(pageSizeBytes) || pageSizeBytes <= 0) throw new Error("No virtual-memory page size was available.");
  const counters = {};
  for (const line of text.split("\n")) {
    const row = /^([^:]+):\s+(\d+)\.\s*$/u.exec(line);
    const key = memoryCounters.get(row?.[1]);
    if (key && Number.isSafeInteger(Number(row[2]))) counters[key] = Number(row[2]);
  }
  return { pageSizeBytes, counters };
}

export async function collectHostResources() {
  const result = { host: { architecture: process.arch, logicalCpuCount: availableParallelism(),
    totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), loadAverage: loadavg(), observerRssBytes: process.memoryUsage().rss } };
  if (process.platform !== "darwin") return result;
  const read = async (binary, args, parse) => {
    try { return parse((await exec(binary, args, { timeout: 5_000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: "C" } })).stdout); }
    catch { return null; }
  };
  [result.processes, result.virtualMemory] = await Promise.all([
    read("/bin/ps", ["-A", "-ww", "-o", "pcpu=,rss=,state=,comm="], summarizeProcesses),
    read("/usr/bin/vm_stat", [], parseVirtualMemory)
  ]);
  return result;
}

const exceptionTypes = new Set(["EXC_BAD_ACCESS", "EXC_BAD_INSTRUCTION", "EXC_ARITHMETIC",
  "EXC_EMULATION", "EXC_SOFTWARE", "EXC_BREAKPOINT", "EXC_CRASH", "EXC_RESOURCE", "EXC_GUARD"]);
const signals = new Set(["SIGABRT", "SIGBUS", "SIGFPE", "SIGILL", "SIGKILL", "SIGSEGV", "SIGTERM", "SIGTRAP"]);
const namespaces = new Set(["SIGNAL", "CODESIGNING", "DYLD", "FRONTBOARD", "RUNNINGBOARD",
  "SPRINGBOARD", "WATCHDOG", "LIBSYSTEM", "GUARD", "TCC", "WEBKIT", "METAL"]);
const known = (values, value) => values.has(value) ? value : null;
const code = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function assertNoNotificationStartupError(log) {
  if (log.includes("[expo-notifications] Error reading persisted server registration info:")) {
    throw new Error("Native notification Keychain initialization failed; see metro.log.");
  }
}

export function parseCrashReport(text) {
  // Current IPS reports contain a metadata JSON line followed by the report JSON.
  const boundary = text.indexOf("\n");
  if (boundary < 0) throw new Error("The IPS metadata boundary is missing.");
  JSON.parse(text.slice(0, boundary));
  return JSON.parse(text.slice(boundary + 1));
}

export function projectOwnedCrash(report, owner) {
  if (typeof owner.installedExecutable !== "string" || !owner.installedExecutable
    || typeof owner.bundleId !== "string" || !owner.bundleId
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(owner.simulatorUdid ?? "")
    || report?.bundleInfo?.CFBundleIdentifier !== owner.bundleId
    || typeof report.procPath !== "string" || !Number.isSafeInteger(report.pid) || report.pid <= 1) return undefined;
  const marker = `/${owner.simulatorUdid}/`;
  const start = owner.installedExecutable.indexOf(marker);
  // Apple may redact the home-directory prefix. The exact owned device and
  // installation suffix must still match; redacted ownership is never guessed.
  if (start < 0 || !report.procPath.endsWith(owner.installedExecutable.slice(start))) return undefined;
  return { pid: report.pid,
    exception: { type: known(exceptionTypes, report.exception?.type), signal: known(signals, report.exception?.signal) },
    termination: { namespace: known(namespaces, report.termination?.namespace), code: code(report.termination?.code) } };
}

export function projectOwnedStartupLogs(records, owner) {
  const startup = owner.startup;
  const marker = `/${owner.simulatorUdid}/`, start = owner.installedExecutable?.indexOf(marker) ?? -1;
  if (!Array.isArray(records) || start < 0 || !owner.bundleId
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(owner.simulatorUdid ?? "")
    || !Number.isSafeInteger(startup?.pid) || startup.pid <= 1
    || !Number.isFinite(startup.startedAt) || !Number.isFinite(startup.finishedAt) || startup.finishedAt < startup.startedAt) {
    throw new Error("No exact pre-input application occurrence is available for startup logs.");
  }
  const suffix = owner.installedExecutable.slice(start);
  const events = { launchMessages: 0, launchFailures: 0, processTerminations: 0, unresponsive: 0,
    provisionalLoadFailures: 0, loadFailures: 0, finishedLoads: 0 };
  let ownedRecords = 0, webKitRecords = 0;
  for (const record of records) {
    if (record?.processID !== startup.pid || typeof record.processImagePath !== "string" || !record.processImagePath.endsWith(suffix)) continue;
    const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    if (!Number.isFinite(timestamp) || timestamp < startup.startedAt || timestamp > startup.finishedAt) continue;
    ownedRecords++;
    if (record.subsystem !== "com.apple.WebKit" || typeof record.eventMessage !== "string") continue;
    webKitRecords++;
    // Retain only fixed event counters. Native log messages can contain URLs,
    // credentials or page text and must never enter the evidence artifact.
    const message = record.eventMessage;
    if (message.includes("WebProcessProxy::didFinishLaunching:")) events.launchMessages++;
    if (message.includes("WebProcessProxy::didFinishLaunching: Invalid connection identifier")) events.launchFailures++;
    if (message.includes("WebProcessProxy::processDidTerminateOrFailedToLaunch:")) events.processTerminations++;
    if (message.includes("WebProcessProxy::didBecomeUnresponsive:")) events.unresponsive++;
    if (message.includes("WebPageProxy::didFailProvisionalLoadForFrame:")) events.provisionalLoadFailures++;
    if (message.includes("WebPageProxy::didFailLoadForFrame:")) events.loadFailures++;
    if (message.includes("WebPageProxy::didFinishLoadForFrame:")) events.finishedLoads++;
  }
  return { examinedRecords: records.length, ownedRecords, webKitRecords, events };
}

async function collectOwnedStartupLogs(owner) {
  const startup = owner.startup;
  if (!Number.isSafeInteger(startup?.pid) || startup.pid <= 1 || !Number.isFinite(startup.startedAt)
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(owner.simulatorUdid ?? "")
    || !owner.installedExecutable || !owner.bundleId) return undefined;
  const seconds = Math.ceil((Date.now() - startup.startedAt) / 1000);
  if (seconds < 1 || seconds > 600) return { unavailable: true };
  const options = { timeout: 5_000, maxBuffer: 512 * 1024, signal: AbortSignal.timeout(5_000) };
  try {
    const assertOccurrence = async () => {
      const { stdout } = await exec("/bin/ps", ["-ww", "-p", String(startup.pid), "-o", "comm="], options);
      if (await realpath(stdout.trim()) !== owner.installedExecutable) throw new Error("The startup process occurrence changed.");
    };
    await assertOccurrence();
    const { stdout } = await exec("xcrun", ["simctl", "spawn", owner.simulatorUdid, "log", "show", "--style", "json", "--info",
      "--last", `${seconds}s`, "--predicate", `processID == ${startup.pid}`], options);
    await assertOccurrence();
    return { pidVerifiedBeforeAndAfter: true, timeoutMs: 5_000, maximumBytes: 512 * 1024,
      ...projectOwnedStartupLogs(JSON.parse(stdout), { ...owner, startup: { ...startup, finishedAt: Date.now() } }) };
  } catch { return { unavailable: true, timeoutMs: 5_000, maximumBytes: 512 * 1024 }; }
}

export async function collectRuntimeFailureDiagnostics(owner) {
  const result = { ...await collectHostResources(),
    installedApplicationLocated: Boolean(owner.installedExecutable), examinedReports: 0, unreadableReports: 0, ownedCrashes: [] };
  if (!owner.installedExecutable || !owner.executable) return result;
  // The caller supplies startup only before any connection input or XCTest.
  // Query only the verified app PID inside its exact owned Simulator.
  if (process.platform === "darwin" && owner.startup) result.preInputStartupLogs = await collectOwnedStartupLogs(owner);
  const directory = join(homedir(), "Library", "Logs", "DiagnosticReports");
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(`${owner.executable}-`) || !entry.name.endsWith(".ips")) continue;
    const file = join(directory, entry.name);
    const info = await lstat(file).catch(() => undefined);
    if (info?.isFile() && !info.isSymbolicLink() && info.mtimeMs >= owner.startedAt && info.size <= 2 * 1024 * 1024) {
      candidates.push({ file, modified: info.mtimeMs });
    }
  }
  for (const candidate of candidates.sort((a, b) => b.modified - a.modified).slice(0, 8)) {
    result.examinedReports++;
    try {
      const report = parseCrashReport(await readFile(candidate.file, { encoding: "utf8", signal: AbortSignal.timeout(2_000) }));
      const projected = projectOwnedCrash(report, owner);
      if (projected) result.ownedCrashes.push(projected);
    } catch { result.unreadableReports++; }
  }
  return result;
}
