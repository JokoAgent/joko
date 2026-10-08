import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { resolveDedicatedHardwareSdkIdentity } from "./dedicated-hardware-sdk.js";
import {
  parseDedicatedHardwareSdkIdentity,
  type DedicatedHardwareSdkIdentity
} from "./dedicated-hardware/protocol.js";

const require = createRequire(import.meta.url);
const PACKAGE_NAME = "@worklouder/device-kit-oai";
const NATIVE_HELPER = "joko-windows-micro-helper.exe";
type InstalledIdentity = Extract<DedicatedHardwareSdkIdentity, { kind: "installed" }>;
type NativeIdentity = Extract<DedicatedHardwareSdkIdentity, { kind: "native-usb" }>;

/** Main discovers code only; device I/O and SDK execution belong to the utility process. */
export async function resolveDedicatedHardwareRuntime(options: {
  readonly stagingDirectory: string;
  readonly nativeDirectory: string;
  readonly packageDirectories?: readonly string[];
}): Promise<DedicatedHardwareSdkIdentity> {
  const staged = await resolveDedicatedHardwareSdkIdentity(options);
  if (staged.kind !== "unavailable") return staged;
  const candidates = options.packageDirectories ?? [
    ...localPackageDirectories(), ...installedHardwareSdkDirectories(process.platform, process.env)
  ];
  for (const directory of candidates) {
    const installed = await inspectInstalledSdk(directory);
    if (installed !== undefined) return installed;
  }
  return await inspectNativeHelper(options.nativeDirectory) ?? { kind: "unavailable" };
}

export function installedHardwareSdkDirectories(
  platform: string,
  env: Readonly<Record<string, string | undefined>>
): readonly string[] {
  const roots: string[] = [];
  for (const app of ["ChatGPT", "Codex"]) {
    if (platform === "darwin") roots.push(`/Applications/${app}.app/Contents/Resources`);
    if (platform === "win32") {
      for (const base of [env.LOCALAPPDATA, env.ProgramFiles]) {
        if (base === undefined || !isAbsolute(base)) continue;
        roots.push(join(base, app, "resources"), join(base, "Programs", app, "resources"));
      }
    }
  }
  return roots.map(root => join(root, "app.asar", "node_modules", PACKAGE_NAME));
}

/** A local identity is a freshness check, not a redistribution approval or whole-tree attestation. */
export async function reverifyDedicatedHardwareRuntime(
  identity: InstalledIdentity | NativeIdentity
): Promise<boolean> {
  if (identity.platform !== process.platform || identity.architecture !== process.arch) return false;
  const current = identity.kind === "installed"
    ? await inspectInstalledSdk(identity.packageDirectory)
    : await inspectNativeHelper(dirname(identity.executablePath));
  return current !== undefined && JSON.stringify(current) === JSON.stringify(identity);
}

function localPackageDirectories(): readonly string[] {
  try {
    let directory = dirname(require.resolve(PACKAGE_NAME));
    const candidates: string[] = [];
    // Package exports may hide package.json. Inspect ancestors without executing package code.
    while (dirname(directory) !== directory) {
      candidates.push(directory);
      directory = dirname(directory);
    }
    return candidates;
  } catch { return []; }
}

async function inspectInstalledSdk(directory: string): Promise<InstalledIdentity | undefined> {
  try {
    const packageDirectory = resolve(directory);
    const metadata: unknown = JSON.parse((await boundedFile(join(packageDirectory, "package.json"), 256 * 1024)).toString("utf8"));
    if (!record(metadata) || metadata.name !== PACKAGE_NAME || typeof metadata.version !== "string") return undefined;
    const entryPath = require.resolve(packageDirectory);
    const suffix = relative(packageDirectory, entryPath);
    if (!suffix || suffix.startsWith("..") || isAbsolute(suffix)) return undefined;
    const entry = await boundedFile(entryPath, 32 * 1024 * 1024);
    const identity = parseDedicatedHardwareSdkIdentity({ kind: "installed", packageDirectory, entryPath,
      packageVersion: metadata.version, entrySha256: sha256(entry), platform: process.platform, architecture: process.arch });
    return identity?.kind === "installed" ? identity : undefined;
  } catch { return undefined; }
}

async function inspectNativeHelper(directory: string): Promise<NativeIdentity | undefined> {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) return undefined;
  try {
    const manifest: unknown = JSON.parse((await boundedFile(join(directory, "manifest.json"), 4096)).toString("utf8"));
    if (!record(manifest) || Object.keys(manifest).sort().join(",") !== "architecture,helper,platform,protocolVersion,sha256" ||
        manifest.protocolVersion !== 1 || manifest.platform !== process.platform ||
        manifest.architecture !== process.arch || manifest.helper !== NATIVE_HELPER) return undefined;
    const executablePath = resolve(directory, NATIVE_HELPER);
    const bytes = await boundedFile(executablePath, 8 * 1024 * 1024);
    if (sha256(bytes) !== manifest.sha256 || !isNativeHelperTarget(bytes, process.arch)) return undefined;
    const identity = parseDedicatedHardwareSdkIdentity({ kind: "native-usb", executablePath,
      sha256: manifest.sha256, platform: "win32", architecture: process.arch });
    return identity?.kind === "native-usb" ? identity : undefined;
  } catch { return undefined; }
}

function isNativeHelperTarget(bytes: Buffer, architecture: string): boolean {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) return false;
  const offset = bytes.readUInt32LE(0x3c);
  return offset <= bytes.length - 6 && bytes.readUInt32LE(offset) === 0x4550 &&
    bytes.readUInt16LE(offset + 4) === (architecture === "arm64" ? 0xaa64 : 0x8664);
}

async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.size <= 0 || info.size > maximum) throw new Error("Invalid hardware runtime file.");
  const bytes = await readFile(path);
  if (bytes.length !== info.size) throw new Error("Hardware runtime changed during discovery.");
  return bytes;
}

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
