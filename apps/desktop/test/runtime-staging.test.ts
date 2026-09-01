import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertContained,
  auditRegularRuntimeTree,
  copyRegularTree,
  replaceDirectoryFromPrepared,
  rewriteRuntimePackageManifest,
  ORCHESTRATOR_BUNDLED_NPM_RUNTIME,
  ORCHESTRATOR_RUNTIME_CRITICAL_IMPORTS,
  ORCHESTRATOR_RUNTIME_PACKAGES,
  runtimeBuildEnvironment,
  runtimeExecutablePath,
  sqliteVecElectronBuilderArchitecture,
  sqliteVecElectronSmokeSource,
  sqliteVecRuntimeTarget
} from "../src/runtime-staging.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0).reverse()) rmSync(path, { recursive: true, force: true });
});

describe("isolated Orchestrator runtime staging", () => {
  it("stages every direct Orchestrator workspace runtime dependency and probes its external loader", () => {
    const orchestratorManifest = JSON.parse(readFileSync(
      new URL("../../orchestrator/package.json", import.meta.url),
      "utf8"
    )) as { readonly dependencies?: Readonly<Record<string, string>> };
    expect(orchestratorManifest.dependencies?.[ORCHESTRATOR_BUNDLED_NPM_RUNTIME.name])
      .toBe(ORCHESTRATOR_BUNDLED_NPM_RUNTIME.version);
    const directWorkspaceDependencies = Object.keys(orchestratorManifest.dependencies ?? {})
      .filter((name) => name.startsWith("@joko/"))
      .sort();
    const stagedWorkspacePackages = ORCHESTRATOR_RUNTIME_PACKAGES.map(({ name }) => name)
      .filter((name) => name !== "@joko/orchestrator")
      .sort();

    expect(stagedWorkspacePackages).toEqual(directWorkspaceDependencies);
    expect(ORCHESTRATOR_RUNTIME_CRITICAL_IMPORTS).toEqual(expect.arrayContaining([
      ...directWorkspaceDependencies,
      "@joko/contracts/managed-outbound-proxy",
      "extract-zip",
      "sharp",
      "undici"
    ]));
  });

  it("maps every published sqlite-vec Desktop target and fails closed for unsupported Windows arm64", () => {
    expect(sqliteVecElectronBuilderArchitecture(1)).toBe("x64");
    expect(sqliteVecElectronBuilderArchitecture(3)).toBe("arm64");
    expect(sqliteVecElectronBuilderArchitecture("x64")).toBe("x64");
    expect(sqliteVecElectronBuilderArchitecture("arm64")).toBe("arm64");
    expect(() => sqliteVecElectronBuilderArchitecture(4)).toThrow(/electron-builder target architecture/iu);
    expect(sqliteVecRuntimeTarget("win32", "x64")).toEqual({
      platform: "win32",
      arch: "x64",
      packageName: "sqlite-vec-windows-x64",
      binaryName: "vec0.dll",
      packageRelativePath: join("node_modules", "sqlite-vec-windows-x64"),
      binaryRelativePath: join("node_modules", "sqlite-vec-windows-x64", "vec0.dll")
    });
    expect(() => sqliteVecRuntimeTarget("win32", "arm64")).toThrow(/does not publish a Windows arm64/iu);
    expect(sqliteVecRuntimeTarget("darwin", "x64")).toMatchObject({
      packageName: "sqlite-vec-darwin-x64",
      binaryName: "vec0.dylib"
    });
    expect(sqliteVecRuntimeTarget("darwin", "arm64")).toMatchObject({
      packageName: "sqlite-vec-darwin-arm64",
      binaryName: "vec0.dylib"
    });
    expect(sqliteVecRuntimeTarget("linux", "x64")).toMatchObject({
      packageName: "sqlite-vec-linux-x64",
      binaryName: "vec0.so"
    });
    expect(sqliteVecRuntimeTarget("linux", "arm64")).toMatchObject({
      packageName: "sqlite-vec-linux-arm64",
      binaryName: "vec0.so"
    });
    expect(() => sqliteVecRuntimeTarget("freebsd", "x64")).toThrow(/target platform/iu);
    expect(() => sqliteVecRuntimeTarget("linux", "ia32")).toThrow(/target architecture/iu);
  });

  it("loads and exercises the current sqlite-vec binary under Electron-Node", async () => {
    const fixture = await sqliteVecRuntimeFixture("sqlite-vec-electron");
    const result = runSqliteVecProbe(fixture);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      runtimeRoot: realpathSync(fixture.runtimeRoot),
      version: "v0.1.9",
      electronVersion: "39.2.7"
    });
  });

  it("fails closed when the target sqlite-vec binary is missing or ABI-invalid", async () => {
    const missing = await sqliteVecRuntimeFixture("sqlite-vec-missing");
    rmSync(missing.nativeBinary, { force: false });
    const missingResult = runSqliteVecProbe(missing);
    expect(missingResult.status).not.toBe(0);
    expect(missingResult.stderr).toMatch(/sqlite-vec|vec0|ENOENT/iu);

    const invalid = await sqliteVecRuntimeFixture("sqlite-vec-invalid");
    writeFileSync(invalid.nativeBinary, "not-a-loadable-sqlite-extension\n");
    const invalidResult = runSqliteVecProbe(invalid);
    expect(invalidResult.status).not.toBe(0);
    expect(invalidResult.stderr).toMatch(/extension|sqlite|vec0/iu);
  });

  it("rewrites only candidate @joko exports from source TypeScript to built JavaScript", () => {
    expect(rewriteRuntimePackageManifest({
      name: "@joko/core",
      type: "module",
      exports: {
        ".": "./src/index.ts",
        "./policy": { types: "./dist/policy.d.ts", import: "./src/policy.ts" }
      },
      optionalDependencies: { optional: "1.0.0" }
    }, "@joko/core")).toEqual({
      name: "@joko/core",
      type: "module",
      exports: {
        ".": "./dist/index.js",
        "./policy": { types: "./dist/policy.d.ts", import: "./dist/policy.js" }
      },
      optionalDependencies: { optional: "1.0.0" }
    });
    expect(() => rewriteRuntimePackageManifest({ name: "external" }, "@joko/core"))
      .toThrow(/unexpected runtime workspace package/iu);
  });

  it("passes only OS launch necessities and never inherited Node/npm/provider secrets", () => {
    const environment = runtimeBuildEnvironment({
      PATH: "bin",
      TEMP: "temp",
      NODE_OPTIONS: "--require attacker.cjs",
      NODE_PATH: "outside-node-modules",
      npm_config_userconfig: "secret-npmrc",
      NPM_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      ANTHROPIC_API_KEY: "secret",
      JOKO_PI_PROVIDERS_FILE: "secret-bearing-config"
    });
    expect(environment).toMatchObject({ PATH: "bin", TEMP: "temp", CI: "1" });
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment).not.toHaveProperty("NODE_PATH");
    expect(environment).not.toHaveProperty("npm_config_userconfig");
    expect(environment).not.toHaveProperty("NPM_TOKEN");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(environment).not.toHaveProperty("JOKO_PI_PROVIDERS_FILE");
  });

  it("removes relative and repository executable paths from the isolated PATH", () => {
    const root = temporaryDirectory("path");
    const repository = resolve(root, "repository");
    const system = resolve(root, "system-bin");
    const external = resolve(root, "external-bin");
    expect(runtimeExecutablePath([
      "./node_modules/.bin",
      resolve(repository, "node_modules", ".bin"),
      system,
      external,
      system
    ].join(delimiter), [repository])).toBe(
      [system, external].join(delimiter)
    );
  });

  it("audits regular bounded trees and rejects links and size overruns", async () => {
    const root = temporaryDirectory("audit");
    mkdirSync(resolve(root, "nested"));
    writeFileSync(resolve(root, "nested", "entry.js"), "export {};\n");
    await expect(auditRegularRuntimeTree(root)).resolves.toEqual({ files: 1, bytes: 11 });
    await expect(auditRegularRuntimeTree(root, { maximumBytes: 3 })).rejects.toThrow(/byte-size limit/u);

    const outside = temporaryDirectory("outside");
    writeFileSync(resolve(outside, "target.js"), "outside\n");
    symlinkSync(outside, resolve(root, "escape"), "junction");
    await expect(auditRegularRuntimeTree(root)).rejects.toThrow(/symlink or junction/u);
  });

  it("materializes contained dependency links but rejects links escaping the isolated closure", async () => {
    const source = temporaryDirectory("source");
    const target = resolve(source, "packages", "dependency");
    mkdirSync(target, { recursive: true });
    writeFileSync(resolve(target, "index.js"), "export const ok = true;\n");
    mkdirSync(resolve(source, "node_modules"));
    symlinkSync(target, resolve(source, "node_modules", "dependency"), "junction");
    const destination = resolve(temporaryDirectory("destination-parent"), "candidate");
    await expect(copyRegularTree(source, destination, { allowContainedLinks: true })).resolves.toMatchObject({ files: 2 });
    await expect(auditRegularRuntimeTree(destination)).resolves.toMatchObject({ files: 2 });

    const outside = temporaryDirectory("external-target");
    writeFileSync(resolve(outside, "index.js"), "outside\n");
    symlinkSync(outside, resolve(source, "node_modules", "escape"), "junction");
    const rejected = resolve(temporaryDirectory("rejected-parent"), "candidate");
    await expect(copyRegularTree(source, rejected, { allowContainedLinks: true })).rejects.toThrow(/escapes/u);
  });

  it("rejects lexical escape paths", () => {
    const root = resolve("C:/runtime-root");
    expect(() => assertContained(root, resolve(root, "node_modules", "package"))).not.toThrow();
    expect(() => assertContained(root, resolve(root, "..", "root-node_modules"))).toThrow(/escapes/u);
  });

  it("publishes only a verified fixed-name prepared sibling", async () => {
    const parent = temporaryDirectory("publish");
    const prepared = resolve(parent, ".orchestrator-runtime-stage-fixture");
    const destination = resolve(parent, "orchestrator-runtime");
    mkdirSync(prepared);
    mkdirSync(destination);
    writeFileSync(resolve(prepared, "current.txt"), "current\n");
    writeFileSync(resolve(destination, "old.txt"), "old\n");

    await replaceDirectoryFromPrepared(prepared, destination);
    expect(readFileSync(resolve(destination, "current.txt"), "utf8")).toBe("current\n");
    await expect(replaceDirectoryFromPrepared(resolve(parent, "candidate"), destination)).rejects.toThrow();
  });
});

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `joko-runtime-${label}-`));
  cleanups.push(directory);
  return directory;
}

