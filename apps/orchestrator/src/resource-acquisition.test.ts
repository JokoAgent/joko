import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizePiPackageSource,
  piPackageSourceIdentity,
  prepareSelfContainedNpmPayload
} from "./resource-acquisition.js";
import {
  BUNDLED_NPM_RUNTIME_VERSION,
  nodeExecutableEnvironment,
  resolveBundledNpmRuntime
} from "./npm-runtime.js";

describe("Pi package acquisition source", () => {
  it("normalizes portable subdirectories and rejects POSIX- and Windows-style traversal", () => {
    expect(normalizePiPackageSource({
      kind: "git",
      repositoryUrl: "https://example.test/org/repository.git",
      subdirectory: "packages\\agent"
    })).toMatchObject({ subdirectory: "packages/agent" });

    for (const subdirectory of ["../escape", "..\\escape", "nested/../../escape", "nested\\..\\..\\escape"]) {
      expect(() => normalizePiPackageSource({
        kind: "git",
        repositoryUrl: "https://example.test/org/repository.git",
        subdirectory
      })).toThrow(/subdirectory|escapes/u);
    }
  });

  it("uses version/ref-independent identities and rejects embedded credentials", () => {
    expect(piPackageSourceIdentity({ kind: "npm", packageName: "@Scope/Package", versionSpec: "1.0.0" }))
      .toBe(piPackageSourceIdentity({ kind: "npm", packageName: "@scope/package", versionSpec: "2.0.0" }));
    expect(piPackageSourceIdentity({ kind: "git", repositoryUrl: "https://Example.test/Org/Repo.git", ref: "v1" }))
      .toBe(piPackageSourceIdentity({ kind: "git", repositoryUrl: "https://example.test/org/repo", ref: "v2" }));
    expect(() => normalizePiPackageSource({
      kind: "git",
      repositoryUrl: "https://token@example.test/org/repo.git"
    })).toThrow(/credentials/u);
    expect(() => normalizePiPackageSource({
      kind: "git",
      repositoryUrl: "https://example.test/org/repo.git?token=secret"
    })).toThrow(/query|credentials/u);
    expect(() => normalizePiPackageSource({
      kind: "git",
      repositoryUrl: "https://example.test/org/repo.git",
      ref: "--upload-pack=credential-stealer"
    })).toThrow(/ref/u);
  });

  it("accepts only a dependency closure nested inside the copied npm payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-npm-closure-"));
    const packageRoot = join(root, "package");
    const dependencyRoot = join(packageRoot, "node_modules", "runtime-dependency");
    await mkdir(dependencyRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ dependencies: { "runtime-dependency": "1.0.0" } }), "utf8");
    await writeFile(join(dependencyRoot, "package.json"), "{}", "utf8");
    await expect(prepareSelfContainedNpmPayload(packageRoot)).resolves.toBeUndefined();

    await rm(dependencyRoot, { recursive: true, force: true });
    const hoisted = join(root, "node_modules", "runtime-dependency");
    await mkdir(hoisted, { recursive: true });
    await writeFile(join(hoisted, "package.json"), "{}", "utf8");
    await expect(prepareSelfContainedNpmPayload(packageRoot)).rejects.toThrow(/self-contained/u);
    await rm(root, { recursive: true, force: true });
  });

  it("resolves and executes the bundled npm runtime without relying on a system npm", async () => {
    const runtime = await resolveBundledNpmRuntime();
    expect(runtime.version).toBe(BUNDLED_NPM_RUNTIME_VERSION);
    expect(runtime.cliPath).toMatch(/[\\/]npm[\\/]bin[\\/]npm-cli\.js$/u);

    const result = spawnSync(process.execPath, [runtime.cliPath, "--version"], {
      encoding: "utf8",
      env: nodeExecutableEnvironment({})
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(runtime.version);
  });

  it("keeps Electron in Node mode only for Electron-backed executable launches", () => {
    expect(nodeExecutableEnvironment({ HOME: "isolated", ELECTRON_RUN_AS_NODE: "unsafe" }, undefined))
      .toEqual({ HOME: "isolated" });
    expect(nodeExecutableEnvironment({ HOME: "isolated", ELECTRON_RUN_AS_NODE: "unsafe" }, "39.2.7"))
      .toEqual({ HOME: "isolated", ELECTRON_RUN_AS_NODE: "1" });
  });
});
