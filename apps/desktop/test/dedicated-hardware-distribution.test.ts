/// <reference types="node" />

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDedicatedHardwareSdkDirectoryIntegrity as createRuntimeDirectoryIntegrity,
  createDedicatedHardwareSdkManifestIntegrity as createRuntimeManifestIntegrity,
  parseDedicatedHardwareSdkLock
} from "../src/dedicated-hardware-sdk.js";
import { mkdtempSync } from "./test-paths.js";

interface DedicatedHardwareSdkLock {
  readonly version: 1;
  readonly packageName: "@worklouder/device-kit-oai";
  readonly packageVersion: string;
  readonly redistributionGrantId: string;
  readonly license: Readonly<{ readonly relativePath: string; readonly integrity: string }>;
  readonly target: DedicatedHardwareSdkRuntimeTarget;
  readonly entry: Readonly<{ readonly relativePath: string; readonly integrity: string }>;
  readonly nativeAddons: readonly Readonly<{
    readonly identity: string;
    readonly relativePath: string;
    readonly integrity: string;
    readonly abi: "electron-modules" | "node-api";
  }>[];
  readonly files: readonly Readonly<{ readonly relativePath: string; readonly size: number; readonly integrity: string }>[];
  readonly directoryIntegrity: string;
  readonly manifestIntegrity: string;
}

interface DedicatedHardwareSdkRuntimeTarget {
  readonly platform: "win32" | "darwin" | "linux";
  readonly architecture: "x64" | "arm64";
  readonly electronModulesAbi: number;
  readonly nodeApiVersion: number;
}

type AuditDedicatedHardwareSdkDirectory = (
  root: string,
  approvedArtifacts?: readonly DedicatedHardwareSdkLock[],
  runtimeTarget?: DedicatedHardwareSdkRuntimeTarget
) => Promise<
  | Readonly<{ status: "unavailable" }>
  | Readonly<{
    status: "locked";
    packageVersion: string;
    manifestIntegrity: string;
    directoryIntegrity: string;
    redistributionGrantId: string;
  }>
>;

const require = createRequire(import.meta.url);
const packagedAudit = require("../scripts/audit-packaged.cjs") as {
  readonly auditNativeGamepad: (root: string, platform: "win32" | "darwin" | "linux", targetArch: string) => Promise<void>;
  readonly auditNativeHardware: (root: string, platform: "win32" | "darwin" | "linux", targetArch: string) => Promise<void>;
  readonly auditNativeSystemFrontmostInput: (root: string, platform: "win32" | "darwin" | "linux", targetArch: string) => Promise<void>;
  readonly auditDedicatedHardwareSdkDirectory: AuditDedicatedHardwareSdkDirectory;
  readonly createDedicatedHardwareSdkDirectoryIntegrity: (entries: readonly Readonly<{
    relativePath: string; size: number; integrity: string; bytes: Uint8Array;
  }>[]) => string;
  readonly createDedicatedHardwareSdkManifestIntegrity: (value: Omit<DedicatedHardwareSdkLock, "manifestIntegrity">) => string;
  readonly dedicatedHardwareSdkHandshakeBytes: (
    sdk: unknown,
    keymapBackupDirectory?: string
  ) => number;
  readonly assertDedicatedHardwareSdkHandshakeBudget: (sdk: unknown) => number;
};
const auditDedicatedHardwareSdkDirectory = packagedAudit.auditDedicatedHardwareSdkDirectory;
const cleanups: string[] = [];
const runtimeTarget: DedicatedHardwareSdkRuntimeTarget = {
  platform: process.platform as DedicatedHardwareSdkRuntimeTarget["platform"],
  architecture: process.arch as DedicatedHardwareSdkRuntimeTarget["architecture"],
  electronModulesAbi: Number(process.versions.modules),
  nodeApiVersion: Number(process.versions.napi)
};

afterEach(() => {
  for (const path of cleanups.splice(0).reverse()) rmSync(path, { recursive: true, force: true });
});

describe("packaged native USB hardware audit", () => {
  it("requires the target binary and integrity in the packaged resource", async () => {
    const root = temporaryDirectory();
    const bytes = Buffer.alloc(128);
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(64, 0x3c);
    bytes.writeUInt32LE(0x4550, 64);
    bytes.writeUInt16LE(0x8664, 68);
    const helper = "joko-windows-micro-helper.exe";
    writeFileSync(join(root, helper), bytes);
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ protocolVersion: 1,
      platform: "win32", architecture: "x64", helper, sha256: createHash("sha256").update(bytes).digest("hex") }));
    await expect(packagedAudit.auditNativeHardware(root, "win32", "x64")).resolves.toBeUndefined();
    await expect(packagedAudit.auditNativeHardware(root, "win32", "arm64")).rejects.toThrow("artifact target");
    bytes[100] = 1;
    writeFileSync(join(root, helper), bytes);
    await expect(packagedAudit.auditNativeHardware(root, "win32", "x64")).rejects.toThrow("does not match its identity");
  });
});