interface SqliteVecFixture {
  readonly runtimeRoot: string;
  readonly smokePath: string;
  readonly nativeBinary: string;
}

async function sqliteVecRuntimeFixture(label: string): Promise<SqliteVecFixture> {
  const target = sqliteVecRuntimeTarget(process.platform, process.arch);
  const runtimeRoot = temporaryDirectory(label);
  const nodeModules = resolve(runtimeRoot, "node_modules");
  mkdirSync(nodeModules);
  writeFileSync(resolve(runtimeRoot, "package.json"), '{"name":"sqlite-vec-electron-smoke","private":true,"type":"module"}\n');
  const storeRequire = createRequire(new URL("../../../packages/store/package.json", import.meta.url));
  const sqliteSourceRoot = dirname(storeRequire.resolve("sqlite-vec"));
  const sourceBinary = storeRequire.resolve(`${target.packageName}/${target.binaryName}`);
  await copyRegularTree(realpathSync(sqliteSourceRoot), resolve(nodeModules, "sqlite-vec"));
  await copyRegularTree(realpathSync(dirname(sourceBinary)), resolve(nodeModules, target.packageName));
  const smokePath = resolve(runtimeRoot, "sqlite-vec-smoke.mjs");
  writeFileSync(smokePath, `${sqliteVecElectronSmokeSource(process.platform, process.arch)}\n`);
  return {
    runtimeRoot,
    smokePath,
    nativeBinary: resolve(runtimeRoot, target.binaryRelativePath)
  };
}

function runSqliteVecProbe(fixture: SqliteVecFixture): SpawnSyncReturns<string> {
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return spawnSync(electronSmokeExecutable(), [fixture.smokePath, fixture.runtimeRoot], {
    cwd: fixture.runtimeRoot,
    env: environment,
    encoding: "utf8",
    timeout: 45_000,
    windowsHide: true
  });
}

function electronSmokeExecutable(): string {
  const resolved = createRequire(import.meta.url)("electron") as unknown;
  if (typeof resolved !== "string" || !canonicalRegularFileExists(resolved)) {
    throw new Error("The pinned Electron executable is missing or unsafe for the sqlite-vec ABI smoke.");
  }
  return resolved;
}

function canonicalRegularFileExists(path: string): boolean {
  if (!existsSync(path)) return false;
  const info = lstatSync(path);
  const canonical = realpathSync(path);
  return info.isFile() && !info.isSymbolicLink() && (process.platform === "win32"
    ? canonical.toLowerCase() === resolve(path).toLowerCase()
    : canonical === resolve(path));
}
