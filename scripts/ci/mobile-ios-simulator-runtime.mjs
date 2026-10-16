import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(new Error("iOS startup observation deadline exceeded.")), 8 * 60_000);
const stop = () => abort.abort(new Error("iOS startup observation was cancelled."));
process.once("SIGINT", stop); process.once("SIGTERM", stop);
let evidence, udid, deviceName, bundleId, executable, installedExecutable, metro, metroClosed = false;
let stage = "preconditions";

function save(name, value) { writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + "\n"); }
async function command(binary, args, { timeout = 30_000, cleanup = false } = {}) {
  const value = await exec(binary, args, { cwd: root, timeout, maxBuffer: 4 * 1024 * 1024,
    signal: cleanup ? undefined : abort.signal, windowsHide: true });
  return value.stdout.trim();
}
function sim(...args) { return command("xcrun", ["simctl", ...args]); }
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
  const until = Date.now() + 90_000;
  let productSeenAt;
  while (Date.now() < until) {
    abort.signal.throwIfAborted();
    if (metroClosed || !await alive(pid)) throw new Error(`${phase}: the actual app or its Metro server exited.`);
    const image = join(evidence, `${phase}.png`);
    await sim("io", udid, "screenshot", "--type=png", image);
    const screen = JSON.parse(await command(ocr, [image]));
    save(`${phase}-screen.json`, screen);
    const text = screen.lines.map(line => line.text).join("\n");
    const blocked = /uncaught|unhandled js|no bundle url|could not connect|unable to resolve module|failed to load bundle|development server|connect to metro|runtime not ready|invariant violation|expo go|development build|would like to|don['’]t allow|find and connect to devices|while using the app/iu.test(text);
    const appVisible = /\bjoko\b/iu.test(text) && /\bnearby\b|saved nodes|add joko node/iu.test(text);
    if (appVisible && !blocked) {
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
  const output = await sim("launch", udid, bundleId, "-RCT_jsLocation", `127.0.0.1:${port}`, "-RCT_packager_scheme", "http",
    "-AppleLanguages", "(en)", "-AppleLocale", "en_US");
  const matched = new RegExp(`^${bundleId.replaceAll(".", "\\.")}:\\s+(\\d+)$`, "u").exec(output);
  if (!matched) throw new Error("simctl did not return the selected app's actual launch PID.");
  const pid = Number(matched[1]);
  if (!Number.isSafeInteger(pid) || pid < 2 || !await alive(pid)) throw new Error("The launch PID does not own the installed Joko executable.");
  return pid;
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

async function main() {
  let result;
  try {
    if (process.platform !== "darwin") throw new Error("The real Simulator runtime check requires macOS and Xcode.");
    const output = process.env.JOKO_IOS_RUNTIME_EVIDENCE_DIR, appInput = process.env.JOKO_IOS_SIMULATOR_APP_PATH;
    if (!output || !isAbsolute(output) || !appInput || !isAbsolute(appInput)) throw new Error("Absolute evidence and compiled Simulator .app paths are required.");
    evidence = resolve(output); mkdirSync(evidence, { recursive: true });
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
    stage = "owned Simulator creation";
    const runtimes = JSON.parse(await sim("list", "runtimes", "--json")).runtimes.filter(runtime => runtime.isAvailable
      && runtime.identifier.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-"));
    runtimes.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }));
    const runtime = runtimes[0]; if (!runtime) throw new Error("No available iOS Simulator runtime is installed.");
    const types = JSON.parse(await sim("list", "devicetypes", "--json")).devicetypes;
    const devices = JSON.parse(await sim("list", "devices", "available", "--json")).devices[runtime.identifier] ?? [];
    const template = devices.find(device => device.name.startsWith("iPhone"));
    const type = types.find(type => type.identifier === template?.deviceTypeIdentifier || type.name === template?.name)
      ?? types.find(type => type.name === "iPhone 16") ?? types.find(type => type.name === "iPhone 15");
    if (!type) throw new Error("No compatible iPhone Simulator device type is available.");
    deviceName = `joko-ci-${process.env.GITHUB_RUN_ID ?? "runtime"}-${randomUUID().slice(0, 8)}`;
    const created = await sim("create", deviceName, type.identifier, runtime.identifier);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(created)) throw new Error("Simulator creation returned no exact UDID.");
    udid = created;
    save("identity.json", { sourceCommit: await command("git", ["rev-parse", "HEAD"]), bundleId, executable,
      simulatorUdid: udid, simulatorName: deviceName, runtime: runtime.identifier, deviceType: type.identifier, architecture,
      compiledApp: app, executableSha256: await hashFile(binary), xcode: await command("xcodebuild", ["-version"]),
      startupBinding: "Debug RCT_jsLocation points to the owned same-checkout Metro; no development-client DeepLink is used." });
    await sim("boot", udid);
    await command("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 180_000 });
    await sim("ui", udid, "appearance", "light");
    await sim("install", udid, app);
    const container = await sim("get_app_container", udid, bundleId, "app");
    installedExecutable = realpathSync(join(container, executable));
    if (await hashFile(installedExecutable) !== await hashFile(binary)) throw new Error("The installed app bytes do not match the compiled artifact.");
    stage = "same-checkout Metro startup";
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    startMetro(port); await waitForMetro(origin);
    stage = "same-checkout iOS bundle compilation";
    const bundle = await fetch(`${origin}/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true&minify=false`,
      { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]) });
    if (!bundle.ok) { await bundle.body?.cancel(); throw new Error("Metro could not compile the actual iOS app entry."); }
    await bundle.body?.cancel();
    const ocr = join(evidence, "screen-text");
    await command("xcrun", ["swiftc", join(root, "scripts/ci/mobile-ios-screen-text.swift"), "-framework", "Vision", "-o", ocr], { timeout: 60_000 });
    stage = "first native launch";
    const firstPid = await launch(port), first = await observe("first-launch", firstPid, ocr);
    stage = "explicit app termination";
    await sim("terminate", udid, bundleId);
    for (let count = 0; count < 20 && await alive(firstPid); count++) await delay(250, undefined, { signal: abort.signal });
    if (await alive(firstPid)) throw new Error("The first app occurrence did not terminate.");
    stage = "native reopen";
    const reopenedPid = await launch(port), reopened = await observe("reopened", reopenedPid, ocr);
    result = { passed: true, sourceCommit: await command("git", ["rev-parse", "HEAD"]), bundleId, simulatorUdid: udid,
      observations: [first, reopened], firstProcessTerminated: true,
      scope: "Actual unsigned iOS Simulator Debug process launch, visible Joko connection page, terminate and reopen with same-checkout Metro.",
      limits: ["Screenshots and local OCR observe startup; no taps, typing, paired node, task execution, physical device, signed IPA or APNs were tested.",
        "Simulator does not exercise the physical device's first local network privacy permission."] };
  } catch (error) {
    if (evidence) {
      if (udid) await command("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", join(evidence, "failure.png")], { cleanup: true }).catch(() => undefined);
      save("failure.json", { stage, message: error.message, simulatorUdid: udid, bundleId, noGuiSuccessClaimed: true });
    }
    throw error;
  } finally {
    const errors = await cleanup();
    if (result && errors.length === 0) { save("result.json", result); process.stdout.write("Actual Joko Simulator startup and reopen observations passed.\n"); }
    else if (result) throw new Error("Simulator observations passed but owned cleanup failed; see cleanup.json.");
  }
}
await main().catch(error => { process.stderr.write(`iOS Simulator runtime observation failed: ${error.message}\n`); process.exitCode = 1; });