describe("packaged native gamepad audit", () => {
  it("builds a strict non-macOS manifest for an explicit package target", async () => {
    // The production build module is JavaScript because electron-builder imports it from afterPack.
    // @ts-expect-error The build script intentionally has no public TypeScript declaration surface.
    const nativeBuild = await import("../scripts/build-native-gamepad.mjs") as {
      readonly buildNativeGamepad: (options: {
        platform: string;
        architecture: string;
        output: string;
      }) => void;
      readonly nativeGamepadCompilerTarget: (architecture: string) => Readonly<{
        compilerArchitecture: string;
        triple: string;
      }>;
    };
    const root = temporaryDirectory();
    nativeBuild.buildNativeGamepad({ platform: "linux", architecture: "arm64", output: root });
    expect(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))).toEqual({
      protocolVersion: 1,
      platform: "linux",
      architecture: "arm64",
      helper: null,
      sha256: null
    });
    expect(nativeBuild.nativeGamepadCompilerTarget("x64")).toEqual({
      compilerArchitecture: "x86_64",
      triple: "x86_64-apple-macos11.0"
    });
    expect(nativeBuild.nativeGamepadCompilerTarget("arm64")).toEqual({
      compilerArchitecture: "arm64",
      triple: "arm64-apple-macos11.0"
    });
    await expect(packagedAudit.auditNativeGamepad(root, "linux", "arm64")).resolves.toBeUndefined();
  });

  it.each(["x64", "arm64"] as const)("requires a strict %s Mach-O identity and digest", async (architecture) => {
    const root = temporaryDirectory();
    const helper = "joko-macos-gamepad-helper";
    const bytes = Buffer.alloc(64);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
    writeFileSync(join(root, helper), bytes, { mode: 0o755 });
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      protocolVersion: 1,
      platform: "darwin",
      architecture,
      helper,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }));

    await expect(packagedAudit.auditNativeGamepad(root, "darwin", architecture)).resolves.toBeUndefined();
    await expect(packagedAudit.auditNativeGamepad(root, "darwin", architecture === "x64" ? "arm64" : "x64"))
      .rejects.toThrow("does not match the artifact target");
    bytes[32] = 1;
    writeFileSync(join(root, helper), bytes, { mode: 0o755 });
    await expect(packagedAudit.auditNativeGamepad(root, "darwin", architecture))
      .rejects.toThrow("does not match its identity");

    bytes[32] = 0;
    bytes.writeUInt32LE(architecture === "arm64" ? 0x01000007 : 0x0100000c, 4);
    writeFileSync(join(root, helper), bytes, { mode: 0o755 });
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      protocolVersion: 1,
      platform: "darwin",
      architecture,
      helper,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }));
    await expect(packagedAudit.auditNativeGamepad(root, "darwin", architecture))
      .rejects.toThrow("does not match its identity");
  });

  it.each(["win32", "linux"] as const)("admits only a null %s manifest", async (platform) => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      protocolVersion: 1,
      platform,
      architecture: "x64",
      helper: null,
      sha256: null
    }));
    await expect(packagedAudit.auditNativeGamepad(root, platform, "x64")).resolves.toBeUndefined();
    writeFileSync(join(root, "unexpected-helper"), "not admitted\n");
    await expect(packagedAudit.auditNativeGamepad(root, platform, "x64"))
      .rejects.toThrow("incomplete or contains unexpected files");
  });
});

