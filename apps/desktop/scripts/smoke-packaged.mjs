import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sqliteVecElectronSmokeSource } from "../dist/runtime-staging.js";

// Without arguments this exercises the staged development host. `--unpacked`
// launches electron-builder's real app.isPackaged output with its external
// Orchestrator runtime. The installer itself is never executed by this smoke.
const require = createRequire(import.meta.url);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = resolve(appRoot, "release");
const useUnpackedArtifact = parseArguments(process.argv.slice(2));
const executable = useUnpackedArtifact ? resolveUnpackedExecutable(releaseRoot) : require("electron");
const markerDirectory = mkdtempSync(resolve(tmpdir(), "joko-desktop-smoke-"));
const markerPath = resolve(markerDirectory, "result.txt");
const smokeUserDataPath = resolve(markerDirectory, "user-data");
const timeoutMs = boundedTimeout(process.env.JOKO_DESKTOP_SMOKE_TIMEOUT_MS);
if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  rmSync(markerDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  throw new Error("Packaged desktop smoke requires a display server on Linux. Run it under `xvfb-run -a` in headless environments.");
}
let sqliteVecSmoke;
try {
  // Electron's app.setPath throws when its directory does not already exist.
  // Create the isolated smoke profile before the main module receives it.
  mkdirSync(smokeUserDataPath, { recursive: false, mode: 0o700 });
  sqliteVecSmoke = await runSqliteVecElectronSmoke(
    executable,
    resolveOrchestratorRuntimeRoot(executable, useUnpackedArtifact),
    markerDirectory
  );
} catch (error) {
  rmSync(markerDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  throw error;
}
const connectSmoke = await createConnectSmokeServer();
const childEnvironment = {
  ...process.env,
  ELECTRON_ENABLE_LOGGING: "1",
  JOKO_DESKTOP_PACKAGED_SMOKE: "1",
  JOKO_DESKTOP_SMOKE_CONNECT_ORIGIN: connectSmoke.origin,
  JOKO_DESKTOP_SMOKE_PUBLIC_HTTP_ORIGIN: connectSmoke.publicOrigin,
  JOKO_DESKTOP_SMOKE_RESULT: markerPath,
  JOKO_DESKTOP_SMOKE_USER_DATA: smokeUserDataPath
};
// A parent Node process may itself run with this Electron development flag.
// Inheriting it would make the packaged executable run as Node instead of
// exercising Chromium, preload isolation, file navigation and renderer boot.
delete childEnvironment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [
  ...(process.platform === "linux" && process.env.JOKO_DESKTOP_SMOKE_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  "--disable-gpu",
  "--enable-logging=stderr",
  "--host-resolver-rules=MAP public.example 127.0.0.1",
  ...(useUnpackedArtifact ? [] : [appRoot])
], {
  cwd: useUnpackedArtifact ? dirname(executable) : appRoot,
  env: childEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  process.stderr.write(chunk);
});

let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, timeoutMs);
let result;
try {
  result = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    // Electron may report process exit before Chromium helpers have closed the
    // inherited stdio pipes. Waiting for close keeps profile cleanup from
    // racing their final user-data writes, especially on macOS.
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
} finally {
  clearTimeout(timeout);
  await connectSmoke.close();
}
const marker = existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : "";
const progressPath = `${markerPath}.progress`;
const progress = existsSync(progressPath) ? readFileSync(progressPath, "utf8").trim().replace(/\n/gu, " -> ") : "";
const managedOrigin = readManagedOrigin(resolve(markerDirectory, "user-data", "managed-orchestrator-host", "connection.json"));
const managedOrchestratorStopped = managedOrigin === undefined || await waitForManagedOrchestratorExit(managedOrigin, 5_000);
rmSync(markerDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
if (
  timedOut || marker !== "JOKO_DESKTOP_SMOKE_OK" || result.code !== 0 || result.signal !== null ||
  connectSmoke.observations.preflightOrigin !== "joko://app" ||
  connectSmoke.observations.requestOrigin !== "joko://app" ||
  connectSmoke.observations.requestBody !== "{}" ||
  connectSmoke.observations.publicRequestSeen || !managedOrchestratorStopped
) {
  throw new Error(
    `Packaged desktop smoke failed (platform=${process.platform}, timeoutMs=${timeoutMs}, code=${String(result.code)}, signal=${String(result.signal)}, marker=${marker}, progress=${progress}, sqliteVec=${sqliteVecSmoke.version}, connect=${JSON.stringify(connectSmoke.observations)}): ${stderr.slice(-1_000)}`
  );
}

async function runSqliteVecElectronSmoke(electronExecutable, runtimeRoot, temporaryRoot) {
  const smokePath = resolve(temporaryRoot, "sqlite-vec-runtime-smoke.mjs");
  writeFileSync(smokePath, `${sqliteVecElectronSmokeSource(process.platform, process.arch)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  try {
    const result = await runBoundedChild(electronExecutable, [smokePath, runtimeRoot], {
      cwd: runtimeRoot,
      environment,
      timeoutMs: 45_000
    });
    if (result.code !== 0 || result.signal !== null || result.timedOut) {
      throw new Error(
        `Electron-Node sqlite-vec smoke failed (code=${String(result.code)}, signal=${String(result.signal)}): ${result.stderr.slice(-2_000)}`
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Electron-Node sqlite-vec smoke returned invalid JSON: ${result.stdout.slice(-1_000)}`);
    }
    if (parsed?.ok !== true || parsed.runtimeRoot !== realpathSync(runtimeRoot) ||
        typeof parsed.version !== "string" || typeof parsed.electronVersion !== "string") {
      throw new Error("Electron-Node sqlite-vec smoke returned an invalid result identity.");
    }
    return parsed;
  } finally {
    rmSync(smokePath, { force: false });
  }
}

