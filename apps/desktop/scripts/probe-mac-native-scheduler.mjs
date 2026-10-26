import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, get } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// An observation of the fixed engine, independent of the authoritative product
// smoke. The Node parent owns the entire ten-second budget, including cleanup.
const version = "43.6.0", prefix = "JOKO_NATIVE_SCHEDULER_EVENT ";
if (process.versions.electron !== undefined) void observeEngine().catch(error => {
  process.stderr.write(`Controlled engine preparation failed: ${String(error?.message ?? error).slice(0, 512)}\n`);
  process.exit(2);
});
else await superviseEngine();

async function superviseEngine() {
  const started = Date.now(), totalDeadlineMs = 10_000;
  let child, root, timeout, finalDeadline, finished = false, timedOut = false, exited = false;
  const events = [], streams = { stdout: "", stderr: "" }, truncated = { stdout: false, stderr: false };
  const finish = (reason, code, signal) => {
    if (finished) return;
    finished = true; clearTimeout(timeout); clearTimeout(finalDeadline);
    child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
    let profileCleanup = "retained";
    if (root !== undefined && (child === undefined || exited)) {
      try {
        const temporary = realpathSync(tmpdir()), canonical = realpathSync(root), inside = relative(temporary, canonical);
        if (dirname(canonical) !== temporary || inside.startsWith(`..${sep}`) ||
          !inside.startsWith("joko-native-scheduler-")) throw new Error("Unexpected profile boundary");
        rmSync(canonical, { recursive: true, force: true }); profileCleanup = "removed";
      } catch { profileCleanup = "retained_cleanup_unavailable"; }
    }
    const measured = events.some(event => event.phase === "measurement_started");
    const completed = reason === undefined && code === 0 && events.some(event => event.phase === "measurement_completed");
    process.stdout.write(`${JSON.stringify({ event: "JOKO_MAC_NATIVE_SCHEDULER_OBSERVATION", platform: process.platform,
      architecture: process.arch, expectedElectron: version, totalDeadlineMs, elapsedMs: Date.now() - started,
      status: completed ? "observed_success" : measured ? "observed_failure" : "not_measured",
      ...(reason === undefined ? {} : { reason }), code, signal, ownChildExited: exited, profileCleanup,
      events, stderr: streams.stderr, stderrTruncated: truncated.stderr, stdoutTruncated: truncated.stdout })}\n`);
    process.exitCode = completed ? 0 : measured ? 1 : 2;
  };
  try {
    const require = createRequire(import.meta.url), electron = require("electron");
    if (require("electron/package.json").version !== version || typeof electron !== "string") {
      throw new Error("The installed Electron does not match the fixed engine");
    }
    root = mkdtempSync(join(realpathSync(tmpdir()), "joko-native-scheduler-"));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(electron, [fileURLToPath(import.meta.url), root], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    for (const name of ["stdout", "stderr"]) child[name].on("data", chunk => {
      const limit = name === "stdout" ? 64 * 1024 : 16 * 1024;
      const retained = Buffer.from(chunk).subarray(0, Math.max(0, limit - Buffer.byteLength(streams[name]))).toString("utf8");
      if (Buffer.byteLength(retained) < Buffer.byteLength(chunk)) truncated[name] = true;
      streams[name] += retained;
      if (name === "stdout") {
        events.length = 0;
        for (const line of streams.stdout.split(/\r?\n/u)) if (line.startsWith(prefix) && events.length < 40) {
          try { events.push(JSON.parse(line.slice(prefix.length))); } catch { /* A split line is parsed with its next chunk. */ }
        }
      }
    });
    child.once("error", () => finish("engine_spawn_failed"));
    child.once("exit", () => { exited = true; });
    child.once("close", (code, signal) => finish(timedOut ? "parent_deadline" : undefined, code, signal));
    // Reserve the last half second for the exact spawned child's exit receipt.
    timeout = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, Math.max(0, totalDeadlineMs - 500 - (Date.now() - started)));
    finalDeadline = setTimeout(() => finish(exited ? "parent_deadline_stdio_pending" : "parent_deadline_cleanup_unconfirmed"),
      Math.max(0, totalDeadlineMs - (Date.now() - started)));
  } catch { finish("preparation_failed"); }
}

