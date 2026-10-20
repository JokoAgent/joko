import * as filesystem from "node:fs/promises";
import * as paths from "node:path";
import * as crypto from "node:crypto";

export async function auditPersonalDevelopmentRuntimeAssets(runtimeRoot: string, platform: string, architecture: string) {
  return inspectPersonalDevelopmentRuntimeAssets(runtimeRoot, platform, architecture, { filesystem, paths, crypto });
}

async function observePersonalCommandJournal(root: string,
  dependencies: { readonly filesystem: typeof filesystem; readonly paths: typeof paths }, signal: AbortSignal) {
  const { filesystem: files, paths: path } = dependencies;
  const markers = { operationScope: false, commandScope: false, requestFile: false, startedFile: false, retiredFile: false,
    requestBinding: false, startedBinding: false, retiredBinding: false, retiredQuiescent: false };
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
  const ordinary = async (directory: string) => {
    signal.throwIfAborted();
    const info = await files.lstat(directory);
    signal.throwIfAborted();
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const canonical = await files.realpath(directory);
    signal.throwIfAborted();
    return path.relative(directory, canonical) === "";
  };
  if (!await ordinary(root)) return markers;
  const operations = await files.readdir(root);
  signal.throwIfAborted();
  if (operations.length !== 1 || !uuid.test(operations[0]!)) return markers;
  const operationRoot = path.join(root, operations[0]!);
  if (!await ordinary(operationRoot)) return markers;
  markers.operationScope = true;
  const commands = await files.readdir(operationRoot);
  signal.throwIfAborted();
  if (commands.length !== 1 || !uuid.test(commands[0]!)) return markers;
  const commandRoot = path.join(operationRoot, commands[0]!);
  if (!await ordinary(commandRoot)) return markers;
  markers.commandScope = true;
  const read = async (name: "requestFile" | "startedFile" | "retiredFile", file: string) => {
    signal.throwIfAborted();
    const info = await files.lstat(file).catch(() => undefined);
    signal.throwIfAborted();
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 8192) return undefined;
    markers[name] = true;
    const handle = await files.open(file, "r");
    try {
      signal.throwIfAborted();
      const current = await handle.stat();
      signal.throwIfAborted();
      if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev || current.size !== info.size) return undefined;
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      signal.throwIfAborted();
      if (bytesRead > 8192 || (await handle.stat()).size !== info.size) return undefined;
      const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } catch { return undefined; } finally { await handle.close(); }
  };
  const request = await read("requestFile", path.join(commandRoot, "request.json"));
  const started = await read("startedFile", path.join(commandRoot, "started.json"));
  const retired = await read("retiredFile", path.join(commandRoot, "retired.json"));
  const bound = (value: Record<string, unknown> | undefined) => !!request && !!value
    && value.format === 1 && value.commandId === commands[0] && value.operationId === operations[0]
    && value.directory === commandRoot && value.nonce === request.nonce && value.platform === request.platform
    && value.helperSha256 === request.helperSha256 && value.helperSourceDigest === request.helperSourceDigest;
  const digest = /^[a-f0-9]{64}$/u;
  markers.requestBinding = !!request && Object.keys(request).length === 8 && bound(request)
    && typeof request.nonce === "string" && uuid.test(request.nonce) && request.platform === process.platform
    && typeof request.helperSha256 === "string" && digest.test(request.helperSha256)
    && typeof request.helperSourceDigest === "string" && digest.test(request.helperSourceDigest);
  markers.startedBinding = markers.requestBinding && bound(started) && !!started && Object.keys(started).length === 12
    && Number.isSafeInteger(started.pid) && Number(started.pid) > 0 && Number.isSafeInteger(started.helperPid) && Number(started.helperPid) > 0
    && typeof started.identity === "string" && started.identity.length > 0 && started.identity.length <= 256
    && typeof started.helperBirth === "string" && started.helperBirth.length > 0 && started.helperBirth.length <= 256;
  markers.retiredBinding = markers.startedBinding && bound(retired) && !!started && !!retired && Object.keys(retired).length === 16
    && retired.pid === started.pid && retired.identity === started.identity
    && retired.helperPid === started.helperPid && retired.helperBirth === started.helperBirth;
  markers.retiredQuiescent = markers.retiredBinding && retired?.activeProcesses === 0
    && retired.exitCode === 0 && retired.cancelled === false && retired.forcedDescendants === false;
  return markers;
}

