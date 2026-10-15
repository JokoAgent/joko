import * as filesystem from "node:fs/promises";
import * as paths from "node:path";
import * as crypto from "node:crypto";

export async function auditPersonalDevelopmentRuntimeAssets(runtimeRoot: string, platform: string, architecture: string) {
  return inspectPersonalDevelopmentRuntimeAssets(runtimeRoot, platform, architecture, { filesystem, paths, crypto });
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
try {
const runner = createSupervisedDevelopmentProcessAuthority({ windowsHelperPath: inspected.windowsHelperPath, posixHelperPath: inspected.posixHelperPath, nodeExecutable: process.execPath, journalDirectory });
const result = await runner.run({ executable: process.execPath, args: ["-e", "process.stdout.write('JOKO_PERSONAL_COMMAND_READY')"], cwd: inspected.runtimeRoot,
  environment: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, signal: new AbortController().signal, timeoutMs: 10000, maxOutputBytes: 1024 });
if (result.exitCode !== 0 || result.stdout !== "JOKO_PERSONAL_COMMAND_READY") throw new Error("The relocated personal command host did not return its retired command result.");
process.stdout.write(JSON.stringify({ ok: true, ...inspected, commandRetired: true, electronVersion: process.versions.electron }));
} finally { await filesystem.rm(journalDirectory, { recursive: true, force: true }); }
`;
}
