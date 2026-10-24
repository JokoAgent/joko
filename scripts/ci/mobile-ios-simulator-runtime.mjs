import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assertNoNotificationStartupError, collectHostResources, collectRuntimeFailureDiagnostics, isUiRunnerAccessibilityStartupFailure } from "./mobile-ios-runtime-diagnostics.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const startupDiagnosticsOnly = process.argv.length === 3 && process.argv[2] === "--startup-diagnostics";
const abort = new AbortController();
const observationStartedAt = Date.now();
// A full run includes up to ten minutes of cold boot and two five-minute
// XCTest commands, plus app startup, frame capture and evidence export.
const observationBudgetMs = (startupDiagnosticsOnly ? 4 : 30) * 60_000;
const observationDeadlineAt = observationStartedAt + observationBudgetMs;
const simulatorInstallTimeoutMs = 120_000;
const simulatorLaunchTimeoutMs = 120_000;
const deadline = setTimeout(() => abort.abort(new Error("iOS startup and UI operation deadline exceeded.")),
  observationBudgetMs);
const stop = () => abort.abort(new Error("iOS startup observation was cancelled."));
process.once("SIGINT", stop); process.once("SIGTERM", stop);
let evidence, udid, deviceName, bundleId, executable, installedExecutable, metro, metroClosed = false;
let preInputApplication;
let stage = "preconditions";
const startupCommandReceipts = [];
const hostResourceSnapshots = [];
const startupCommandLabels = new Set(["list-ios-runtimes", "list-device-types", "list-available-devices",
  "create-owned-simulator", "boot-owned-simulator", "wait-owned-boot", "set-light-appearance",
  "install-owned-application", "locate-installed-application", "retry-locate-installed-application", "launch-owned-application", "capture-simulator-springboard",
  "locate-application-after-install-timeout",
  "capture-pre-appearance-framebuffer", "retry-pre-appearance-framebuffer", "read-initial-appearance", "read-final-appearance", "compile-screen-observer",
  "locate-launched-application-process", "locate-ui-tested-application-process",
  "locate-pre-ui-build-application-process", "locate-post-ui-build-application-process",
  "ocr-first-launch-frame", "ocr-reopened-frame"]);

