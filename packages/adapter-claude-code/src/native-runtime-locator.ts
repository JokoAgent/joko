import { open, lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { CLAUDE_AGENT_SDK_VERSION } from "./sdk-runtime.js";

export interface ClaudeNativeRuntimeLocation {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly executable: string;
}

export interface ClaudeNativeRuntimeLocatorOptions {
  readonly sdkEntry: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly preferMusl?: boolean;
}

/**
 * Resolves the published SDK's target-native CLI without consulting PATH.
 * The SDK entry, optional package identity and binary architecture are all
 * checked before the absolute executable is returned to a process owner.
 */
export async function locateClaudeNativeRuntime(
  options: ClaudeNativeRuntimeLocatorOptions
): Promise<ClaudeNativeRuntimeLocation> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const candidates = claudeNativeRuntimePackageCandidates(
    platform,
    arch,
    options.preferMusl ?? hostPrefersMusl(platform)
  );
  const sdkEntry = await canonicalRegularFile(options.sdkEntry);
  const sdkRoot = dirname(sdkEntry);
  const sdkManifest = await readManifest(sdkRoot);
  if (sdkManifest["name"] !== "@anthropic-ai/claude-agent-sdk"
    || sdkManifest["version"] !== CLAUDE_AGENT_SDK_VERSION
    || sdkManifest["main"] !== "sdk.mjs"
    || !samePath(sdkEntry, resolve(sdkRoot, "sdk.mjs"))) {
    throw new Error("The Claude native runtime SDK identity is invalid.");
  }

  for (const packageName of candidates) {
    const lexicalRoot = resolve(dirname(sdkRoot), packageName.slice("@anthropic-ai/".length));
    let packageRoot: string;
    try {
      packageRoot = await realpath(lexicalRoot);
    } catch (error) {
      if (isMissing(error)) continue;
      throw new Error("The Claude native runtime package is unavailable.");
    }
    const manifest = await readManifest(packageRoot);
    if (manifest["name"] !== packageName
      || manifest["version"] !== CLAUDE_AGENT_SDK_VERSION
      || !stringArrayEquals(manifest["os"], [platform])
      || !stringArrayEquals(manifest["cpu"], [arch])) {
      throw new Error("The Claude native runtime package identity is invalid.");
    }
    const executable = await canonicalRegularFile(resolve(
      packageRoot,
      platform === "win32" ? "claude.exe" : "claude"
    ));
    const information = await lstat(executable);
    if (platform !== "win32" && (information.mode & 0o111) === 0) {
      throw new Error("The Claude native runtime binary is not executable.");
    }
    await verifyNativeBinary(executable, platform, arch);
    return Object.freeze({ packageName, packageRoot, executable });
  }
  throw new Error("The Claude native runtime package is unavailable.");
}

export function claudeNativeRuntimePackageCandidates(
  platform: NodeJS.Platform,
  arch: string,
  preferMusl: boolean
): readonly string[] {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error("The Claude native runtime does not support this architecture.");
  }
  if (platform === "linux") {
    const standard = `@anthropic-ai/claude-agent-sdk-linux-${arch}`;
    const musl = `${standard}-musl`;
    return Object.freeze(preferMusl ? [musl, standard] : [standard, musl]);
  }
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("The Claude native runtime does not support this platform.");
  }
  return Object.freeze([`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`]);
}

function hostPrefersMusl(platform: NodeJS.Platform): boolean {
  if (platform !== "linux") return false;
  const report = process.report?.getReport() as {
    readonly header?: { readonly glibcVersionRuntime?: unknown };
  } | undefined;
  const header = report?.header;
  return header?.glibcVersionRuntime === undefined;
}

async function verifyNativeBinary(path: string, platform: NodeJS.Platform, arch: string): Promise<void> {
  const handle = await open(path, "r");
  const header = Buffer.alloc(4096);
  try {
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    const bytes = header.subarray(0, bytesRead);
    let matches = false;
    if (platform === "win32" && bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ") {
      const peOffset = bytes.readUInt32LE(60);
      matches = peOffset + 6 <= bytes.length
        && bytes.readUInt32LE(peOffset) === 0x00004550
        && bytes.readUInt16LE(peOffset + 4) === (arch === "x64" ? 0x8664 : 0xaa64);
    } else if (platform === "linux" && bytes.length >= 20
      && bytes.readUInt32BE(0) === 0x7f454c46 && bytes[4] === 2 && bytes[5] === 1) {
      matches = bytes.readUInt16LE(18) === (arch === "x64" ? 62 : 183);
    } else if (platform === "darwin" && bytes.length >= 8
      && bytes.readUInt32LE(0) === 0xfeedfacf) {
      matches = bytes.readUInt32LE(4) === (arch === "x64" ? 0x01000007 : 0x0100000c);
    }
    if (!matches) throw new Error("The Claude native runtime binary architecture is invalid.");
  } finally {
    header.fill(0);
    await handle.close();
  }
}

async function readManifest(root: string): Promise<Record<string, unknown>> {
  const path = await canonicalRegularFile(resolve(root, "package.json"));
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error("The Claude native runtime manifest is invalid.");
  return value;
}

async function canonicalRegularFile(pathValue: string): Promise<string> {
  if (!isAbsolute(pathValue) || resolve(pathValue) !== pathValue) {
    throw new Error("The Claude native runtime path is invalid.");
  }
  const information = await lstat(pathValue);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error("The Claude native runtime entry is not a regular file.");
  }
  const canonical = await realpath(pathValue);
  if (!samePath(canonical, pathValue)) throw new Error("The Claude native runtime entry is not canonical.");
  return canonical;
}

function stringArrayEquals(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
