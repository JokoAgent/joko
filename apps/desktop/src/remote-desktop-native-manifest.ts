import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

const MAXIMUM_HELPER_BYTES = 16 * 1024 * 1024;

export type DesktopRemoteDesktopNativeHelperKind = "input" | "capture";

/** Resolve one exact helper from the strict current-v1 packaged manifest. */
export async function verifyPackagedDesktopRemoteDesktopBinary(
  directory: string,
  kind: DesktopRemoteDesktopNativeHelperKind,
  expectedName: string,
  platform: NodeJS.Platform,
  architecture: string
): Promise<string> {
  const manifestPath = join(directory, "manifest.json");
  const [directoryPath, manifestMetadata, manifestBytes] = await Promise.all([
    realpath(directory),
    lstat(manifestPath),
    readFile(manifestPath)
  ]);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()
    || manifestBytes.byteLength < 1 || manifestBytes.byteLength > 4_096) {
    throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  }
  let manifest: unknown;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
  finally { manifestBytes.fill(0); }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)
    || Object.keys(manifest).sort().join(",") !== [
      "architecture", "captureHelper", "captureSha256", "inputHelper", "inputSha256",
      "platform", "protocolVersion"
    ].sort().join(",")) {
    throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  }
  const record = manifest as Record<string, unknown>;
  const expectedInputHelper = platform === "darwin"
    ? "joko-macos-remote-desktop-input"
    : platform === "win32"
      ? "joko-windows-remote-desktop-input.exe"
      : null;
  const expectedCaptureHelper = platform === "darwin"
    ? "joko-macos-remote-desktop-capture"
    : null;
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
        || !/^[0-9a-f]{64}$/u.test(record["captureSha256"] as string))) {
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
    }])
  ];
  const requested = helpers.find((helper) => helper.kind === kind);
  if (requested === undefined || requested.name !== expectedName) {
    throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  }
  const verified = await Promise.all(helpers.map((helper) =>
    verifyPackagedHelper(directoryPath, helper.name, helper.digest)));
  const requestedIndex = helpers.indexOf(requested);
  const binaryPath = verified[requestedIndex];
  if (binaryPath === undefined) throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  return binaryPath;
}

async function verifyPackagedHelper(
  directoryPath: string,
  name: string,
  digest: string
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
    return binaryPath;
  } finally {
    bytes.fill(0);
  }
}