describe("packaged native foreground input audit", () => {
  it.each([
    { platform: "darwin", architecture: "x64", helper: "joko-macos-frontmost-input.node" },
    { platform: "darwin", architecture: "arm64", helper: "joko-macos-frontmost-input.node" },
    { platform: "linux", architecture: "x64", helper: "joko-linux-frontmost-input.node" },
    { platform: "linux", architecture: "arm64", helper: "joko-linux-frontmost-input.node" }
  ] as const)("admits a strictly identified $platform $architecture resource without claiming native compilation", async ({ architecture, platform, helper }) => {
    const root = temporaryDirectory();
    const bytes = Buffer.from("controlled native resource identity bytes\n");
    writeFileSync(resolve(root, helper), bytes);
    writeFileSync(resolve(root, "manifest.json"), JSON.stringify({
      architecture, helper, platform, protocolVersion: 1,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }));
    await expect(packagedAudit.auditNativeSystemFrontmostInput(root, platform, architecture)).resolves.toBeUndefined();
    const config = JSON.parse(readFileSync(new URL("../electron-builder.json", import.meta.url), "utf8")) as {
      extraResources: Array<{ from: string; to: string; filter: string[] }>;
    };
    expect(config.extraResources.find((entry) => entry.to === "native-system-frontmost-input"))
      .toMatchObject({ from: "dist/native-system-frontmost-input", filter: expect.arrayContaining(["manifest.json", helper]) });

    await expect(packagedAudit.auditNativeSystemFrontmostInput(root, platform, architecture === "x64" ? "arm64" : "x64"))
      .rejects.toThrow("does not match the artifact target");
    await expect(packagedAudit.auditNativeSystemFrontmostInput(root, "win32", architecture))
      .rejects.toThrow("incomplete or contains unexpected files");
    writeFileSync(resolve(root, helper), "changed native resource bytes\n");
    await expect(packagedAudit.auditNativeSystemFrontmostInput(root, platform, architecture))
      .rejects.toThrow("failed integrity verification");
    writeFileSync(resolve(root, helper), bytes);
    writeFileSync(resolve(root, "joko-windows-frontmost-input.node"), "leftover generated helper\n");
    await expect(packagedAudit.auditNativeSystemFrontmostInput(root, platform, architecture))
      .rejects.toThrow("incomplete or contains unexpected files");
  });
});

describe("packaged dedicated hardware SDK audit", () => {
  it("uses the same canonical manifest and directory identity as the runtime resolver", () => {
    const staged = stageLockedSdk();
    const { manifestIntegrity: _manifestIntegrity, ...withoutManifestIntegrity } = staged.lock;
    const directoryEntries = staged.lock.files.map((file) => ({
      ...file,
      bytes: readFileSync(resolve(staged.root, ...file.relativePath.split("/")))
    }));
    expect(parseDedicatedHardwareSdkLock(staged.lock)).toEqual(staged.lock);
    expect(createRuntimeManifestIntegrity(withoutManifestIntegrity)).toBe(staged.lock.manifestIntegrity);
    expect(createRuntimeDirectoryIntegrity(directoryEntries)).toBe(staged.lock.directoryIntegrity);
  });

  it("budgets the complete handshake including a worst-case UTF-8 keymap backup path", () => {
    const staged = stageLockedSdk();
    const sdk = { kind: "staged", stagingDirectory: staged.root, manifest: staged.lock };
    const shortHandshake = packagedAudit.dedicatedHardwareSdkHandshakeBytes(sdk, "/k");
    const reservedHandshake = packagedAudit.dedicatedHardwareSdkHandshakeBytes(sdk);
    expect(reservedHandshake - shortHandshake).toBe((3 * 4_095 + 1) - 2);

    const empty = { kind: "staged", stagingDirectory: staged.root, manifest: { padding: "" } };
    const fixedBytes = packagedAudit.dedicatedHardwareSdkHandshakeBytes(empty);
    const exactBoundary = {
      ...empty,
      manifest: { padding: "x".repeat(72 * 1024 - fixedBytes) }
    };
    expect(packagedAudit.assertDedicatedHardwareSdkHandshakeBudget(exactBoundary)).toBe(72 * 1024);
    expect(() => packagedAudit.assertDedicatedHardwareSdkHandshakeBudget({
      ...exactBoundary,
      manifest: { padding: `${exactBoundary.manifest.padding}x` }
    })).toThrow("exceeds the utility handshake boundary");
  });

  it("treats the missing fixed resources directory as unavailable without discovering sibling inputs", async () => {
    const root = temporaryDirectory();
    const privateSibling = resolve(root, "installed-application-private-sdk");
    mkdirSync(privateSibling);
    writeFileSync(resolve(privateSibling, "adapter.mjs"), "private candidate must not be discovered\n");

    await expect(auditDedicatedHardwareSdkDirectory(
      resolve(root, "dedicated-hardware-sdk")
    )).resolves.toEqual({ status: "unavailable" });
  });

  it("rejects a self-asserted grant unless the exact complete artifact is independently allowlisted", async () => {
    const staged = stageLockedSdk();
    await expect(auditDedicatedHardwareSdkDirectory(staged.root, [], runtimeTarget))
      .rejects.toThrow("No exact dedicated hardware SDK artifact is approved for redistribution");
    await expect(auditDedicatedHardwareSdkDirectory(staged.root, [staged.lock], runtimeTarget)).resolves.toEqual({
      status: "locked",
      packageVersion: staged.lock.packageVersion,
      manifestIntegrity: staged.lock.manifestIntegrity,
      directoryIntegrity: staged.lock.directoryIntegrity,
      redistributionGrantId: staged.lock.redistributionGrantId
    });
  });

  it("rejects content drift, extra or missing files, and non-v1 lock keys", async () => {
    const staged = stageLockedSdk();
    writeFileSync(resolve(staged.root, "unexpected.node"), "not admitted\n");
    await expect(auditDedicatedHardwareSdkDirectory(staged.root, [staged.lock], runtimeTarget))
      .rejects.toThrow("contains unexpected files");

    rmSync(resolve(staged.root, "unexpected.node"));
    writeFileSync(resolve(staged.root, staged.lock.entry.relativePath), "tampered\n");
    await expect(auditDedicatedHardwareSdkDirectory(staged.root, [staged.lock], runtimeTarget))
      .rejects.toThrow("file failed integrity verification");

    const missing = stageLockedSdk();
    rmSync(resolve(missing.root, missing.lock.license.relativePath));
    await expect(auditDedicatedHardwareSdkDirectory(missing.root, [missing.lock], runtimeTarget))
      .rejects.toThrow("contains unexpected files");

    const extraKey = stageLockedSdk({ extra: true });
    await expect(auditDedicatedHardwareSdkDirectory(extraKey.root, [extraKey.lock], runtimeTarget))
      .rejects.toThrow("does not match the strict v1 shape");
  });

  it("rejects redirected tree entries and target, Electron ABI, or Node-API drift", async () => {
    const redirected = stageLockedSdk();
    const nativeDirectory = resolve(redirected.root, "native");
    const realNativeDirectory = resolve(redirected.parent, "native-real");
    renameSync(nativeDirectory, realNativeDirectory);
    symlinkSync(realNativeDirectory, nativeDirectory, "junction");
    await expect(auditDedicatedHardwareSdkDirectory(redirected.root, [redirected.lock], runtimeTarget))
      .rejects.toThrow("redirected entry");

    const staged = stageLockedSdk();
    await expect(auditDedicatedHardwareSdkDirectory(staged.root, [staged.lock], {
      ...runtimeTarget,
      electronModulesAbi: runtimeTarget.electronModulesAbi + 1
    })).rejects.toThrow("target or ABI does not match");
    await expect(auditDedicatedHardwareSdkDirectory(staged.root, [staged.lock], {
      ...runtimeTarget,
      nodeApiVersion: runtimeTarget.nodeApiVersion + 1
    })).rejects.toThrow("target or ABI does not match");
  });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "joko-hardware-sdk-audit-"));
  cleanups.push(path);
  return path;
}