function save(name, value) { writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + "\n"); }
async function recordHostResources(phase) {
  hostResourceSnapshots.push({ phase, elapsedMs: Date.now() - observationStartedAt, ...await collectHostResources() });
  save("runtime-host-resources.json", { snapshots: hostResourceSnapshots });
}
async function command(binary, args, { timeout = 30_000, cleanup = false, startupLabel } = {}) {
  if (startupLabel !== undefined && !startupCommandLabels.has(startupLabel)) throw new Error("Unknown Simulator startup observation label.");
  const started = performance.now();
  const receipt = startupLabel === undefined ? undefined : { step: startupLabel, result: "running", timeoutMs: timeout };
  const record = () => {
    if (receipt === undefined) return;
    receipt.elapsedMs = Math.round(performance.now() - started);
    receipt.cancelled = !cleanup && abort.signal.aborted;
    save("startup-command-receipts.json", { commands: startupCommandReceipts });
  };
  const byteLength = value => typeof value === "string" || Buffer.isBuffer(value) ? Buffer.byteLength(value) : 0;
  if (receipt !== undefined) { startupCommandReceipts.push(receipt); record(); }
  try {
    const value = await exec(binary, args, { cwd: root, timeout, maxBuffer: 4 * 1024 * 1024,
      signal: cleanup ? undefined : abort.signal, windowsHide: true });
    if (receipt !== undefined) Object.assign(receipt, { result: "passed", exitCode: 0, signal: null, killed: false,
      stdoutBytes: byteLength(value.stdout), stderrBytes: byteLength(value.stderr) });
    return value.stdout.trim();
  } catch (error) {
    if (receipt !== undefined) {
      const errorCodes = ["ENOENT", "EACCES", "ETIMEDOUT", "ABORT_ERR", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"];
      const signals = ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGHUP"];
      Object.assign(receipt, { result: "failed", exitCode: Number.isInteger(error.code) ? error.code : null,
        errorCode: errorCodes.includes(error.code) ? error.code : null,
        signal: signals.includes(error.signal) ? error.signal : null, killed: error.killed === true,
        stdoutBytes: byteLength(error.stdout), stderrBytes: byteLength(error.stderr) });
      throw new Error(`Simulator startup step '${startupLabel}' failed; see startup-command-receipts.json.`);
    }
    throw error;
  } finally { record(); }
}
function sim(...args) { return command("xcrun", ["simctl", ...args]); }
async function installOwnedApplication(app) {
  const owner = { udid, bundleId, deviceName };
  const installation = { installerCommandSucceeded: false, installerTimedOut: false,
    noSecondInstallIssued: true, installedExecutableVerified: false };
  try {
    await command("xcrun", ["simctl", "install", udid, app],
      { timeout: simulatorInstallTimeoutMs, startupLabel: "install-owned-application" });
    installation.installerCommandSucceeded = true;
  } catch (error) {
    const receipt = startupCommandReceipts.at(-1);
    if (abort.signal.aborted || !owner.udid || !owner.bundleId || !owner.deviceName?.startsWith("joko-ci-")
      || udid !== owner.udid || bundleId !== owner.bundleId || deviceName !== owner.deviceName
      || receipt?.step !== "install-owned-application" || receipt.result !== "failed"
      || receipt.timeoutMs !== simulatorInstallTimeoutMs || receipt.elapsedMs < receipt.timeoutMs || receipt.cancelled !== false
      || receipt.killed !== true || receipt.signal !== "SIGTERM" || receipt.exitCode !== null || receipt.errorCode !== null) throw error;
    installation.installerTimedOut = true;
    save("installation-state.json", installation);
    // A killed host RPC does not establish whether the device committed its
    // installation. Read that exact application's state once; never reinstall.
    stage = "timed-out installation identity lookup";
    const container = await command("xcrun", ["simctl", "get_app_container", owner.udid, owner.bundleId, "app"],
      { timeout: 30_000, startupLabel: "locate-application-after-install-timeout" });
    return { container, installation };
  }
  return { container: await locateInitiallyInstalledApplication(), installation };
}
async function locateInitiallyInstalledApplication() {
  const ownedUdid = udid, application = bundleId;
  if (!ownedUdid || !application || !deviceName?.startsWith("joko-ci-")) throw new Error("No owned Simulator application is available for the installation query.");
  const args = ["simctl", "get_app_container", ownedUdid, application, "app"];
  stage = "installed application identity lookup";
  try {
    return await command("xcrun", args, { timeout: 30_000, startupLabel: "locate-installed-application" });
  } catch (error) {
    const receipt = startupCommandReceipts.at(-1);
    if (abort.signal.aborted || udid !== ownedUdid || bundleId !== application
      || receipt?.step !== "locate-installed-application" || receipt.result !== "failed"
      || receipt.killed !== true || receipt.signal !== "SIGTERM" || receipt.cancelled !== false
      || receipt.exitCode !== null || receipt.errorCode !== null || receipt.timeoutMs !== 30_000
      || receipt.elapsedMs < receipt.timeoutMs) throw error;
    // Preserve the failed receipt; this one fresh read must independently exit
    // successfully before the original installed-executable hash check runs.
    stage = "retry installed application identity lookup";
    return command("xcrun", args, { timeout: 30_000, startupLabel: "retry-locate-installed-application" });
  }
}
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  const port = server.address().port;
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return port;
}
async function alive(pid) {
  try {
    const path = await command("/bin/ps", ["-ww", "-p", String(pid), "-o", "comm="]);
    return realpathSync(path) === installedExecutable;
  } catch { return false; }
}
function startMetro(port) {
  const cli = join(root, "apps/mobile/node_modules/expo/bin/cli");
  if (!existsSync(cli)) throw new Error("Install the matched checkout's Expo dependencies before starting Metro.");
  // Expo binds the literal localhost name. Match the IPv4 address used by the
  // readiness probe and the Simulator's RCT_jsLocation even when ::1 is first.
  metro = spawn(process.execPath, ["--dns-result-order=ipv4first", cli, "start", "--host", "localhost", "--port", String(port), "--max-workers", "2"], {
    cwd: join(root, "apps/mobile"), detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1", NODE_ENV: "development" }
  });
  let bytes = 0;
  const record = chunk => {
    const remaining = 2 * 1024 * 1024 - bytes;
    if (remaining <= 0) return;
    const visible = Buffer.from(chunk).subarray(0, remaining); bytes += visible.length;
    appendFileSync(join(evidence, "metro.log"), visible);
  };
  metro.stdout.on("data", record); metro.stderr.on("data", record);
  metro.once("error", error => { record(Buffer.from(error.message)); metroClosed = true; });
  metro.once("close", () => { metroClosed = true; });
}
async function waitForMetro(origin) {
  const startedAt = Date.now();
  const until = Date.now() + 90_000;
  let attempts = 0, lastProbe;
  const recordStatus = ready => save("metro-status.json", { origin, ready, attempts, elapsedMs: Date.now() - startedAt,
    nodeDnsResultOrder: "ipv4first", lastProbe });
  while (Date.now() < until) {
    abort.signal.throwIfAborted();
    if (metroClosed) { recordStatus(false); throw new Error("The owned Metro process exited before it became ready; see metro.log."); }
    attempts += 1;
    try {
      const response = await fetch(`${origin}/status`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]) });
      const body = (await response.text()).trim();
      lastProbe = { status: response.status, packagerRunning: body === "packager-status:running" };
      if (response.ok && lastProbe.packagerRunning) { recordStatus(true); return; }
    } catch (error) {
      lastProbe = { error: error.name, code: error.cause?.code ?? null };
      abort.signal.throwIfAborted();
    }
    await delay(1000, undefined, { signal: abort.signal });
  }
  recordStatus(false);
  throw new Error("The matched checkout's Metro server did not become ready.");
}
async function observe(phase, pid, ocr) {
  // Cold framebuffer and OCR reads can time out while the owned app remains
  // alive. Use the existing phase budget for those read-only probes, retaining
  // every failed receipt and requiring the same two fresh product observations.
  const until = Date.now() + 180_000;
  let productSeenAt;
  const captures = [];
  while (Date.now() < until) {
    abort.signal.throwIfAborted();
    assertNoNotificationStartupError(readFileSync(join(evidence, "metro.log"), "utf8"));
    if (metroClosed || !await alive(pid)) throw new Error(`${phase}: the actual app or its Metro server exited.`);
    const image = join(evidence, `${phase}.png`);
    // Every accepted observation must come from a fresh successful capture.
    try { unlinkSync(image); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const started = Date.now();
    try {
      await command("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", image],
        { timeout: Math.min(30_000, Math.max(1, until - Date.now())) });
      captures.push({ succeeded: true, elapsedMs: Date.now() - started });
      save(`${phase}-capture.json`, { captures });
    } catch (error) {
      const timedOut = error.killed === true && error.signal === "SIGTERM" && !abort.signal.aborted;
      captures.push({ succeeded: false, timedOut, killed: error.killed === true,
        exitCode: Number.isInteger(error.code) ? error.code : null,
        signal: error.signal === "SIGTERM" || error.signal === "SIGKILL" ? error.signal : null,
        elapsedMs: Date.now() - started });
      save(`${phase}-capture.json`, { captures });
      productSeenAt = undefined;
      if (!timedOut || Date.now() >= until || metroClosed || !await alive(pid)) throw error;
      continue;
    }
    const ocrLabel = phase === "first-launch" ? "ocr-first-launch-frame" : "ocr-reopened-frame";
    const ocrTimeout = Math.min(30_000, Math.max(1, until - Date.now()));
    let recognized;
    try {
      recognized = await command(ocr, [image], { timeout: ocrTimeout, startupLabel: ocrLabel });
    } catch (error) {
      const receipt = startupCommandReceipts.at(-1);
      productSeenAt = undefined;
      if (abort.signal.aborted || Date.now() >= until || metroClosed
        || receipt?.step !== ocrLabel || receipt.result !== "failed" || receipt.cancelled !== false
        || receipt.timeoutMs !== ocrTimeout || receipt.elapsedMs < receipt.timeoutMs
        || receipt.killed !== true || receipt.signal !== "SIGTERM"
        || receipt.exitCode !== null || receipt.errorCode !== null || !await alive(pid)) throw error;
      continue;
    }
    const screen = JSON.parse(recognized);
    save(`${phase}-screen.json`, screen);
    const text = screen.lines.map(line => line.text).join("\n");
    const blocked = /uncaught|unhandled js|no bundle url|could not connect|unable to resolve module|failed to load bundle|development server|connect to metro|runtime not ready|invariant violation|expo go|development build|would like to|don['’]t allow|find and connect to devices|while using the app/iu.test(text);
    const appVisible = /\bjoko\b/iu.test(text) && /\bnearby\b|saved nodes|add joko node/iu.test(text);
    if (appVisible && !blocked && Date.now() < until) {
      productSeenAt ??= Date.now();
      if (Date.now() - productSeenAt >= 3000) {
        if (metroClosed || !await alive(pid)) throw new Error(`${phase}: the observed app process or its Metro server did not remain alive.`);
        return { phase, pid, visibleProduct: "Joko connection page", screen: `${phase}.png`, text: `${phase}-screen.json`,
          checkedAt: new Date().toISOString(), processRetainedAfterObservation: true, consecutiveVisibleObservations: 2 };
      }
    } else productSeenAt = undefined;
    await delay(3000, undefined, { signal: abort.signal });
  }
  throw new Error(`${phase}: Joko's real connection page was not observed without a loader, error or permission overlay. See the screenshot and OCR; no GUI success is claimed.`);
}
async function launch(port) {
  const ownedUdid = udid, application = bundleId, installed = installedExecutable;
  let output;
  try {
    output = await command("xcrun", ["simctl", "launch", udid, bundleId, "-RCT_jsLocation", `127.0.0.1:${port}`, "-RCT_packager_scheme", "http",
      "-AppleLanguages", "(en)", "-AppleLocale", "en_US"],
      { timeout: simulatorLaunchTimeoutMs, startupLabel: "launch-owned-application" });
  } catch (error) {
    const receipt = startupCommandReceipts.at(-1);
    if (abort.signal.aborted || !ownedUdid || !application || !installed || udid !== ownedUdid
      || bundleId !== application || installedExecutable !== installed || !deviceName?.startsWith("joko-ci-")
      || receipt?.step !== "launch-owned-application" || receipt.result !== "failed"
      || receipt.timeoutMs !== simulatorLaunchTimeoutMs || receipt.elapsedMs < receipt.timeoutMs || receipt.cancelled !== false
      || receipt.killed !== true || receipt.signal !== "SIGTERM" || receipt.exitCode !== null || receipt.errorCode !== null) throw error;
    // A timed-out host launcher can leave a running Simulator application.
    // Query that exact occurrence once; never issue a second launch command.
    const launchStage = stage;
    stage = "launch timeout process identity lookup";
    const pid = await findOwnedApplicationProcess("launch-timeout-recovery");
    stage = launchStage;
    return pid;
  }
  const matched = new RegExp(`^${bundleId.replaceAll(".", "\\.")}:\\s+(\\d+)$`, "u").exec(output);
  if (!matched) throw new Error("simctl did not return the selected app's actual launch PID.");
  const pid = Number(matched[1]);
  if (!Number.isSafeInteger(pid) || pid < 2 || !await alive(pid)) throw new Error("The launch PID does not own the installed Joko executable.");
  return pid;
}

async function findOwnedApplicationProcess(phase) {
  const label = phase === "launch-timeout-recovery" ? "locate-launched-application-process"
    : phase === "post-ui-test" ? "locate-ui-tested-application-process"
    : phase === "pre-ui-build" ? "locate-pre-ui-build-application-process"
    : phase === "post-ui-build" ? "locate-post-ui-build-application-process" : undefined;
  const owner = { udid, bundleId, deviceName, installedExecutable };
  const assertOwner = () => {
    abort.signal.throwIfAborted();
    if (!label || !owner.udid || !owner.bundleId || !owner.installedExecutable || !owner.deviceName?.startsWith("joko-ci-")
      || udid !== owner.udid || bundleId !== owner.bundleId || deviceName !== owner.deviceName
      || installedExecutable !== owner.installedExecutable || metroClosed) {
      throw new Error("No unchanged owned Simulator application is available for the process query.");
    }
  };
  assertOwner();
  const processes = await command("xcrun", ["simctl", "spawn", owner.udid, "launchctl", "list"], { startupLabel: label });
  const receipt = startupCommandReceipts.at(-1);
  if (receipt?.step !== label || receipt.result !== "passed") throw new Error("The owned application process query has no successful command receipt.");
  const lookup = { phase, category: "rejected", exactCandidateCount: 0, unique: false, safePid: false, installedExecutableMatches: false };
  receipt.processLookup = lookup;
  try {
    assertOwner();
    const escaped = owner.bundleId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const exactLabel = new RegExp(`^UIKitApplication:${escaped}(?:\\[[^\\[\\]\\s]+\\])+$`, "u");
    const rows = processes.split(/\r?\n/u).map(line => line.trim().split(/\s+/u))
      .filter(columns => columns.length === 3 && exactLabel.test(columns[2]));
    lookup.exactCandidateCount = rows.length;
    lookup.unique = rows.length === 1;
    if (!lookup.unique) throw new Error("The owned application process query did not return one exact application occurrence.");
    const pid = Number(rows[0][0]);
    lookup.safePid = /^[1-9][0-9]*$/u.test(rows[0][0]) && Number.isSafeInteger(pid) && pid > 1;
    if (!lookup.safePid) throw new Error("The owned application process query returned no safe native PID.");
    lookup.installedExecutableMatches = await alive(pid);
    assertOwner();
    if (!lookup.installedExecutableMatches) throw new Error("The queried native process does not own the verified installed Joko executable.");
    lookup.category = phase === "launch-timeout-recovery" ? "recovered-existing-process" : "matched-ui-test-process";
    return pid;
  } finally { save("startup-command-receipts.json", { commands: startupCommandReceipts }); }
}

async function assertReopenedApplicationProcess(expectedPid, phase) {
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 1) throw new Error("The UI test has no verified reopened native process.");
  const pid = await findOwnedApplicationProcess(phase);
  const receipt = startupCommandReceipts.at(-1);
  receipt.processLookup.sameReopenedPid = pid === expectedPid;
  save("startup-command-receipts.json", { commands: startupCommandReceipts });
  if (pid !== expectedPid) throw new Error("The verified reopened application occurrence changed during UI testing.");
  return pid;
}

