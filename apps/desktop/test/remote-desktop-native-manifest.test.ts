import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { verifyPackagedDesktopRemoteDesktopBinary } from
  "../src/remote-desktop-native-manifest.js";

const roots: string[] = [];

describe("packaged Remote Desktop native manifest", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("accepts the exact Windows input-only v1 shape", async () => {
    const root = await directory();
    const helper = "joko-windows-remote-desktop-input.exe";
    const bytes = Buffer.from("bounded helper");
    await writeFile(join(root, helper), bytes);
    await manifest(root, {
      protocolVersion: 1,
      platform: "win32",
      architecture: "x64",
      inputHelper: helper,
      inputSha256: sha256(bytes),
      captureHelper: null,
      captureSha256: null
    });

    await expect(verifyPackagedDesktopRemoteDesktopBinary(
      root, "input", helper, "win32", "x64"
    )).resolves.toBe(await realpath(join(root, helper)));
  });

  it("rejects a malformed unused capture identity when resolving Windows input", async () => {
    const root = await directory();
    const helper = "joko-windows-remote-desktop-input.exe";
    const bytes = Buffer.from("bounded helper");
    await writeFile(join(root, helper), bytes);
    await manifest(root, {
      protocolVersion: 1,
      platform: "win32",
      architecture: "x64",
      inputHelper: helper,
      inputSha256: sha256(bytes),
      captureHelper: "unexpected-capture",
      captureSha256: "0".repeat(64)
    });

    await expect(verifyPackagedDesktopRemoteDesktopBinary(
      root, "input", helper, "win32", "x64"
    )).rejects.toThrowError("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  });

  it("accepts the exact macOS helper pair while resolving either helper", async () => {
    const root = await directory();
    const input = "joko-macos-remote-desktop-input";
    const capture = "joko-macos-remote-desktop-capture";
    const inputBytes = Buffer.from("bounded input helper");
    const captureBytes = Buffer.from("bounded capture helper");
    await Promise.all([
      writeFile(join(root, input), inputBytes),
      writeFile(join(root, capture), captureBytes)
    ]);
    await manifest(root, {
      protocolVersion: 1,
      platform: "darwin",
      architecture: "arm64",
      inputHelper: input,
      inputSha256: sha256(inputBytes),
      captureHelper: capture,
      captureSha256: sha256(captureBytes)
    });

    await expect(Promise.all([
      verifyPackagedDesktopRemoteDesktopBinary(root, "input", input, "darwin", "arm64"),
      verifyPackagedDesktopRemoteDesktopBinary(root, "capture", capture, "darwin", "arm64")
    ])).resolves.toEqual([
      await realpath(join(root, input)),
      await realpath(join(root, capture))
    ]);
  });

  it("rejects a tampered unrequested macOS capture helper while resolving input", async () => {
    const root = await directory();
    const input = "joko-macos-remote-desktop-input";
    const capture = "joko-macos-remote-desktop-capture";
    const inputBytes = Buffer.from("bounded input helper");
    const captureBytes = Buffer.from("bounded capture helper");
    await Promise.all([
      writeFile(join(root, input), inputBytes),
      writeFile(join(root, capture), captureBytes)
    ]);
    await manifest(root, {
      protocolVersion: 1,
      platform: "darwin",
      architecture: "arm64",
      inputHelper: input,
      inputSha256: sha256(inputBytes),
      captureHelper: capture,
      captureSha256: sha256(Buffer.from("expected capture helper"))
    });

    await expect(verifyPackagedDesktopRemoteDesktopBinary(
      root, "input", input, "darwin", "arm64"
    )).rejects.toThrowError("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  });
});

async function directory(): Promise<string> {
  const root = join(tmpdir(), `joko-remote-desktop-manifest-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

async function manifest(root: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(value)}\n`, "utf8");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