function stageLockedSdk(lockExtension: Record<string, unknown> = {}): {
  readonly parent: string;
  readonly root: string;
  readonly lock: DedicatedHardwareSdkLock;
} {
  const parent = temporaryDirectory();
  const root = resolve(parent, "dedicated-hardware-sdk");
  mkdirSync(resolve(root, "native"), { recursive: true });
  const payloads = [
    { relativePath: "LICENSE.vendor.txt", bytes: Buffer.from("licensed fixture\n", "utf8") },
    { relativePath: "adapter.mjs", bytes: Buffer.from("export const adapterGeneration = 1;\n", "utf8") },
    { relativePath: "native/device.node", bytes: Buffer.from("native fixture bytes\n", "utf8") }
  ].sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  for (const payload of payloads) {
    writeFileSync(resolve(root, ...payload.relativePath.split("/")), payload.bytes);
  }
  const files = payloads.map((payload) => ({
    relativePath: payload.relativePath,
    size: payload.bytes.byteLength,
    integrity: integrity(payload.bytes)
  }));
  const file = (relativePath: string) => files.find((candidate) => candidate.relativePath === relativePath)!;
  const withoutManifestIntegrity = {
    version: 1 as const,
    packageName: "@worklouder/device-kit-oai" as const,
    packageVersion: "0.2.1",
    redistributionGrantId: "distribution-review-2026-001",
    license: { relativePath: "LICENSE.vendor.txt", integrity: file("LICENSE.vendor.txt").integrity },
    target: runtimeTarget,
    entry: { relativePath: "adapter.mjs", integrity: file("adapter.mjs").integrity },
    nativeAddons: [{
      identity: "@vendor/device-native@0.2.1",
      relativePath: "native/device.node",
      integrity: file("native/device.node").integrity,
      abi: "electron-modules" as const
    }],
    files,
    directoryIntegrity: packagedAudit.createDedicatedHardwareSdkDirectoryIntegrity(
      payloads.map((payload, index) => ({ ...files[index]!, bytes: payload.bytes }))
    )
  };
  const lock: DedicatedHardwareSdkLock = Object.freeze({
    ...withoutManifestIntegrity,
    manifestIntegrity: packagedAudit.createDedicatedHardwareSdkManifestIntegrity(withoutManifestIntegrity)
  });
  writeFileSync(resolve(root, "joko-dedicated-hardware-sdk.lock.json"), JSON.stringify({
    ...lock,
    ...lockExtension
  }));
  return { parent, root, lock };
}

function integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