async function guiCommand(args, logName, timeout) {
  const started = Date.now(), log = join(evidence, logName);
  writeFileSync(log, "");
  const child = spawn("xcodebuild", ["-quiet", ...args], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let bytes = 0, timedOut = false, spawnError;
  const record = chunk => {
    const remaining = 4 * 1024 * 1024 - bytes;
    if (remaining > 0) { const bounded = chunk.subarray(0, remaining); appendFileSync(log, bounded); bytes += bounded.length; }
  };
  child.stdout.on("data", record); child.stderr.on("data", record);
  const kill = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } } };
  let hardStop;
  const stopChild = () => { kill("SIGTERM"); hardStop ??= setTimeout(() => kill("SIGKILL"), 5000); };
  const timer = setTimeout(() => { timedOut = true; stopChild(); }, timeout);
  abort.signal.addEventListener("abort", stopChild, { once: true });
  if (abort.signal.aborted) stopChild();
  child.once("error", error => { spawnError = error; });
  const receipt = await new Promise(accept => child.once("close", (code, signal) => accept({ exitCode: code, signal })));
  clearTimeout(timer); clearTimeout(hardStop); abort.signal.removeEventListener("abort", stopChild);
  save(logName.replace(/\.log$/u, "-receipt.json"), { ...receipt, elapsedMs: Date.now() - started, timedOut,
    cancelled: abort.signal.aborted, logTruncated: bytes === 4 * 1024 * 1024 });
  if (spawnError || receipt.exitCode !== 0 || timedOut || abort.signal.aborted) {
    kill("SIGKILL");
    throw new Error(`Apple UI-test ${logName === "gui-build.log" ? "build" : "execution"} failed; see ${logName} and its receipt.`);
  }
}

