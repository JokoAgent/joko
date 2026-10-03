import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(desktopRoot, "dist", "native-system-frontmost-input");
const helperNames = Object.freeze({
  win32: "joko-windows-frontmost-input.node",
  darwin: "joko-macos-frontmost-input.node"
});
const helperName = helperNames[process.platform];
const output = helperName === undefined ? undefined : join(outputRoot, helperName);
const manifestPath = join(outputRoot, "manifest.json");
const electronVersion = "43.6.0";
const officialBase = `https://artifacts.electronjs.org/headers/dist/v${electronVersion}/`;
const headerName = `node-v${electronVersion}-headers.tar.gz`;
const headerDigest = "c4381ce4fa6470ba561e796a55c8c10f74b124ab645284862e725a492af126d2";
const checksumDigest = "4849831200cd1c76b3153f172706e84dcd1fd30a3061288ab534400e63a0f109";
const architectures = Object.freeze({
  x64: { compiler: "x64", machine: "X64", library: "x64/node.lib",
    sha256: "12f84f12fd7336f9dd8f3ba900e58b68ba9125f1f506528072a26c415564c0e5" },
  arm64: { compiler: "x64_arm64", machine: "ARM64", library: "arm64/node.lib",
    sha256: "6cffb1169b2f081a0ae497e86c694f35a938db0dbfb0cc348e4d2cd48e0f73b7" },
  ia32: { compiler: "x86", machine: "X86", library: "node.lib",
    sha256: "ef800c7e6fefca0e8642ed97b10248034b00eee63c53bd2dbc732da5e3488762" }
});
const headerNames = new Set([
  "node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h"
]);

mkdirSync(outputRoot, { recursive: true });
for (const name of Object.values(helperNames)) {
  const candidate = join(outputRoot, name);
  if (existsSync(candidate)) rmSync(candidate);
}
writeManifest(null, null);

if (process.platform === "win32" || process.platform === "darwin") {
  const architecture = process.platform === "win32" ? architectures[process.arch] :
    process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "arm64" : undefined;
  if (architecture === undefined) throw new Error("The system frontmost native build architecture is unsupported.");
  const cacheBase = process.platform === "win32"
    ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    : join(homedir(), "Library", "Caches");
  const cacheRoot = join(cacheBase,
    "Joko", "BuildCache", "system-frontmost-input", `electron-${electronVersion}`, process.arch);
  mkdirSync(cacheRoot, { recursive: true });
  const checksums = await cachedInput(cacheRoot, "SHASUMS256.txt", "SHASUMS256.txt", checksumDigest, 16_384);
  const identities = new Map(checksums.toString("utf8").trim().split(/\r?\n/u).map(line => {
    const parsed = /^([a-f0-9]{64}) {2}(\S+)$/u.exec(line);
    if (parsed === null) throw new Error("The official Electron native checksums are invalid.");
    return [parsed[2], parsed[1]];
  }));
  if (identities.get(headerName) !== headerDigest || (process.platform === "win32" &&
      identities.get(architecture.library) !== architecture.sha256)) {
    throw new Error("The official Electron native checksums do not match the pinned build inputs.");
  }
  const headerArchive = await cachedInput(cacheRoot, headerName, headerName, headerDigest, 4 * 1024 * 1024);
  if (process.platform === "win32") {
    await cachedInput(cacheRoot, "node.lib", architecture.library, architecture.sha256, 8 * 1024 * 1024);
  }
  const includeRoot = join(cacheRoot, "include");
  mkdirSync(includeRoot, { recursive: true });
  for (const [name, bytes] of unpackHeaders(headerArchive)) {
    cacheVerifiedBytes(join(includeRoot, name), bytes, digest(bytes));
  }
  if (process.platform === "win32") buildWindows(architecture, includeRoot, join(cacheRoot, "node.lib"));
  else buildMac(architecture, includeRoot);
  writeManifest(helperName, digest(readFileSync(output)));
}

