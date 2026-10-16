import { spawn } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STDERR_LIMIT = 4_096;
const STDOUT_LIMIT = 1024 * 1024;
const PROBE_TIMEOUT_MS = 8_000;
const html = "<!doctype html><html><body><h1>PDF diagnostic</h1></body></html>";

// Match the production PDF helper's current allowlist. The second observation
// adds only the existing X server authority-file reference, never its contents.
const helperVariables = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "HOME", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "DISPLAY", "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL", "LC_CTYPE"];

export function privateTextObservation(limit = STDERR_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > STDERR_LIMIT) throw new RangeError("Invalid private sample limit.");
  let byteCount = 0;
  let sampledBytes = 0;
  const parts = [];
  return {
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += bytes.length;
      const accepted = Math.min(bytes.length, limit - sampledBytes);
      if (accepted > 0) {
        parts.push(Buffer.from(bytes.subarray(0, accepted)));
        sampledBytes += accepted;
      }
    },
    receipt() {
      const text = Buffer.concat(parts).toString("utf8");
      return {
        byteCount, sampledBytes, truncated: byteCount > sampledBytes,
        categories: [
          ["display-auth", /Authorization required|No protocol specified|Invalid MIT-MAGIC-COOKIE|X11 connection rejected/i],
          ["display", /Missing X server|Unable to open X display|cannot open display|ozone_platform_x11|XOpenDisplay failed/i],
          ["sandbox", /No usable sandbox|SUID sandbox|Failed to move to new namespace|zygote_host_impl_linux|sandbox_linux/i],
          ["module", /ERR_MODULE_NOT_FOUND|Cannot find module|MODULE_NOT_FOUND|ERR_DLOPEN_FAILED|error while loading shared libraries|cannot open shared object file/i]
        ].filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
      };
    }
  };
}

function safeErrorCode(error) {
  return ["EACCES", "EPERM", "ENOENT", "EPIPE"].includes(error?.code) ? error.code : "other";
}

function safeSignal(signal) {
  return ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGTRAP", "SIGBUS", "SIGILL"].includes(signal) ? signal : null;
}

async function existingFile(path, executable = false) {
  if (!path || !isAbsolute(path)) throw new Error("Invalid diagnostic file reference.");
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isFile()) throw new Error("Diagnostic file is not regular.");
  await access(resolved, executable ? constants.X_OK : constants.R_OK);
  return resolved;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => {
        const error = new Error("Diagnostic deadline.");
        error.code = "DIAGNOSTIC_TIMEOUT";
        reject(error);
      }, ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function electronObservation(executable, appPath, includeAuthority) {
  const started = performance.now();
  const env = {};
  for (const name of helperVariables) if (process.env[name] !== undefined) env[name] = process.env[name];
  if (includeAuthority) env.XAUTHORITY = process.env.XAUTHORITY;
  const child = spawn(executable, [appPath, "--joko-pdf-render-helper"], {
    cwd: appPath, env, windowsHide: true, shell: false,
    stdio: ["ignore", "pipe", "pipe", "pipe"]
  });
  const stderr = privateTextObservation();
  const output = [];
  let outputBytes = 0;
  let inputPipeError;
  let spawnError;
  let deadlineExpired = false;
  let closed = false;
  const closing = new Promise((resolvePromise) => {
    child.once("close", (exitCode, signal) => {
      closed = true;
      resolvePromise({ exitCode, signal: safeSignal(signal) });
    });
  });
  child.once("error", (error) => { spawnError = safeErrorCode(error); });
  child.stderr.on("data", (chunk) => { stderr.append(chunk); });
  child.stdout.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (outputBytes + bytes.length <= STDOUT_LIMIT) output.push(bytes);
    outputBytes += bytes.length;
    if (outputBytes > STDOUT_LIMIT) child.kill("SIGKILL");
  });
  child.stdio[3].on("error", (error) => { inputPipeError = safeErrorCode(error); });
  child.stdio[3].end(`${JSON.stringify({ version: 1, htmlBase64: Buffer.from(html).toString("base64"),
    pageSize: "A4", landscape: false, printBackground: true,
    margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }, fontTimeoutMs: 5_000 })}\n`);
  let result = { exitCode: null, signal: null };
  try {
    result = await within(closing, PROBE_TIMEOUT_MS);
  } catch {
    deadlineExpired = true;
  } finally {
    if (!closed) {
      child.kill("SIGKILL");
      result = await within(closing, 1_000).catch(() => result);
    }
    child.stdio[3].destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  let pdfProduced = false;
  if (outputBytes <= STDOUT_LIMIT) {
    try {
      const response = JSON.parse(Buffer.concat(output).toString("utf8"));
      pdfProduced = response.version === 1 && response.ok === true && result.exitCode === 0
        && typeof response.pdfBase64 === "string" && Buffer.from(response.pdfBase64, "base64").subarray(0, 5).toString() === "%PDF-";
    } catch { /* The receipt exposes no helper response or document data. */ }
  }
  return {
    variant: includeAuthority ? "existing-display-authority" : "production-environment",
    elapsedMs: Math.round(performance.now() - started), deadlineExpired,
    authorityForwarded: includeAuthority, pdfProduced, outputBytes,
    ...(inputPipeError ? { inputPipeError } : {}), ...(spawnError ? { spawnError } : {}),
    ...result, cleanupConfirmed: closed, stderr: stderr.receipt()
  };
}