async function exportPreInputSetupFailure(screenshots, files, { expectedSha, expectedHash, requests, unexpectedRequests, steps }) {
  // Only our explicitly named pre-input attachments are eligible. Automatic XCTest
  // trees from later actions can contain connection inputs and stay unexported.
  if (requests !== 0 || unexpectedRequests !== 0 || steps.slice(3).some(step => step.screenshotExported)) return;
  const manifests = files.filter(name => name.endsWith(".json")).flatMap(name => {
    const manifest = JSON.parse(readFileSync(join(screenshots, name), "utf8"));
    return Array.isArray(manifest) ? manifest : [];
  });
  const attachments = manifests.filter(entry => entry.testIdentifier === "JokoConnectionUITests/testConnectionPageInteractions()")
    .flatMap(entry => entry.attachments ?? []).filter(attachment => attachment.deviceId === udid);
  const readAttachment = (name, extensions, maxBytes) => {
    const matches = attachments.filter(attachment => new RegExp(`^${name}(?:_[0-9]+_[A-Fa-f0-9-]{36})?(?:\\.(?:${extensions}))?$`, "u")
      .test(attachment.suggestedHumanReadableName ?? ""));
    if (matches.length === 0) return;
    if (matches.length !== 1 || !/^[A-Fa-f0-9-]{36}(?:\.(?:png|json|txt))?$/u.test(matches[0].exportedFileName ?? "")) {
      throw new Error("The pre-input setup attachment identity was ambiguous.");
    }
    const path = join(screenshots, matches[0].exportedFileName), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) {
      throw new Error("The pre-input setup attachment exceeded its file boundary.");
    }
    return readFileSync(path);
  };
  const addressStage = steps.slice(0, 3).every(step => step.screenshotExported) && steps.length >= 3;
  const firstTabStage = steps[0]?.screenshotExported === true && steps.slice(1).every(step => !step.screenshotExported);
  if (!addressStage && !firstTabStage && steps.some(step => step.screenshotExported)) return;
  const phase = addressStage ? "address" : "setup";
  const expectedStage = addressStage ? "pre-input-address" : "pre-input-setup";
  const prefix = `00-${phase}-pre-input`;
  const stateBytes = readAttachment(`${prefix}-state`, "json|txt", 16 * 1024);
  if (stateBytes === undefined) {
    save(`gui-${phase}-export-receipt.json`, { stage: expectedStage, result: "unavailable", reason: "fixed-pre-input-state-attachment-not-exported" });
    return;
  }
  const state = JSON.parse(stateBytes.toString("utf8"));
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const expectedRoles = { Nearby: ["buttons", "staticTexts", "allRoles"], "Saved nodes": ["buttons"], "Add Joko node": ["buttons"] };
  if (state.stage !== expectedStage || state.connectionInputNotStarted !== true
    || state.configuredBundleIdentifier !== bundleId || typeof state.configuredLaunchArgumentsMatchOwnedServers !== "boolean"
    || state.ownedMetroPortReceived !== true || state.ownedProbePortReceived !== true
    || !count(state.applicationState) || !count(state.webViewCount) || !count(state.hierarchyBytes) || state.hierarchyBytes > 128 * 1024
    || typeof state.hierarchyTruncated !== "boolean"
    || Object.entries(expectedRoles).some(([label, roles]) => roles.some(role => !count(state.expectedControls?.[label]?.[role])))) {
    throw new Error("The pre-input setup control receipt did not match its fixed scope.");
  }
  // Rebuild the receipt from fixed fields; never forward arbitrary attachment
  // JSON, launch arguments, server ports, environment or application text.
  const controls = Object.fromEntries(Object.entries(expectedRoles).map(([label, roles]) =>
    [label, Object.fromEntries(roles.map(role => [role, state.expectedControls[label][role]]))]));
  const receipt = { sourceCommit: expectedSha, executableSha256: expectedHash, simulatorUdid: udid, bundleId,
    stage: state.stage, connectionInputNotStarted: true,
    configuredLaunchArgumentsMatchOwnedServers: state.configuredLaunchArgumentsMatchOwnedServers,
    ownedMetroPortReceived: true, ownedProbePortReceived: true, applicationState: state.applicationState,
    webViewCount: state.webViewCount, expectedControls: controls, hierarchyTruncated: state.hierarchyTruncated, attachments: [] };
  save(`gui-${phase}-control-receipt.json`, receipt);
  const screen = readAttachment(`${prefix}-screen`, "png", 8 * 1024 * 1024);
  if (screen !== undefined) {
    if (!screen.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("The pre-input setup screenshot was not a PNG.");
    const file = `gui-${phase}-pre-input.png`;
    writeFileSync(join(evidence, file), screen);
    receipt.attachments.push({ file, bytes: screen.length, sha256: createHash("sha256").update(screen).digest("hex") });
    save(`gui-${phase}-control-receipt.json`, receipt);
  }
  const tree = readAttachment(`${prefix}-hierarchy`, "txt", 128 * 1024);
  if (tree !== undefined) {
    if (tree.length !== state.hierarchyBytes) throw new Error("The pre-input setup hierarchy did not match its bounded receipt.");
    const file = `gui-${phase}-pre-input-hierarchy.txt`;
    writeFileSync(join(evidence, file), tree);
    receipt.attachments.push({ file, bytes: tree.length, sha256: createHash("sha256").update(tree).digest("hex") });
    save(`gui-${phase}-control-receipt.json`, receipt);
  }
  save(`gui-${phase}-export-receipt.json`, { stage: expectedStage, result: "exported",
    screenshotExported: screen !== undefined, hierarchyExported: tree !== undefined });
}