async function inspectPersonalDevelopmentRuntimeAssets(runtimeArgument: string, platform: string, architecture: string,
  dependencies: { readonly filesystem: typeof filesystem; readonly paths: typeof paths; readonly crypto: typeof crypto }) {
  const { lstat, readFile, realpath } = dependencies.filesystem;
  const { resolve, isAbsolute, relative, sep } = dependencies.paths;
  if (!["win32", "darwin", "linux"].includes(platform) || !["x64", "arm64"].includes(architecture) || (platform === "win32" && architecture !== "x64")) {
    throw new Error("The personal development command host does not support this Desktop target.");
  }
  if (!isAbsolute(runtimeArgument) || resolve(runtimeArgument) !== runtimeArgument) throw new Error("Personal development requires one normalized absolute runtime root.");
  const runtimeRoot = await realpath(runtimeArgument);
  const same = (left: string, right: string) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (!same(runtimeRoot, runtimeArgument)) throw new Error("The personal development runtime root is not canonical.");
  const packageRoot = resolve(runtimeRoot, "node_modules/@joko/personal-development");
  const manifest = JSON.parse(await readFile(await regular(resolve(packageRoot, "package.json")), "utf8")) as { name?: string; exports?: Record<string, unknown> };
  if (manifest.name !== "@joko/personal-development" || manifest.exports?.["."] !== "./dist/index.js") throw new Error("Personal development requires its built package entry.");
  await regular(resolve(packageRoot, "dist/index.js"));
  const runnerEntry = await regular(resolve(packageRoot, "dist/supervised-process.js"));
  const posixHelperPath = await regular(resolve(packageRoot, "dist/posix-command-host.js"));
  await regular(resolve(packageRoot, "dist/posix-command-sentinel.js"));
  const nativeManifest = JSON.parse(await readFile(await regular(resolve(packageRoot, "dist/native-command-host/manifest.json")), "utf8")) as {
    format?: number; platform?: string; architecture?: string; sourceDigest?: string;
    helper?: null | { file?: string; sha256?: string; bytes?: number };
  };
  if (nativeManifest.format !== 1 || nativeManifest.platform !== platform || nativeManifest.architecture !== architecture) throw new Error("Personal command helper target identity does not match the Desktop runtime.");
  let windowsHelperPath: string | undefined;
  let helperSha256: string | undefined;
  if (platform === "win32") {
    if (!/^[a-f0-9]{64}$/u.test(nativeManifest.sourceDigest ?? "") || nativeManifest.helper?.file !== "joko-command-host.exe") throw new Error("Personal command helper has no built source identity.");
    windowsHelperPath = await regular(resolve(packageRoot, "dist/native-command-host/joko-command-host.exe"));
    const bytes = await readFile(windowsHelperPath);
    helperSha256 = dependencies.crypto.createHash("sha256").update(bytes).digest("hex");
    const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
    if (nativeManifest.helper.bytes !== bytes.length || nativeManifest.helper.sha256 !== helperSha256 || offset < 0 || offset + 6 > bytes.length || bytes.toString("ascii", 0, 2) !== "MZ" || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) {
      throw new Error("Personal command helper content or Windows x64 executable identity is invalid.");
    }
  } else if (nativeManifest.helper !== null) throw new Error("A POSIX personal command host must use the packaged group supervisor.");
  return { runtimeRoot, packageRoot, runnerEntry, posixHelperPath, windowsHelperPath, helperSha256 };

  async function regular(path: string) {
    const rel = relative(packageRoot, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("A personal development runtime asset escapes its package.");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !same(await realpath(path), path)) throw new Error("A personal development runtime asset is not a canonical regular file.");
    return path;
  }
}