function writeManifest(helper, sha256) {
  writeFileSync(manifestPath, `${JSON.stringify({
    architecture: process.arch, helper, platform: process.platform, protocolVersion: 1, sha256
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function cachedInput(directory, cacheName, officialName, expectedDigest, maximumBytes) {
  const path = join(directory, cacheName);
  if (existsSync(path)) return verifiedCache(path, expectedDigest, maximumBytes);
  const response = await fetch(new URL(officialName, officialBase), {
    redirect: "error", signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok || response.body === null) throw new Error("An official Electron native build input could not be downloaded.");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw new Error("An official Electron native build input exceeds its size limit.");
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  cacheVerifiedBytes(path, bytes, expectedDigest);
  return verifiedCache(path, expectedDigest, maximumBytes);
}

function cacheVerifiedBytes(path, bytes, expectedDigest) {
  if (digest(bytes) !== expectedDigest) throw new Error("An Electron native build input failed its pinned integrity check.");
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  verifiedCache(path, expectedDigest, bytes.length);
}

function verifiedCache(path, expectedDigest, maximumBytes) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > maximumBytes) {
    throw new Error("The cached Electron native build input is not a bounded regular file.");
  }
  const bytes = readFileSync(path);
  if (digest(bytes) !== expectedDigest) {
    throw new Error("The cached Electron native build input has changed; rebuild its cache explicitly.");
  }
  return bytes;
}

function unpackHeaders(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 16 * 1024 * 1024 });
  const headers = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const entry = tar.subarray(offset, offset + 512);
    if (entry.every(byte => byte === 0)) break;
    const name = entry.subarray(0, 100).toString("utf8").split("\0", 1)[0];
    const sizeField = entry.subarray(124, 136).toString("ascii").split("\0", 1)[0].trim();
    if (!/^[0-7]+$/u.test(sizeField)) throw new Error("The pinned Electron headers archive size is invalid.");
    const size = Number.parseInt(sizeField, 8);
    const start = offset + 512;
    if (!Number.isSafeInteger(size) || start + size > tar.length) {
      throw new Error("The pinned Electron headers archive is truncated.");
    }
    for (const header of headerNames) {
      if (name !== `node_headers/include/node/${header}`) continue;
      if ((entry[156] !== 0 && entry[156] !== 48) || size === 0 || size > 512 * 1024 || headers.has(header)) {
        throw new Error("The pinned Electron headers archive contains an invalid Node-API header.");
      }
      headers.set(header, tar.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (headers.size !== headerNames.size) throw new Error("The pinned Electron archive is missing a required Node-API header.");
  return headers;
}

function buildWindows(architecture, includeRoot, nodeLibrary) {
  const installerRoot = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio", "Installer");
  const vswhere = join(installerRoot, "vswhere.exe");
  if (!existsSync(vswhere)) throw new Error("Visual Studio C++ Build Tools are required for the system frontmost sampler.");
  const installation = run(vswhere, ["-latest", "-products", "*", "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"]).trim();
  const variables = join(installation, "VC", "Auxiliary", "Build", "vcvarsall.bat");
  if (installation === "" || !existsSync(variables) || /[\r\n"%!]/u.test(variables)) {
    throw new Error("The Visual Studio C++ toolchain could not be resolved safely.");
  }
  const environmentScript = join(outputRoot, "joko-frontmost-build-environment.cmd");
  const temporary = join(outputRoot, "joko-windows-frontmost-input.build.node");
  const object = join(outputRoot, "joko-windows-frontmost-input.build.obj");
  const library = join(outputRoot, "joko-windows-frontmost-input.build.lib");
  const exports = join(outputRoot, "joko-windows-frontmost-input.build.exp");
  const temporaryFiles = [environmentScript, temporary, object, library, exports];
  try {
    for (const file of temporaryFiles) { if (existsSync(file)) rmSync(file); }
    writeFileSync(environmentScript, `@echo off\r\ncall "${variables}" ${architecture.compiler} >nul\r\n` +
      "if errorlevel 1 exit /b %errorlevel%\r\nset\r\n", { encoding: "utf8", mode: 0o600 });
    const environment = {};
    const commandProcessor = process.env.ComSpec ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    for (const line of run(commandProcessor, ["/d", "/c", environmentScript]).split(/\r?\n/u)) {
      const separator = line.indexOf("=");
      if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
    }
    run("cl.exe", ["/nologo", "/std:c++17", "/O2", "/MT", "/EHsc", "/LD",
      "/DBUILDING_NODE_EXTENSION", "/DNAPI_VERSION=8", `/I${includeRoot}`, `/Fo${object}`,
      `/Fe${temporary}`, join(desktopRoot, "native", "system-frontmost-input", "windows-frontmost-input.cc"),
      "/link", "/BREPRO", `/MACHINE:${architecture.machine}`, `/IMPLIB:${library}`,
      "/DELAYLOAD:node.exe", nodeLibrary, "user32.lib", "delayimp.lib"], environment);
    if (!existsSync(temporary)) throw new Error("The system frontmost native build produced no sampler.");
    renameSync(temporary, output);
  } finally {
    for (const file of temporaryFiles) { if (existsSync(file)) rmSync(file); }
  }
}

function buildMac(architecture, includeRoot) {
  const sdkRoot = run("xcrun", ["--sdk", "macosx", "--show-sdk-path"], undefined, 10_000).trim();
  if (sdkRoot === "" || /[\r\n]/u.test(sdkRoot) || !existsSync(join(sdkRoot, "usr", "lib", "libproc.tbd"))) {
    throw new Error("The macOS SDK must provide the public process identity library.");
  }
  const temporary = join(outputRoot, "joko-macos-frontmost-input.build.node");
  try {
    if (existsSync(temporary)) rmSync(temporary);
    run("xcrun", ["--sdk", "macosx", "clang++", "-std=c++17", "-O2", "-fobjc-arc",
      "-bundle", "-undefined", "dynamic_lookup", "-arch", architecture, "-isysroot", sdkRoot,
      "-DNAPI_VERSION=8", `-I${includeRoot}`,
      join(desktopRoot, "native", "system-frontmost-input", "macos-frontmost-input.mm"),
      "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "CoreGraphics",
      "-lproc", "-o", temporary], undefined, 60_000);
    if (!existsSync(temporary)) throw new Error("The macOS system frontmost native build produced no helper.");
    renameSync(temporary, output);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function run(command, args, environment, timeoutMs) {
  const result = spawnSync(command, args, { cwd: desktopRoot, env: environment ?? process.env,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 1024 * 1024,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error((result.stderr || result.stdout || result.error?.message || "The system frontmost native build failed.").trim());
  }
  return result.stdout;
}
