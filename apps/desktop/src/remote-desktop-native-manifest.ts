import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const MAXIMUM_HELPER_BYTES = 16 * 1024 * 1024;
const LINUX_CREDENTIAL_NAMES = ["main.py", "channel.py", "host.py", "storage.py", "platform_linux.py", "requirements.txt"] as const;
const WINDOWS_HOST_SERVICE = "joko-windows-remote-desktop-host.exe";
const WINDOWS_HOST_ADDON = "joko-windows-remote-desktop-host.node";

export type DesktopRemoteDesktopNativeHelperKind = "input" | "capture" | "credentials" | "clipboard" | "viewer-display";

interface DesktopRemoteDesktopPrivacyArtifact {
  readonly path: string;
  readonly metadata: { readonly version: string; readonly hash: string; readonly source: string };
}

/** Resolve one exact helper from the strict current-v1 packaged manifest. */
export async function verifyPackagedDesktopRemoteDesktopBinary(
  directory: string,
  kind: DesktopRemoteDesktopNativeHelperKind,
  expectedName: string,
  platform: NodeJS.Platform,
  architecture: string
): Promise<string> {
  const files = await verifyPackagedDesktopRemoteDesktopFiles(directory, platform, architecture);
  const requested = files.helpers.get(kind);
  if (requested === undefined || requested.name !== expectedName) throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  return requested.path;
}