async function runConnectionUiTests(app, port, expectedSha, expectedHash, reopenedPid, minimumOsVersion) {
  const owner = { udid, bundleId, installedExecutable };
  const assertIdentity = async (phase) => {
    abort.signal.throwIfAborted();
    if (udid !== owner.udid || bundleId !== owner.bundleId || installedExecutable !== owner.installedExecutable) {
      throw new Error("The owned Simulator application identity changed during UI testing.");
    }
    if (await command("git", ["rev-parse", "HEAD"]) !== expectedSha || await hashFile(join(app, executable)) !== expectedHash) {
      throw new Error("The source or compiled application changed during UI testing; refusing a different artifact identity.");
    }
    const container = await sim("get_app_container", owner.udid, owner.bundleId, "app");
    const installed = realpathSync(join(container, executable));
    if (installed !== owner.installedExecutable || await hashFile(installed) !== expectedHash) throw new Error("The installed application changed during UI testing.");
    installedExecutable = installed;
    if (metroClosed) throw new Error("The owned same-checkout Metro exited during UI testing.");
    return assertReopenedApplicationProcess(reopenedPid, phase);
  };
  stage = "UI-test reopened application identity verification";
  await assertIdentity("pre-ui-build");
  // A loopback-only Connect error endpoint exercises the real native transport.
  // It never supplies a node identity, challenge, credential or successful pair.
  let requests = 0, unexpectedRequests = 0;
  const probe = createHttpServer((request, response) => {
    if (request.method === "GET" && request.url === "/ci-probe-status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ identityRequests: requests })); return;
    }
    if (request.method !== "POST" || !request.url?.endsWith("/GetServerInfo")) {
      unexpectedRequests++; response.writeHead(404); response.end(); return;
    }
    request.resume(); requests++;
    if (requests === 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "unavailable", message: "CI local identity probe unavailable" }));
    } else if (requests > 2) { response.writeHead(503); response.end(); }
    // Request two deliberately remains pending until the user presses Cancel.
  });
  await new Promise((accept, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", accept); });
  const probePort = probe.address().port;
  const derivedData = join(evidence, "ui-test-derived-data"), project = join(evidence, "JokoCIUITests.xcodeproj");
  const common = ["-project", project, "-scheme", "JokoCIUITests", "-configuration", "Debug", "-sdk", "iphonesimulator",
    "-destination", `platform=iOS Simulator,id=${udid}`, "-destination-timeout", "30", "-derivedDataPath", derivedData,
    "-parallel-testing-enabled", "NO", "-maximum-concurrent-test-simulator-destinations", "1"];
  let xcresult = join(evidence, "gui.xcresult");
  const screenshots = join(evidence, "gui-screenshots");
  let executionError;
  try {
    stage = "Apple UI-test target preparation";
    await command("ruby", [join(root, "scripts/ci/ios-prepare-ui-tests.rb"), project,
      join(root, "scripts/ci/ios-connection-ui-tests.swift"), String(port), String(probePort), minimumOsVersion]);
    stage = "Apple UI-test runner build";
    await guiCommand([...common, "build-for-testing"], "gui-build.log", 5 * 60_000);
    stage = "UI-test runner prepared application identity verification";
    await assertIdentity("post-ui-build");
    stage = "actual connection page UI operations";
    try {
      await guiCommand([...common, "test-without-building", "-resultBundlePath", xcresult,
        "-only-testing:JokoCIUITests/JokoConnectionUITests/testConnectionPageInteractions"], "gui-test.log", 5 * 60_000);
    } catch (error) { executionError = error; }
    if (executionError && !abort.signal.aborted && existsSync(xcresult)) {
      const initial = JSON.parse(await command("xcrun", ["xcresulttool", "get", "test-results", "summary", "--path", xcresult]));
      if (isUiRunnerAccessibilityStartupFailure(initial, requests, unexpectedRequests)) {
        save("gui-initial-summary.json", initial);
        await assertIdentity("post-ui-build");
        xcresult = join(evidence, "gui-retry.xcresult");
        executionError = undefined;
        try {
          await guiCommand([...common, "test-without-building", "-resultBundlePath", xcresult,
            "-only-testing:JokoCIUITests/JokoConnectionUITests/testConnectionPageInteractions"], "gui-test-retry.log", 5 * 60_000);
        } catch (error) { executionError = error; }
      }
    }
    if (existsSync(xcresult)) {
      stage = "Apple UI-test evidence export";
      const summary = JSON.parse(await command("xcrun", ["xcresulttool", "get", "test-results", "summary", "--path", xcresult]));
      save("gui-summary.json", summary);
      await command("xcrun", ["xcresulttool", "export", "attachments", "--path", xcresult, "--output-path", screenshots], { timeout: 60_000 });
      const names = ["01-connection-page", "02-saved-nodes", "03-nearby", "04-invalid-address", "05-local-identity-error",
        "06-inspection-pending", "07-cancelled-draft-retained", "08-returned-address-draft", "09-dark-theme", "10-light-theme"];
      const files = readdirSync(screenshots, { recursive: true });
      const manifests = files.filter(name => name.endsWith(".json")).map(name => readFileSync(join(screenshots, name), "utf8")).join("\n");
      const steps = names.map(name => ({ name, screenshotExported: manifests.includes(name) }));
      save("gui-steps.json", { sourceCommit: expectedSha, executableSha256: expectedHash, simulatorUdid: udid, bundleId,
        steps, screenshotCount: files.filter(name => name.endsWith(".png")).length, localIdentityRequests: requests, unexpectedRequests,
        testExitSucceeded: !executionError, passed: !executionError && summary.result === "Passed" && summary.passedTests === 1
          && summary.failedTests === 0 && summary.skippedTests === 0 && steps.every(step => step.screenshotExported) });
      if (executionError || summary.result !== "Passed") {
        try { await exportPreInputSetupFailure(screenshots, files, { expectedSha, expectedHash, requests, unexpectedRequests, steps }); }
        catch { save("gui-pre-input-export-receipt.json", { result: "failed", onlyAllowlistedPreInputAttachmentsExported: true }); }
      }
      if (executionError) throw executionError;
      if (summary.result !== "Passed" || summary.passedTests !== 1 || summary.failedTests !== 0 || summary.skippedTests !== 0
        || !steps.every(step => step.screenshotExported) || requests !== 2 || unexpectedRequests !== 0) {
        throw new Error("The actual UI test or its complete screenshot/transport receipts did not pass; see gui-summary.json and gui-steps.json.");
      }
    } else throw executionError ?? new Error("Apple UI testing produced no xcresult receipt.");
    // XCTest activates the already observed reopened occurrence. A replacement
    // with the same executable bytes still fails this exact process fence.
    stage = "UI-tested application process identity lookup";
    const pid = await assertIdentity("post-ui-test");
    return { passed: true, test: "JokoConnectionUITests/testConnectionPageInteractions", sourceCommit: expectedSha,
      executableSha256: expectedHash, simulatorUdid: udid, bundleId, pid, screenshotCount: 10,
      scope: "Real connection-page mode changes, address typing/validation, local transport error, explicit cancellation, retained draft and theme changes." };
  } finally {
    save("gui-local-probe.json", { loopbackOnly: true, localIdentityRequests: requests, unexpectedRequests });
    probe.closeAllConnections();
    await new Promise(accept => probe.close(accept));
  }
}
async function capturePostUiFrame(ocr, identity, expectedPid) {
  // Keep a separate raw framebuffer after XCTest has finished. A capture or
  // OCR failure is diagnostic data; preserve the original test and its budget.
  const receipt = { sourceCommit: identity.sourceCommit, executableSha256: identity.executableSha256,
    simulatorUdid: udid, bundleId, expectedPid, screenshotCaptured: false, ocrSucceeded: false,
    perCommandTimeoutMs: 10_000 };
  if (observationDeadlineAt - Date.now() < 60_000) {
    receipt.skippedForOperationDeadline = true;
    save("post-gui-capture.json", receipt);
    return receipt;
  }
  try {
    const image = join(evidence, "post-gui.png");
    await command("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", image], { timeout: 10_000 });
    const bytes = readFileSync(image);
    if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("Invalid framebuffer capture.");
    receipt.screenshotCaptured = true;
    receipt.screenshot = { file: "post-gui.png", bytes: bytes.length, sha256: await hashFile(image) };
    save("post-gui-screen.json", JSON.parse(await command(ocr, [image], { timeout: 10_000 })));
    receipt.ocrSucceeded = true;
  } catch (error) {
    receipt.observationFailed = true;
    receipt.cancelled = abort.signal.aborted;
    if (abort.signal.aborted) throw error;
  } finally {
    save("post-gui-capture.json", receipt);
  }
  return receipt;
}
async function cleanup() {
  const errors = [];
  if (metro?.pid) {
    try { process.kill(-metro.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") errors.push("Owned Metro group could not be stopped."); }
    for (let count = 0; count < 20 && !metroClosed; count++) await delay(100);
    if (!metroClosed) { try { process.kill(-metro.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") errors.push("Owned Metro group did not terminate."); } }
  }
  if (udid) {
    try {
      const listing = JSON.parse(await command("xcrun", ["simctl", "list", "devices", "--json"], { cleanup: true }));
      const owned = Object.values(listing.devices).flat().find(device => device.udid === udid);
      if (owned && owned.name !== deviceName) throw new Error("The created Simulator identity changed; refusing cleanup.");
      if (owned) {
        if (bundleId && owned.state === "Booted") await command("xcrun", ["simctl", "terminate", udid, bundleId], { cleanup: true }).catch(() => undefined);
        if (owned.state === "Booted") await command("xcrun", ["simctl", "shutdown", udid], { cleanup: true });
        await command("xcrun", ["simctl", "delete", udid], { cleanup: true });
      }
    } catch (error) { errors.push(error.message); }
  }
  if (evidence) save("cleanup.json", { simulatorUdid: udid, simulatorName: deviceName, ownedMetroPid: metro?.pid,
    deletedOnlyCreatedSimulator: !!udid && errors.length === 0, errors });
  clearTimeout(deadline); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  return errors;
}

async function startOwnedSimulator(applicationIdentity) {
  await recordHostResources("before-simulator");
  stage = "owned Simulator creation";
  const runtimes = JSON.parse(await command("xcrun", ["simctl", "list", "runtimes", "--json"],
    { startupLabel: "list-ios-runtimes" })).runtimes.filter(runtime => runtime.isAvailable
    && runtime.identifier.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-"));
  runtimes.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }));
  const runtime = runtimes[0]; if (!runtime) throw new Error("No available iOS Simulator runtime is installed.");
  const types = JSON.parse(await command("xcrun", ["simctl", "list", "devicetypes", "--json"],
    { startupLabel: "list-device-types" })).devicetypes;
  const devices = JSON.parse(await command("xcrun", ["simctl", "list", "devices", "available", "--json"],
    { startupLabel: "list-available-devices" })).devices[runtime.identifier] ?? [];
  const template = devices.find(device => device.name.startsWith("iPhone"));
  const type = types.find(type => type.identifier === template?.deviceTypeIdentifier || type.name === template?.name)
    ?? types.find(type => type.name === "iPhone 16") ?? types.find(type => type.name === "iPhone 15");
  if (!type) throw new Error("No compatible iPhone Simulator device type is available.");
  deviceName = `joko-ci-${process.env.GITHUB_RUN_ID ?? "runtime"}-${randomUUID().slice(0, 8)}`;
  const created = await command("xcrun", ["simctl", "create", deviceName, type.identifier, runtime.identifier],
    { startupLabel: "create-owned-simulator" });
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(created)) throw new Error("Simulator creation returned no exact UDID.");
  udid = created;
  save("identity.json", { sourceCommit: await command("git", ["rev-parse", "HEAD"]), ...applicationIdentity,
    simulatorUdid: udid, simulatorName: deviceName, runtime: runtime.identifier, deviceType: type.identifier,
    architecture: process.arch === "arm64" ? "arm64" : "x86_64", xcode: await command("xcodebuild", ["-version"]) });
  await command("xcrun", ["simctl", "boot", udid], { startupLabel: "boot-owned-simulator" });
  // Fresh CI devices can still be migrating at the old 3-minute cutoff. Full
  // GUI runs own this same device through cold boot within the existing 15m
  // observation deadline; the short startup-only diagnostic keeps its budget.
  await command("xcrun", ["simctl", "bootstatus", udid, "-b"], {
    timeout: startupDiagnosticsOnly ? 180_000 : 600_000, startupLabel: "wait-owned-boot"
  });
  await recordHostResources("after-bootstatus");
  stage = "owned Simulator appearance confirmation";
  const startupState = { scope: "simulator-startup-command-probe", simulatorUdid: udid,
    noApplicationInstalled: true, noAppGuiSuccessClaimed: true,
    framebufferReadiness: { attempts: 1, passed: false } };
  save("startup-state.json", startupState);
  const framebufferTimeout = startupDiagnosticsOnly ? 30_000 : 90_000;
  try {
    startupState.framebuffer = await captureStartupFramebuffer("pre-appearance.png", "capture-pre-appearance-framebuffer", framebufferTimeout);
  } catch (error) {
    const receipt = startupCommandReceipts.at(-1);
    if (abort.signal.aborted || receipt?.step !== "capture-pre-appearance-framebuffer" || receipt.result !== "failed"
      || receipt.killed !== true || receipt.signal !== "SIGTERM" || receipt.cancelled !== false) throw error;
    // The owned framebuffer can become usable after bootstatus has exited. Keep
    // the first deadline receipt and allow only one fresh, equally bounded probe.
    startupState.framebufferReadiness.attempts = 2;
    save("startup-state.json", startupState);
    startupState.framebuffer = await captureStartupFramebuffer("pre-appearance.png", "retry-pre-appearance-framebuffer", framebufferTimeout);
  }
  startupState.framebufferReadiness.passed = true;
  save("startup-state.json", startupState);
  const initialAppearance = await readAppearance("read-initial-appearance");
  Object.assign(startupState, { initialAppearance, appearanceWriteRequired: initialAppearance !== "light" });
  save("startup-state.json", startupState);
  if (initialAppearance !== "light") {
    await command("xcrun", ["simctl", "ui", udid, "appearance", "light"], { startupLabel: "set-light-appearance" });
  }
  const finalAppearance = initialAppearance === "light" ? initialAppearance : await readAppearance("read-final-appearance");
  Object.assign(startupState, { finalAppearance, passed: finalAppearance === "light" });
  save("startup-state.json", startupState);
  if (finalAppearance !== "light") throw new Error("The owned Simulator appearance readback is not light.");
  await recordHostResources("simulator-ready");
}

async function captureStartupFramebuffer(file, startupLabel, timeout = 30_000) {
  const image = join(evidence, file);
  if (existsSync(image)) unlinkSync(image);
  await command("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", image], { startupLabel, timeout });
  if (!readFileSync(image).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("The owned Simulator did not produce a PNG framebuffer capture.");
  }
  return { file, sha256: await hashFile(image) };
}

async function readAppearance(startupLabel) {
  const appearance = await command("xcrun", ["simctl", "ui", udid, "appearance"], { startupLabel });
  if (!["light", "dark", "unknown", "unsupported"].includes(appearance)) {
    throw new Error("The owned Simulator returned an unrecognized appearance value.");
  }
  const receipt = startupCommandReceipts.at(-1);
  if (receipt?.step !== startupLabel || receipt.result !== "passed") throw new Error("The appearance command receipt identity changed.");
  receipt.observedAppearance = appearance;
  save("startup-command-receipts.json", { commands: startupCommandReceipts });
  return appearance;
}

async function main() {
  let result;
  try {
    if (process.platform !== "darwin") throw new Error("The real Simulator runtime check requires macOS and Xcode.");
    if (process.argv.length > 2 && !startupDiagnosticsOnly) throw new Error("Unknown iOS runtime observation mode.");
    const output = process.env.JOKO_IOS_RUNTIME_EVIDENCE_DIR, appInput = process.env.JOKO_IOS_SIMULATOR_APP_PATH;
    if (!output || !isAbsolute(output)) throw new Error("An absolute evidence path is required.");
    evidence = resolve(output); mkdirSync(evidence, { recursive: true });
    if (startupDiagnosticsOnly) {
      await startOwnedSimulator({ scope: "simulator-startup-command-probe", noApplicationInstalled: true });
      stage = "owned Simulator framebuffer capture";
      const framebuffer = await captureStartupFramebuffer("simulator-startup.png", "capture-simulator-springboard");
      const identity = JSON.parse(readFileSync(join(evidence, "identity.json"), "utf8"));
      result = { passed: true, sourceCommit: identity.sourceCommit, simulatorUdid: udid,
        scope: "simulator-startup-command-probe", screenshot: framebuffer.file, screenshotSha256: framebuffer.sha256,
        noApplicationInstalled: true, noAppGuiSuccessClaimed: true,
        limits: ["Only owned Simulator creation, boot, bootstatus, appearance and framebuffer capture were executed. No Joko application, Metro, XCTest or device interaction was tested."] };
      return;
    }
    if (!appInput || !isAbsolute(appInput)) throw new Error("An absolute compiled Simulator .app path is required.");
    const app = realpathSync(appInput);
    const info = JSON.parse(await command("plutil", ["-convert", "json", "-o", "-", join(app, "Info.plist")]));
    const config = JSON.parse(readFileSync(join(root, "apps/mobile/app.json"), "utf8")).expo;
    bundleId = info.CFBundleIdentifier; executable = info.CFBundleExecutable;
    if (bundleId !== config.ios.bundleIdentifier || !/^[A-Za-z0-9_-]+$/u.test(executable ?? "")
      || info.CFBundlePackageType !== "APPL" || !info.CFBundleSupportedPlatforms?.includes("iPhoneSimulator")) {
      throw new Error("The compiled app is not the exact configured Joko Simulator application.");
    }
    const binary = join(app, executable), architecture = process.arch === "arm64" ? "arm64" : "x86_64";
    if (!(await command("lipo", ["-archs", binary])).split(/\s+/u).includes(architecture)) throw new Error("The Simulator binary does not contain this runner's architecture.");
    const ocr = join(evidence, "screen-text");
    stage = "screen observer compilation";
    await command("xcrun", ["swiftc", join(root, "scripts/ci/mobile-ios-screen-text.swift"), "-framework", "Vision", "-o", ocr],
      { timeout: 60_000, startupLabel: "compile-screen-observer" });
    // Compile the same Debug entry before the cold Simulator starts competing
    // for host CPU and memory. Keep this Metro instance for the actual app.
    stage = "same-checkout Metro startup";
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    startMetro(port); await waitForMetro(origin);
    stage = "same-checkout iOS bundle compilation";
    const bundle = await fetch(`${origin}/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true&minify=false`,
      { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]) });
    if (!bundle.ok) { await bundle.body?.cancel(); throw new Error("Metro could not compile the actual iOS app entry."); }
    await bundle.body?.cancel();
    await startOwnedSimulator({ bundleId, executable, compiledApp: app, executableSha256: await hashFile(binary),
      startupBinding: "Debug RCT_jsLocation points to the owned same-checkout Metro; no development-client DeepLink is used." });
    stage = "owned application installation";
    const { container, installation } = await installOwnedApplication(app);
    installedExecutable = realpathSync(join(container, executable));
    if (await hashFile(installedExecutable) !== await hashFile(binary)) throw new Error("The installed app bytes do not match the compiled artifact.");
    installation.installedExecutableVerified = true;
    save("installation-state.json", installation);
    stage = "first native launch";
    const firstStartedAt = Date.now(), firstPid = await launch(port);
    preInputApplication = { pid: firstPid, startedAt: firstStartedAt };
    const first = await observe("first-launch", firstPid, ocr);
    preInputApplication = undefined;
    stage = "explicit app termination";
    await sim("terminate", udid, bundleId);
    for (let count = 0; count < 20 && await alive(firstPid); count++) await delay(250, undefined, { signal: abort.signal });
    if (await alive(firstPid)) throw new Error("The first app occurrence did not terminate.");
    stage = "native reopen";
    const reopenedStartedAt = Date.now(), reopenedPid = await launch(port);
    preInputApplication = { pid: reopenedPid, startedAt: reopenedStartedAt };
    const reopened = await observe("reopened", reopenedPid, ocr);
    preInputApplication = undefined;
    const identity = JSON.parse(readFileSync(join(evidence, "identity.json"), "utf8"));
    const gui = await runConnectionUiTests(app, port, identity.sourceCommit, identity.executableSha256, reopenedPid, info.MinimumOSVersion);
    const postGuiFrame = await capturePostUiFrame(ocr, identity, reopenedPid);
    assertNoNotificationStartupError(readFileSync(join(evidence, "metro.log"), "utf8"));
    result = { passed: true, sourceCommit: await command("git", ["rev-parse", "HEAD"]), bundleId, simulatorUdid: udid,
      observations: [first, reopened], firstProcessTerminated: true, gui, postGuiFrame,
      scope: "Actual iOS Simulator startup/reopen plus Apple XCTest connection-page taps, typing, local error/cancel, draft retention and theme changes on the same application bytes.",
      limits: ["Connection-page interactions use an owned loopback failure endpoint; no paired node, task execution, physical device, signed IPA or APNs were tested.",
        "Simulator does not exercise the physical device's first local network privacy permission."] };
  } catch (error) {
    if (evidence) {
      await recordHostResources("failed-operation").catch(() => undefined);
      if (udid) await command("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", join(evidence, "failure.png")], { cleanup: true }).catch(() => undefined);
      save("failure.json", { stage, message: error.message, simulatorUdid: udid, bundleId,
        scope: startupDiagnosticsOnly ? "simulator-startup-command-probe" : "joko-app-runtime-and-gui", noGuiSuccessClaimed: true });
      const diagnostics = await collectRuntimeFailureDiagnostics({ bundleId, executable, installedExecutable,
        simulatorUdid: udid, startedAt: observationStartedAt,
        startup: ["first native launch", "native reopen"].includes(stage) ? preInputApplication : undefined }).catch(() => ({ collectionFailed: true }));
      save("runtime-failure-diagnostics.json", diagnostics);
    }
    throw error;
  } finally {
    const errors = await cleanup();
    if (result && errors.length === 0) {
      save("result.json", result);
      process.stdout.write(startupDiagnosticsOnly ? "Owned Simulator startup commands and framebuffer capture passed; no application GUI was tested.\n"
        : "Actual Joko Simulator startup, reopen and connection-page UI operations passed.\n");
    }
    else if (result) throw new Error("Simulator observations passed but owned cleanup failed; see cleanup.json.");
  }
}
await main().catch(error => { process.stderr.write(`iOS Simulator runtime observation failed: ${error.message}\n`); process.exitCode = 1; });