export function personalDevelopmentElectronSmokeSource(platform: string, architecture: string): string {
  return `
import * as filesystem from "node:fs/promises";
import * as paths from "node:path";
import * as crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
const expected = ${JSON.stringify({ platform, architecture })};
const inspectPersonalDevelopmentRuntimeAssets = ${inspectPersonalDevelopmentRuntimeAssets.toString()};
if (!process.versions.electron || process.platform !== expected.platform || process.arch !== expected.architecture) throw new Error("Personal development smoke requires its matching Electron-Node target.");
const inspected = await inspectPersonalDevelopmentRuntimeAssets(process.argv[2], expected.platform, expected.architecture, { filesystem, paths, crypto });
const { createSupervisedDevelopmentProcessAuthority } = await import(pathToFileURL(inspected.runnerEntry).href);
const journalDirectory = await filesystem.mkdtemp(paths.join(await filesystem.realpath(tmpdir()), "joko-personal-command-smoke-"));
const observePersonalCommandJournal = ${observePersonalCommandJournal.toString()};
const startedAt = performance.now();
let phase = "command";
let nativeFailed = false;
try {
const runner = createSupervisedDevelopmentProcessAuthority({ windowsHelperPath: inspected.windowsHelperPath, posixHelperPath: inspected.posixHelperPath, nodeExecutable: process.execPath, journalDirectory });
const result = await runner.run({ executable: process.execPath, args: ["-e", "process.stdout.write('JOKO_PERSONAL_COMMAND_READY')"], cwd: inspected.runtimeRoot,
  environment: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, signal: new AbortController().signal, timeoutMs: 10000, maxOutputBytes: 1024 });
phase = "result";
if (result.exitCode !== 0 || result.stdout !== "JOKO_PERSONAL_COMMAND_READY") throw new Error("The relocated personal command host did not return its retired command result.");
phase = "publish";
process.stdout.write(JSON.stringify({ ok: true, ...inspected, commandRetired: true, electronVersion: process.versions.electron }));
} catch (error) {
  nativeFailed = true;
  let observationTimer;
  const observationAbort = new AbortController();
  try {
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    const receipt = await Promise.race([
      observePersonalCommandJournal(journalDirectory, { filesystem, paths }, observationAbort.signal).then(markers => ({ markers }), () => ({ observationUnavailable: true })),
      new Promise(resolve => { observationTimer = setTimeout(() => { observationAbort.abort(); resolve({ observationUnavailable: true }); }, 250); })
    ]);
    const cause = error && typeof error === "object" && "cause" in error ? error.cause : undefined;
    const commandFailure = cause && typeof cause === "object" && "stage" in cause && "systemCode" in cause
      && ["leader", "birth", "terminate", "quiescence", "drain", "receipt"].includes(String(cause.stage))
      && ["ESRCH", "EPERM", "EACCES", "EIO", "ENOENT", "ENOSPC", "unknown"].includes(String(cause.systemCode))
      ? { stage: cause.stage, systemCode: cause.systemCode } : undefined;
    console.error("[personal-command-smoke-boundary]", JSON.stringify({ phase, elapsedMs, ...receipt, commandFailure }));
  } catch { /* The observation must not replace the original native failure. */ }
  finally { clearTimeout(observationTimer); observationAbort.abort(); }
  throw error;
} finally {
  try { await filesystem.rm(journalDirectory, { recursive: true, force: true }); }
  catch (cleanupError) {
    if (!nativeFailed) throw cleanupError;
    try { console.error("[personal-command-smoke-boundary]", JSON.stringify({ phase: "cleanup", cleanupFailed: true })); } catch {}
  }
}
`;
}