async function observeEngine() {
  const { app, BrowserWindow } = await import("electron");
  const record = (phase, details = {}) => process.stdout.write(`${prefix}${JSON.stringify({ phase, at: Date.now(), ...details })}\n`);
  const childRoot = resolve(process.argv[2] ?? "");
  if (process.versions.electron !== version || !childRoot.startsWith(`${realpathSync(tmpdir())}${sep}joko-native-scheduler-`)) {
    record("preparation_failed"); app.exit(2); return;
  }
  app.setPath("userData", join(childRoot, "profile"));
  app.on("window-all-closed", () => { /* Keep the crashed owner alive until the observation finishes. */ });
  await app.whenReady();
  const preferences = { contextIsolation: true, sandbox: true, nodeIntegration: false };
  try {
    const owner = new BrowserWindow({ show: true, width: 400, height: 300, webPreferences: preferences });
    const foreground = new BrowserWindow({ show: true, width: 300, height: 200,
      webPreferences: { ...preferences, partition: "scheduler-independent-foreground" } });
    owner.webContents.setWindowOpenHandler(details => details.url === "about:blank" && details.frameName === "controlled-child"
      ? { action: "allow", overrideBrowserWindowOptions: { show: false, webPreferences: preferences } } : { action: "deny" });
    await Promise.all([owner.loadURL("data:text/html,<title>Controlled owner</title>"),
      foreground.loadURL("data:text/html,<title>Independent foreground</title>")]);
    const created = once(owner.webContents, "did-create-window");
    const accepted = await owner.webContents.executeJavaScript("window.open('about:blank', 'controlled-child') !== null", true);
    if (accepted !== true) throw new Error("The controlled popup was rejected");
    const [child] = await created, childContents = child.webContents, foregroundContents = foreground.webContents;
    const ownerPid = owner.webContents.getOSProcessId(), foregroundPid = foregroundContents.getOSProcessId();
    if (ownerPid < 1 || foregroundPid < 1 || ownerPid === foregroundPid) throw new Error("The foreground renderer is not independent");
    record("measurement_started", { electron: process.versions.electron, ownerSharesChild: ownerPid === childContents.getOSProcessId() });
    const retired = (target, phase) => once(target, phase.endsWith("native_closed") ? "closed" : "destroyed").then(() => record(phase));
    const childNative = retired(child, "child_native_closed"), childContext = retired(childContents, "child_contents_destroyed");
    const foregroundNative = retired(foreground, "foreground_native_closed");
    const foregroundContext = retired(foregroundContents, "foreground_contents_destroyed");
    const crashed = once(owner.webContents, "render-process-gone");
    owner.webContents.forcefullyCrashRenderer(); record("owner_crash_requested");
    await crashed; record("owner_renderer_gone");
    if (!child.isDestroyed()) child.destroy();
    await childNative;
    foreground.destroy(); record("foreground_destroy_returned");
    if (owner.isDestroyed()) throw new Error("The crashed owner native window unexpectedly retired");
    record("crashed_owner_native_retained");
    const nextTick = new Promise(resolveTick => process.nextTick(() => { record("next_tick"); resolveTick(); }));
    const microtask = new Promise(resolveTask => queueMicrotask(() => { record("microtask"); resolveTask(); }));
    const immediate = new Promise(resolveImmediate => setImmediate(() => { record("immediate"); resolveImmediate(); }));
    const timer = new Promise(resolveTimer => setTimeout(() => { record("timer_1000ms"); resolveTimer(); }, 1_000));
    const io = new Promise((resolveIo, rejectIo) => {
      const server = createServer((_request, response) => response.end());
      server.once("error", rejectIo);
      server.listen(0, "127.0.0.1", () => {
        const request = get({ host: "127.0.0.1", port: server.address().port, path: "/", agent: false }, response => {
          let eof = false;
          response.on("error", rejectIo); response.resume();
          response.once("end", () => { eof = true; record("http_eof"); });
          response.once("close", () => { record("http_close"); server.close(error => {
            if (!eof) { rejectIo(new Error("The controlled HTTP response closed before EOF")); return; }
            if (error) rejectIo(error); else { record("http_server_closed"); resolveIo(); }
          }); });
        });
        request.once("error", rejectIo);
      });
    });
    await Promise.all([childContext, foregroundNative, foregroundContext, nextTick, microtask, immediate, timer, io]);
    if (owner.isDestroyed()) throw new Error("The crashed owner native window retired during observation");
    record("measurement_completed", { crashedOwnerNativeRetained: true });
    app.exit(0);
  } catch (error) {
    record("observation_failed", { error: String(error?.message ?? error).slice(0, 512) }); app.exit(1);
  }
}