async function chromiumObservation(chromium, executablePath) {
  const started = performance.now();
  let server;
  let phase = "launch";
  let pdfProduced = false;
  const errorObservation = privateTextObservation();
  let failureCode;
  let deadlineExpired = false;
  let cleanupState = "launch-handle-unavailable";
  try {
    server = await chromium.launchServer({
      executablePath, host: "127.0.0.1", headless: true, chromiumSandbox: true,
      timeout: PROBE_TIMEOUT_MS,
      args: ["--disable-extensions", "--no-first-run", "--disable-background-networking"]
    });
    await within((async () => {
      phase = "connect";
      const browser = await chromium.connect(server.wsEndpoint(), { timeout: PROBE_TIMEOUT_MS });
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", offline: true,
        viewport: { width: 1024, height: 1440 }, permissions: [] });
      await context.route("**/*", (route) => route.abort("blockedbyclient"));
      await context.routeWebSocket("**/*", (route) => route.close({ code: 1008, reason: "PDF rendering is offline" }));
      const page = await context.newPage();
      phase = "content";
      await page.setContent(html, { waitUntil: "load", timeout: PROBE_TIMEOUT_MS });
      phase = "pdf";
      const bytes = await page.pdf({ format: "A4", landscape: false, printBackground: true,
        margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" }, preferCSSPageSize: false });
      pdfProduced = bytes.subarray(0, 5).toString() === "%PDF-";
      phase = "completed";
    })(), PROBE_TIMEOUT_MS);
  } catch (error) {
    errorObservation.append(Buffer.from(String(error?.message ?? "")));
    failureCode = safeErrorCode(error);
    deadlineExpired = error?.code === "DIAGNOSTIC_TIMEOUT" || /Timeout \d+ms exceeded/u.test(String(error?.message ?? "").slice(0, STDERR_LIMIT));
  } finally {
    if (server) {
      const child = server.process();
      await within(server.close(), 2_000).catch(async () => {
        await within(server.kill(), 2_000).catch(() => { child.kill("SIGKILL"); });
      });
      const deadline = performance.now() + 1_000;
      while (child.exitCode === null && child.signalCode === null && performance.now() < deadline) await delay(20);
      cleanupState = child.exitCode !== null || child.signalCode !== null ? "owned-process-exited" : "owned-exit-unconfirmed";
    }
  }
  return { phase, elapsedMs: Math.round(performance.now() - started), pdfProduced,
    ...(failureCode ? { failureCode } : {}), deadlineExpired, cleanupState, error: errorObservation.receipt() };
}

async function main() {
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true"
    || !/^:\d{1,5}(?:\.\d)?$/u.test(process.env.DISPLAY ?? "")) {
    throw new Error("This diagnostic requires the owned Linux CI display.");
  }
  const executable = await existingFile(process.env.JOKO_PDF_ELECTRON_TEST_EXECUTABLE, true);
  const appPath = await realpath(process.env.JOKO_PDF_ELECTRON_TEST_APP ?? "");
  if (!(await stat(appPath)).isDirectory()) throw new Error("Diagnostic helper app is unavailable.");
  await existingFile(process.env.XAUTHORITY);
  const browserPath = await existingFile(process.env.JOKO_BROWSER_EXECUTABLE, true);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const { chromium } = createRequire(resolve(root, "apps/orchestrator/package.json"))("playwright-core");
  const restriction = (await readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").catch(() => "")).trim();
  console.log(JSON.stringify({ phase: "environment", displayAuthorityAvailable: true,
    source: /^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : "unknown",
    originalCasesExecuted: false, acceptanceReplacement: false, perProbeBudgetMs: PROBE_TIMEOUT_MS,
    unverifiedAssertions: ["original-render-deadline", "timeout-recovery", "zero-network-requests"],
    apparmorRestrictUnprivilegedUserns: restriction === "0" || restriction === "1" ? Number(restriction) : "unknown" }));
  for (const includeAuthority of [false, true]) {
    console.log(JSON.stringify({ phase: "electron", ...await electronObservation(executable, appPath, includeAuthority) }));
  }
  console.log(JSON.stringify({ phase: "chromium", observation: await chromiumObservation(chromium, browserPath) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch((error) => {
    const observation = privateTextObservation();
    observation.append(Buffer.from(String(error?.message ?? "")));
    console.log(JSON.stringify({ phase: "diagnostic-failed", code: safeErrorCode(error), error: observation.receipt() }));
    process.exitCode = 1;
  });
}
