import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDedicatedHardwareSdkDirectoryIntegrity,
  createDedicatedHardwareSdkManifestIntegrity,
  parseDedicatedHardwareSdkLock,
  resolveDedicatedHardwareSdkIdentity,
  reverifyDedicatedHardwareSdkIdentity,
  type DedicatedHardwareSdkLock,
  type DedicatedHardwareSdkResolverIo,
  type DedicatedHardwareSdkRuntimeTarget
} from "./dedicated-hardware-sdk.js";

const cleanups: string[] = [];
const runtimeTarget: DedicatedHardwareSdkRuntimeTarget = {
  platform: process.platform as "win32" | "darwin" | "linux",
  architecture: process.arch as "x64" | "arm64",
  electronModulesAbi: Number(process.versions.modules),
  nodeApiVersion: Number(process.versions.napi)
};

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("dedicated hardware SDK lock", () => {
  it("accepts only a canonical manifest that binds license, target, entry, native addons, and every file", async () => {
    const staged = await stageLockedSdk();
    expect(parseDedicatedHardwareSdkLock(staged.lock)).toEqual(staged.lock);
    expect(parseDedicatedHardwareSdkLock({ ...staged.lock, unexpected: true })).toBeUndefined();
    expect(parseDedicatedHardwareSdkLock({ ...staged.lock, redistributionGrantId: "" })).toBeUndefined();
    expect(parseDedicatedHardwareSdkLock({
      ...staged.lock,
      entry: { ...staged.lock.entry, relativePath: "../adapter.mjs" }
    })).toBeUndefined();
    expect(parseDedicatedHardwareSdkLock({
      ...staged.lock,
      files: [...staged.lock.files].reverse()
    })).toBeUndefined();
    expect(parseDedicatedHardwareSdkLock({
      ...staged.lock,
      target: { ...staged.lock.target, electronModulesAbi: staged.lock.target.electronModulesAbi + 1 }
    })).toBeUndefined();
  });

  it("returns a staged identity only after the complete canonical tree and exact runtime target are verified", async () => {
    const staged = await stageLockedSdk();
    await expect(resolveDedicatedHardwareSdkIdentity({
      stagingDirectory: staged.root,
      approvedArtifacts: [staged.lock],
      runtimeTarget
    })).resolves.toEqual({
      kind: "staged",
      stagingDirectory: staged.root,
      manifest: staged.lock
    });

    await expect(resolveDedicatedHardwareSdkIdentity({
      stagingDirectory: staged.root,
      approvedArtifacts: [staged.lock],
      runtimeTarget: { ...runtimeTarget, nodeApiVersion: runtimeTarget.nodeApiVersion + 1 }
    })).resolves.toEqual({ kind: "unavailable" });
  });

  it("fails closed for unapproved, tampered, extra, missing, or redirected inputs", async () => {
    const staged = await stageLockedSdk();
    await expect(resolveDedicatedHardwareSdkIdentity({
      stagingDirectory: staged.root,
      runtimeTarget
    })).resolves.toEqual({ kind: "unavailable" });

    await writeFile(resolve(staged.root, staged.lock.entry.relativePath), "tampered\n");
    await expect(resolveDedicatedHardwareSdkIdentity({
      stagingDirectory: staged.root,
      approvedArtifacts: [staged.lock],
      runtimeTarget
    })).resolves.toEqual({ kind: "unavailable" });

    const extra = await stageLockedSdk();
    await writeFile(resolve(extra.root, "unexpected.node"), "unexpected\n");
    await expect(resolveDedicatedHardwareSdkIdentity({
      stagingDirectory: extra.root,
      approvedArtifacts: [extra.lock],
      runtimeTarget
    })).resolves.toEqual({ kind: "unavailable" });

    const missing = await stageLockedSdk();
    await rm(resolve(missing.root, missing.lock.license.relativePath));
    await expect(resolveDedicatedHardwareSdkIdentity({
      stagingDirectory: missing.root,
      approvedArtifacts: [missing.lock],
      runtimeTarget
    })).resolves.toEqual({ kind: "unavailable" });

    const redirected = await stageLockedSdk();
    const redirectedEntry = resolve(redirected.root, redirected.lock.entry.relativePath);
    const io: DedicatedHardwareSdkResolverIo = {
      readFile,
      readDirectory: (path) => readdir(path),
      realpath: async (path) => path === redirectedEntry ? `${path}.redirected` : realpath(path),
      lstat
    };
    await expect(resolveDedicatedHardwareSdkIdentity({
      stagingDirectory: redirected.root,
      approvedArtifacts: [redirected.lock],
      runtimeTarget,
      io
    })).resolves.toEqual({ kind: "unavailable" });
  });

  it("reverifies the handed manifest and current bytes before utility import", async () => {
    const staged = await stageLockedSdk();
    const identity = await resolveDedicatedHardwareSdkIdentity({
      stagingDirectory: staged.root,
      approvedArtifacts: [staged.lock],
      runtimeTarget
    });
    if (identity.kind !== "staged") throw new Error("Expected staged SDK identity.");
    await expect(reverifyDedicatedHardwareSdkIdentity(identity, { runtimeTarget })).resolves.toEqual(identity);

    await writeFile(resolve(staged.root, staged.lock.nativeAddons[0]!.relativePath), "replaced native bytes\n");
    await expect(reverifyDedicatedHardwareSdkIdentity(identity, { runtimeTarget })).resolves.toBeUndefined();
  });
});

async function stageLockedSdk(): Promise<Readonly<{ root: string; lock: DedicatedHardwareSdkLock }>> {
  const parent = await mkdtemp(join(tmpdir(), "joko-sdk-runtime-"));
  cleanups.push(parent);
  const root = resolve(parent, "dedicated-hardware-sdk");
  await mkdir(resolve(root, "native"), { recursive: true });
  const payloads = [
    { relativePath: "LICENSE.vendor.txt", bytes: new TextEncoder().encode("licensed fixture\n") },
    { relativePath: "adapter.mjs", bytes: new TextEncoder().encode("export const adapter = true;\n") },
    { relativePath: "native/device.node", bytes: new TextEncoder().encode("native fixture bytes\n") }
  ].sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  for (const payload of payloads) await writeFile(resolve(root, ...payload.relativePath.split("/")), payload.bytes);
  const files = payloads.map((payload) => ({
    relativePath: payload.relativePath,
    size: payload.bytes.byteLength,
    integrity: integrity(payload.bytes)
  }));
  const directoryIntegrity = createDedicatedHardwareSdkDirectoryIntegrity(payloads.map((payload, index) => ({
    ...files[index]!, bytes: payload.bytes
  })));
  const file = (relativePath: string) => files.find((candidate) => candidate.relativePath === relativePath)!;
  const withoutManifestIntegrity = {
    version: 1 as const,
    packageName: "@worklouder/device-kit-oai" as const,
    packageVersion: "0.2.1",
    redistributionGrantId: "legal-review-2026-001",
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
    directoryIntegrity
  };
  const lock: DedicatedHardwareSdkLock = Object.freeze({
    ...withoutManifestIntegrity,
    manifestIntegrity: createDedicatedHardwareSdkManifestIntegrity(withoutManifestIntegrity)
  });
  await writeFile(resolve(root, "joko-dedicated-hardware-sdk.lock.json"), JSON.stringify(lock));
  return Object.freeze({ root, lock });
}

function integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