export async function verifyPackagedDesktopRemoteDesktopPrivacy(
  directory: string,
  platform: NodeJS.Platform,
  architecture: string
): Promise<DesktopRemoteDesktopPrivacyArtifact> {
  if (platform !== "linux") throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  try {
    const files = await verifyPackagedDesktopRemoteDesktopFiles(directory, platform, architecture);
    if (files.privacy === undefined) throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    return files.privacy;
  } catch { throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE"); }
}

/** Resolve the isolated Linux credential endpoint after verifying all six packaged siblings. */
export async function verifyPackagedDesktopRemoteDesktopLinuxCredentials(
  directory: string,
  platform: NodeJS.Platform,
  architecture: string
): Promise<string> {
  if (platform !== "linux") throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  try {
    const files = await verifyPackagedDesktopRemoteDesktopFiles(directory, platform, architecture);
    if (files.linuxCredentials === undefined) throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    return files.linuxCredentials;
  } catch { throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE"); }
}

/** Main loads the exact Node-API addon and launches the matching packaged service image. */
export async function verifyPackagedDesktopRemoteDesktopWindowsHost(
  directory: string,
  platform: NodeJS.Platform,
  architecture: string
): Promise<{ readonly service: string; readonly addon: string }> {
  if (platform !== "win32") throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  try {
    const files = await verifyPackagedDesktopRemoteDesktopFiles(directory, platform, architecture);
    if (files.windowsHost === undefined) throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    return files.windowsHost;
  } catch { throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE"); }
}

async function verifyPackagedDesktopRemoteDesktopFiles(
  directory: string,
  platform: NodeJS.Platform,
  architecture: string
): Promise<{
  readonly helpers: ReadonlyMap<DesktopRemoteDesktopNativeHelperKind, { readonly name: string; readonly path: string }>;
  readonly privacy: DesktopRemoteDesktopPrivacyArtifact | undefined;
  readonly linuxCredentials: string | undefined;
  readonly windowsHost: { readonly service: string; readonly addon: string } | undefined;
}> {
  const manifestPath = join(directory, "manifest.json");
  const [directoryPath, manifestMetadata, manifestBytes] = await Promise.all([
    realpath(directory),
    lstat(manifestPath),
    readFile(manifestPath)
  ]);
  if (platform === "win32") {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || directoryPath.toLowerCase() !== resolve(directory).toLowerCase()) {
      manifestBytes.fill(0);
      throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    }
  }
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()
    || manifestBytes.byteLength < 1 || manifestBytes.byteLength > 4_096) {
    throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  }
  let manifest: unknown;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
  finally { manifestBytes.fill(0); }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)
    || Object.keys(manifest).sort().join(",") !== [
      "architecture", "captureHelper", "captureSha256", "clipboardHelper", "clipboardSha256", "credentialHelper", "credentialSha256",
      "credentialBundle", "credentialBundleSha256", "inputHelper", "inputSha256",
      "platform", "protocolVersion", "viewerDisplayScript", "viewerDisplaySha256", "viewerDisplayInterpreter",
      "privacyPlugin", "privacySha256", "privacyMetadata", "privacyMetadataSha256",
      "linuxCredentialDirectory", "linuxCredentialInterpreter", "linuxCredentialFiles",
      "windowsHostService", "windowsHostServiceSha256", "windowsHostAddon", "windowsHostAddonSha256", "windowsHostNodeApiVersion"
    ].sort().join(",")) {
    throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  }
  const record = manifest as Record<string, unknown>;
  const expectedInputHelper = platform === "darwin"
    ? "joko-macos-remote-desktop-input"
    : platform === "win32"
      ? "joko-windows-remote-desktop-input.exe"
      : platform === "linux" ? "joko-linux-remote-desktop-input" : null;
  const expectedCaptureHelper = platform === "darwin"
    ? "joko-macos-remote-desktop-capture"
    : platform === "linux" ? "joko-linux-remote-desktop-capture" : null;
  const expectedCredentialHelper = platform === "darwin" ? "joko-macos-remote-credentials" : null;
  const expectedClipboardHelper = platform === "linux" ? "joko-linux-remote-desktop-clipboard" : null;
  const expectedViewerScript = platform === "linux" ? "linux-viewer-display.py" : null;
  const expectedBundle = platform === "darwin" ? "JokoRemoteCredentials_JokoRemoteCredentials.bundle" : null;
  const privacyPresent = platform === "linux" && record["privacyPlugin"] !== null;
  if ((architecture !== "x64" && architecture !== "arm64")
    || expectedInputHelper === null
    || record["protocolVersion"] !== 1 || record["platform"] !== platform
    || record["architecture"] !== architecture
    || record["inputHelper"] !== expectedInputHelper
    || typeof record["inputSha256"] !== "string"
    || !/^[0-9a-f]{64}$/u.test(record["inputSha256"] as string)
    || record["captureHelper"] !== expectedCaptureHelper
    || (expectedCaptureHelper === null
      ? record["captureSha256"] !== null
      : typeof record["captureSha256"] !== "string"
        || !/^[0-9a-f]{64}$/u.test(record["captureSha256"] as string))
    || record["clipboardHelper"] !== expectedClipboardHelper
    || (expectedClipboardHelper === null ? record["clipboardSha256"] !== null
      : typeof record["clipboardSha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["clipboardSha256"] as string))
    || record["viewerDisplayScript"] !== expectedViewerScript
    || record["viewerDisplayInterpreter"] !== (expectedViewerScript === null ? null : "/usr/bin/python3")
    || (expectedViewerScript === null ? record["viewerDisplaySha256"] !== null
      : typeof record["viewerDisplaySha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["viewerDisplaySha256"] as string))
    || (privacyPresent
      ? record["privacyPlugin"] !== "joko-hyprland-privacy.so" || record["privacyMetadata"] !== "joko-hyprland-privacy.json"
        || typeof record["privacySha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["privacySha256"] as string)
        || typeof record["privacyMetadataSha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["privacyMetadataSha256"] as string)
      : record["privacyPlugin"] !== null || record["privacySha256"] !== null
        || record["privacyMetadata"] !== null || record["privacyMetadataSha256"] !== null)
    || record["credentialHelper"] !== expectedCredentialHelper
    || record["credentialBundle"] !== expectedBundle
    || record["linuxCredentialDirectory"] !== (platform === "linux" ? "linux-credentials" : null)
    || record["linuxCredentialInterpreter"] !== (platform === "linux" ? "/usr/bin/python3" : null)
    || (platform !== "linux" && record["linuxCredentialFiles"] !== null)
    || record["windowsHostService"] !== (platform === "win32" ? WINDOWS_HOST_SERVICE : null)
    || record["windowsHostAddon"] !== (platform === "win32" ? WINDOWS_HOST_ADDON : null)
    || record["windowsHostNodeApiVersion"] !== (platform === "win32" ? 6 : null)
    || (platform === "win32"
      ? typeof record["windowsHostServiceSha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(record["windowsHostServiceSha256"] as string)
        || typeof record["windowsHostAddonSha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(record["windowsHostAddonSha256"] as string)
      : record["windowsHostServiceSha256"] !== null || record["windowsHostAddonSha256"] !== null)
    || (expectedCredentialHelper === null
      ? record["credentialSha256"] !== null || record["credentialBundleSha256"] !== null
      : typeof record["credentialSha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["credentialSha256"] as string)
        || typeof record["credentialBundleSha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["credentialBundleSha256"] as string))) {
    throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  }
  const helpers = [
    {
      kind: "input" as const,
      name: expectedInputHelper,
      digest: record["inputSha256"] as string
    },
    ...(expectedCaptureHelper === null ? [] : [{
      kind: "capture" as const,
      name: expectedCaptureHelper,
      digest: record["captureSha256"] as string
    }]),
    ...(expectedClipboardHelper === null ? [] : [{
      kind: "clipboard" as const, name: expectedClipboardHelper,
      digest: record["clipboardSha256"] as string
    }]),
    ...(expectedViewerScript === null ? [] : [{
      kind: "viewer-display" as const, name: expectedViewerScript, digest: record["viewerDisplaySha256"] as string
    }]),
    ...(expectedCredentialHelper === null ? [] : [{
      kind: "credentials" as const, name: expectedCredentialHelper,
      digest: record["credentialSha256"] as string
    }])
  ];
  const verified = await Promise.all(helpers.map((helper) =>
    verifyPackagedHelper(directoryPath, helper.name, helper.digest, platform, architecture)));
  if (expectedBundle !== null) {
    await verifyCredentialBundle(directoryPath, expectedBundle, record["credentialBundleSha256"] as string);
  }
  const privacy = privacyPresent ? await verifyPrivacyPlugin(directoryPath, architecture,
    record["privacySha256"] as string, record["privacyMetadataSha256"] as string) : undefined;
  const linuxCredentials = platform === "linux"
    ? await verifyLinuxCredentials(directoryPath, record["linuxCredentialFiles"]) : undefined;
  let windowsHost: { readonly service: string; readonly addon: string } | undefined;
  if (platform === "win32") {
    const entries = (await readdir(directoryPath)).sort();
    const expected = ["manifest.json", expectedInputHelper, WINDOWS_HOST_SERVICE, WINDOWS_HOST_ADDON].sort();
    if (entries.length !== expected.length || entries.some((name, index) => name !== expected[index])) {
      throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    }
    const [service, addon] = await Promise.all([
      verifyPackagedHelper(directoryPath, WINDOWS_HOST_SERVICE, record["windowsHostServiceSha256"] as string, platform, architecture),
      verifyPackagedHelper(directoryPath, WINDOWS_HOST_ADDON, record["windowsHostAddonSha256"] as string, platform, architecture)
    ]);
    windowsHost = Object.freeze({ service, addon });
  }
  return {
    helpers: new Map(helpers.map((helper, index) => [helper.kind, { name: helper.name, path: verified[index]! }])),
    privacy,
    linuxCredentials,
    windowsHost
  };
}

async function verifyLinuxCredentials(directory: string, identity: unknown): Promise<string> {
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)
    || Object.keys(identity).sort().join(",") !== [...LINUX_CREDENTIAL_NAMES].sort().join(",")) {
    throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  }
  const record = identity as Record<string, unknown>;
  const root = join(directory, "linux-credentials");
  const [metadata, canonical, entries] = await Promise.all([lstat(root), realpath(root), readdir(root)]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !canonical.startsWith(`${directory}${sep}`)
    || entries.sort().join(",") !== [...LINUX_CREDENTIAL_NAMES].sort().join(",")) {
    throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  }
  let script: string | undefined;
  for (const name of LINUX_CREDENTIAL_NAMES) {
    const digest = record[name];
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    const path = join(root, name);
    const [info, resolved, bytes] = await Promise.all([lstat(path), realpath(path), readFile(path)]);
    try {
      if (!info.isFile() || info.isSymbolicLink() || !resolved.startsWith(`${canonical}${sep}`)
        || bytes.length < 1 || bytes.length > (name === "requirements.txt" ? 4_096 : 128_000)
        || createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0") || (name === "main.py" && !text.startsWith("#!/usr/bin/python3\n"))) {
        throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
      }
      if (name === "main.py") script = resolved;
    } finally { bytes.fill(0); }
  }
  if (script === undefined) throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  return script;
}

async function verifyPrivacyPlugin(directory: string, architecture: string, digest: string,
  metadataDigest: string): Promise<DesktopRemoteDesktopPrivacyArtifact> {
  const path = await verifyPackagedHelper(directory, "joko-hyprland-privacy.so", digest, "linux", architecture);
  const metadataPath = join(directory, "joko-hyprland-privacy.json");
  const [canonical, info, bytes] = await Promise.all([realpath(metadataPath), lstat(metadataPath), readFile(metadataPath)]);
  try {
    if (!canonical.startsWith(`${directory}${sep}`) || !info.isFile() || info.isSymbolicLink()
      || bytes.length < 1 || bytes.length > 4_096 || createHash("sha256").update(bytes).digest("hex") !== metadataDigest) {
      throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    }
    const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)
      || Object.keys(metadata).sort().join(",") !== "hash,source,version") throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    const record = metadata as Record<string, unknown>;
    if (record["version"] !== "0.56.2" || typeof record["hash"] !== "string" || !/^[a-f0-9]{40}$/u.test(record["hash"])
      || typeof record["source"] !== "string" || !/^[a-f0-9]{64}$/u.test(record["source"])) {
      throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    }
    return Object.freeze({ path, metadata: Object.freeze({ version: record["version"], hash: record["hash"], source: record["source"] }) });
  } finally { bytes.fill(0); }
}

async function verifyCredentialBundle(directory: string, name: string, expected: string): Promise<void> {
  const root = join(directory, name);
  const hash = createHash("sha256");
  let count = 0;
  let size = 0;
  async function visit(path: string, relative: string): Promise<void> {
    const [metadata, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (metadata.isSymbolicLink() || !canonical.startsWith(`${directory}${sep}`)) throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    if (metadata.isDirectory()) {
      const entries = (await readdir(path)).sort();
      for (const entry of entries) {
        if (!/^[A-Za-z0-9_.-]+$/u.test(entry)) throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
        await visit(join(path, entry), relative.length === 0 ? entry : `${relative}/${entry}`);
      }
      return;
    }
    if (!metadata.isFile() || ++count > 16 || (size += metadata.size) > 1024 * 1024) throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    const bytes = await readFile(path);
    try { hash.update(relative).update("\0").update(bytes); } finally { bytes.fill(0); }
  }
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    await visit(root, "");
    if (count === 0 || hash.digest("hex") !== expected) throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  } catch { throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE"); }
}

async function verifyPackagedHelper(
  directoryPath: string,
  name: string,
  digest: string,
  platform: NodeJS.Platform,
  architecture: string
): Promise<string> {
  const binary = join(directoryPath, name);
  let binaryPath: string;
  let metadata;
  let bytes: Buffer;
  try {
    [binaryPath, metadata, bytes] = await Promise.all([
      realpath(binary),
      lstat(binary),
      readFile(binary)
    ]);
  } catch {
    throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  }
  try {
    if (!binaryPath.startsWith(`${directoryPath}${sep}`) || !metadata.isFile()
      || metadata.isSymbolicLink() || bytes.byteLength < 1
      || bytes.byteLength > MAXIMUM_HELPER_BYTES) {
      throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    }
    const actual = Buffer.from(createHash("sha256").update(bytes).digest("hex"), "utf8");
    const expected = Buffer.from(digest, "utf8");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    }
    if (name === "linux-viewer-display.py") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (bytes.length > 128_000 || !text.startsWith("#!/usr/bin/python3\n") || text.includes("\0")) {
        throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
      }
    } else if (platform === "linux" && (bytes.length < 64 || bytes[0] !== 0x7f
      || bytes.toString("ascii", 1, 4) !== "ELF" || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1
      || ![2, 3].includes(bytes.readUInt16LE(16))
      || (name === "joko-hyprland-privacy.so" && bytes.readUInt16LE(16) !== 3)
      || bytes.readUInt16LE(18) !== (architecture === "x64" ? 62 : 183)
      || bytes.readUInt32LE(20) !== 1 || bytes.readUInt16LE(52) !== 64
      || (process.platform !== "win32" && (metadata.mode & 0o111) === 0))) {
      throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    }
    if (platform === "win32") {
      const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1;
      if (offset < 0 || offset + 24 > bytes.length || bytes[0] !== 0x4d || bytes[1] !== 0x5a
        || bytes.readUInt32LE(offset) !== 0x00004550
        || bytes.readUInt16LE(offset + 4) !== (architecture === "x64" ? 0x8664 : 0xaa64)
        || Boolean(bytes.readUInt16LE(offset + 22) & 0x2000) !== (name === WINDOWS_HOST_ADDON)) {
        throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
      }
    }
    return binaryPath;
  } finally {
    bytes.fill(0);
  }
}