function runBoundedChild(executablePath, arguments_, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePath, arguments_, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${String(chunk)}`.slice(-256 * 1024);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error("Electron-Node sqlite-vec smoke could not start.", { cause: error }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stderr, stdout, timedOut });
    });
  });
}

function resolveOrchestratorRuntimeRoot(electronExecutable, useUnpacked) {
  if (!useUnpacked) return resolve(appRoot, "dist", "orchestrator-runtime");
  if (process.platform === "darwin") {
    return resolve(dirname(electronExecutable), "..", "Resources", "orchestrator-runtime");
  }
  return resolve(dirname(electronExecutable), "resources", "orchestrator-runtime");
}

function readManagedOrigin(path) {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.origin !== "string") return undefined;
    const origin = new URL(parsed.origin);
    return origin.protocol === "http:" && origin.hostname === "127.0.0.1" && origin.origin === parsed.origin
      ? origin.origin
      : undefined;
  } catch {
    return undefined;
  }
}

async function waitForManagedOrchestratorExit(origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      await fetch(`${origin}/joko.v1.ConnectionService/GetServerInfo`, {
        method: "POST",
        headers: { "content-type": "application/json", "connect-protocol-version": "1" },
        body: "{}",
        signal: AbortSignal.timeout(500)
      });
    } catch {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  } while (Date.now() < deadline);
  return false;
}

async function createConnectSmokeServer() {
  const observations = {
    preflightOrigin: undefined,
    requestOrigin: undefined,
    requestBody: undefined,
    publicRequestSeen: false
  };
  const server = createServer((request, response) => {
    if (request.url === "/public-http-must-be-blocked") {
      observations.publicRequestSeen = true;
      response.writeHead(request.method === "OPTIONS" ? 204 : 200, {
        "access-control-allow-origin": "joko://app",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "x-joko-client-version",
        vary: "Origin",
        connection: "close"
      });
      response.end(request.method === "OPTIONS" ? undefined : "unexpected");
      return;
    }
    if (request.url !== "/joko.v1.ConnectionService/GetServerInfo") {
      response.writeHead(404, { "content-type": "text/plain", connection: "close" });
      response.end("Not found.");
      return;
    }
    const origin = request.headers.origin;
    if (request.method === "OPTIONS") {
      observations.preflightOrigin = origin;
      if (origin !== "joko://app" || request.headers["access-control-request-method"] !== "POST") {
        response.writeHead(403, { connection: "close" });
        response.end();
        return;
      }
      response.writeHead(204, {
        "access-control-allow-origin": "joko://app",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, connect-protocol-version, x-joko-client-version",
        "access-control-max-age": "0",
        vary: "Origin",
        connection: "close"
      });
      response.end();
      return;
    }
    if (request.method !== "POST" || origin !== "joko://app") {
      response.writeHead(403, { connection: "close" });
      response.end();
      return;
    }
    observations.requestOrigin = origin;
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= 4_096) chunks.push(chunk);
      else request.destroy();
    });
    request.on("end", () => {
      observations.requestBody = Buffer.concat(chunks).toString("utf8");
      response.writeHead(200, {
        "access-control-allow-origin": "joko://app",
        "content-type": "application/json",
        "connect-protocol-version": "1",
        vary: "Origin",
        connection: "close"
      });
      response.end('{"serverId":"desktop-smoke"}');
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Connect smoke server did not bind an IP port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    publicOrigin: `http://public.example:${address.port}`,
    observations,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise()))
  };
}

function boundedTimeout(value) {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 30_000 && parsed <= 120_000 ? parsed : 60_000;
}

function parseArguments(arguments_) {
  if (arguments_.length === 0) return false;
  if (arguments_.length === 1 && arguments_[0] === "--unpacked") return true;
  throw new Error("Usage: node scripts/smoke-packaged.mjs [--unpacked]");
}

function resolveUnpackedExecutable(root) {
  const candidates = process.platform === "win32"
    ? [resolve(root, "win-unpacked", "Joko.exe"), resolve(root, `win-${process.arch}-unpacked`, "Joko.exe")]
    : process.platform === "linux"
      ? [resolve(root, "linux-unpacked", "joko"), resolve(root, `linux-${process.arch}-unpacked`, "joko")]
      : macExecutableCandidates(root);
  const matches = [...new Set(candidates)].filter((candidate) => existsSync(candidate));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one native unpacked Joko executable under ${root}; found ${matches.length}.`);
  }
  const candidate = matches[0];
  if (candidate === undefined || !pathContained(root, candidate)) {
    throw new Error("The unpacked Joko executable path escapes the ignored release directory.");
  }
  const info = lstatSync(candidate);
  if (!info.isFile() || info.isSymbolicLink() || !samePath(realpathSync(candidate), candidate)) {
    throw new Error("The unpacked Joko executable is not a canonical regular file.");
  }
  return candidate;
}

function macExecutableCandidates(root) {
  if (process.platform !== "darwin" || !existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^mac(?:-(?:arm64|x64|universal))?$/u.test(entry.name))
    .map((entry) => resolve(root, entry.name, "Joko.app", "Contents", "MacOS", "Joko"));
}

function pathContained(root, candidate) {
  const normalizedRoot = `${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`;
  const normalizedCandidate = resolve(candidate);
  return process.platform === "win32"
    ? normalizedCandidate.toLowerCase().startsWith(normalizedRoot.toLowerCase())
    : normalizedCandidate.startsWith(normalizedRoot);
}

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}
