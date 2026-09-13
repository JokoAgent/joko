import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { nodeExecutableEnvironment, resolveBundledNpmRuntime } from "./npm-runtime.js";

export type PiPackageSource =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "npm"; readonly packageName: string; readonly versionSpec?: string }
  | {
      readonly kind: "git";
      readonly repositoryUrl: string;
      readonly ref?: string;
      readonly subdirectory?: string;
    };

export interface PiPackageAcquisitionRequest {
  readonly source: PiPackageSource;
  readonly destinationRoot: string;
  readonly action: "install" | "update";
}

export interface PiPackageAcquisitionResult {
  readonly rootPath: string;
  readonly version?: string;
}

/**
 * Network/package acquisition is isolated behind this interface so lifecycle
 * tests never need a network and production never constructs a shell command.
 */
export interface PiPackageAcquisition {
  acquire(request: PiPackageAcquisitionRequest): Promise<PiPackageAcquisitionResult>;
}

/** Public-package acquisition with lifecycle scripts and ambient credentials disabled. */
export class DefaultPiPackageAcquisition implements PiPackageAcquisition {
  async acquire(request: PiPackageAcquisitionRequest): Promise<PiPackageAcquisitionResult> {
    const source = normalizePiPackageSource(request.source);
    if (source.kind === "local") return { rootPath: source.path };
    const destinationRoot = normalizedAbsolute(request.destinationRoot, "Package acquisition destination");
    await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
    if (source.kind === "npm") return acquireNpm(source, destinationRoot);
    return acquireGit(source, destinationRoot);
  }
}

export function normalizePiPackageSource(source: PiPackageSource): PiPackageSource {
  if (typeof source !== "object" || source === null || !("kind" in source)) throw new Error("Package acquisition source is invalid.");
  switch (source.kind) {
    case "local":
      if (typeof source.path !== "string") throw new Error("Local package path is invalid.");
      return { kind: "local", path: normalizedAbsolute(source.path, "Local package path") };
    case "npm": {
      if (typeof source.packageName !== "string" || (source.versionSpec !== undefined && typeof source.versionSpec !== "string")) {
        throw new Error("Npm package source is invalid.");
      }
      const packageName = source.packageName.trim();
      if (!isNpmPackageName(packageName)) {
        throw new Error("Npm package name is invalid.");
      }
      const versionSpec = source.versionSpec?.trim();
      if (versionSpec !== undefined && (
        versionSpec === "" || versionSpec.length > 128 ||
        !/^[A-Za-z0-9*^~<>=|+_. -]+$/u.test(versionSpec)
      )) throw new Error("Npm version spec is invalid.");
      return { kind: "npm", packageName, ...(versionSpec === undefined ? {} : { versionSpec }) };
    }
    case "git": {
      if (
        typeof source.repositoryUrl !== "string" ||
        (source.ref !== undefined && typeof source.ref !== "string") ||
        (source.subdirectory !== undefined && typeof source.subdirectory !== "string")
      ) throw new Error("Git package source is invalid.");
      const repositoryUrl = safeGitRepositoryUrl(source.repositoryUrl);
      const ref = source.ref?.trim();
      if (ref !== undefined && (
        ref === "" || ref.length > 256 || ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") ||
        ref.includes("..") || ref.includes("@{") || !/^[A-Za-z0-9_./-]+$/u.test(ref)
      )) throw new Error("Git ref is invalid.");
      const subdirectory = normalizeRelativeSubdirectory(source.subdirectory);
      return {
        kind: "git",
        repositoryUrl,
        ...(ref === undefined ? {} : { ref }),
        ...(subdirectory === undefined ? {} : { subdirectory })
      };
    }
    default:
      throw new Error("Package acquisition source kind is invalid.");
  }
}

/** Identity intentionally ignores npm versions and git refs for project-over-global precedence. */
export function piPackageSourceIdentity(source: PiPackageSource): string {
  const normalized = normalizePiPackageSource(source);
  switch (normalized.kind) {
    case "local":
      return `local:${pathIdentity(normalized.path)}`;
    case "npm":
      return `npm:${normalized.packageName.toLowerCase()}`;
    case "git": {
      const url = new URL(normalized.repositoryUrl);
      const repositoryPath = url.pathname.replace(/\/+$/u, "").replace(/\.git$/iu, "").toLowerCase();
      return `git:${url.hostname.toLowerCase()}${repositoryPath}`;
    }
  }
}

export function piPackageSourceDisplay(source: PiPackageSource): string {
  const normalized = normalizePiPackageSource(source);
  switch (normalized.kind) {
    case "local": return normalized.path.split(/[\\/]/u).at(-1) ?? "local-package";
    case "npm": return normalized.packageName;
    case "git": {
      const url = new URL(normalized.repositoryUrl);
      return `${url.hostname}${url.pathname.replace(/\.git$/iu, "")}`;
    }
  }
}

export function piPackageSourceApprovalRevision(source: PiPackageSource): string {
  const normalized = normalizePiPackageSource(source);
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

export function piPackageSourceWithVersion(source: PiPackageSource, requestedVersion: string | undefined): PiPackageSource {
  if (requestedVersion === undefined) return normalizePiPackageSource(source);
  const versionSpec = requestedVersion.trim();
  if (source.kind !== "npm") throw new Error("requested_version is valid only for an npm package source.");
  return normalizePiPackageSource({ ...source, versionSpec });
}

async function acquireNpm(
  source: Extract<PiPackageSource, { readonly kind: "npm" }>,
  destinationRoot: string
): Promise<PiPackageAcquisitionResult> {
  const npmRoot = join(destinationRoot, "npm");
  await mkdir(npmRoot, { recursive: false, mode: 0o700 });
  await writeFile(join(npmRoot, "package.json"), "{\"private\":true}\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(join(npmRoot, ".npmrc"), "ignore-scripts=true\naudit=false\nfund=false\n", { encoding: "utf8", mode: 0o600 });
  const spec = `${source.packageName}${source.versionSpec === undefined ? "" : `@${source.versionSpec}`}`;
  await runNpmWithoutAmbientCredentials(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "--package-lock=false", "--install-strategy=nested", "--prefix", npmRoot, spec],
    npmRoot,
    npmRoot,
    "Npm package acquisition failed."
  );
  const installedRoot = join(npmRoot, "node_modules", ...source.packageName.split("/"));
  const info = await lstat(installedRoot).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) throw new Error("Npm package acquisition produced no safe package directory.");
  const rootPath = await assembleNpmPayload(npmRoot, installedRoot);
  await prepareSelfContainedNpmPayload(rootPath);
  const version = await installedPackageVersion(rootPath);
  return { rootPath, ...(version === undefined ? {} : { version }) };
}

async function acquireGit(
  source: Extract<PiPackageSource, { readonly kind: "git" }>,
  destinationRoot: string
): Promise<PiPackageAcquisitionResult> {
  const repositoryRoot = join(destinationRoot, "repository");
  await runWithoutAmbientCredentials(
    "git",
    ["clone", "--no-tags", "--depth", "1", "--", source.repositoryUrl, repositoryRoot],
    destinationRoot,
    destinationRoot,
    "Git package acquisition failed."
  );
  if (source.ref !== undefined) {
    await runWithoutAmbientCredentials(
      "git",
      ["fetch", "--depth", "1", "origin", source.ref],
      repositoryRoot,
      destinationRoot,
      "Git package ref acquisition failed."
    );
    await runWithoutAmbientCredentials(
      "git",
      ["checkout", "--detach", "FETCH_HEAD"],
      repositoryRoot,
      destinationRoot,
      "Git package checkout failed."
    );
  }
  // The checkout metadata is neither runtime input nor a package resource. It
  // is removed before the acquired tree crosses the ResourceManager boundary.
  await rm(join(repositoryRoot, ".git"), { recursive: true, force: true });
  const rootPath = source.subdirectory === undefined
    ? repositoryRoot
    : resolve(repositoryRoot, ...source.subdirectory.split("/"));
  assertContained(repositoryRoot, rootPath, "Git package subdirectory");
  const info = await lstat(rootPath).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) throw new Error("Git package acquisition produced no safe package directory.");
  if (await regularFileExists(join(rootPath, "package.json"))) {
    await writeFile(join(destinationRoot, ".npmrc"), "ignore-scripts=true\naudit=false\nfund=false\n", { encoding: "utf8", mode: 0o600 });
    await runNpmWithoutAmbientCredentials(
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "--package-lock=false", "--install-strategy=nested", "--prefix", rootPath],
      rootPath,
      destinationRoot,
      "Git package dependency acquisition failed."
    );
    await prepareSelfContainedNpmPayload(rootPath);
  }
  const version = await installedPackageVersion(rootPath);
  return { rootPath, ...(version === undefined ? {} : { version }) };
}

async function installedPackageVersion(rootPath: string): Promise<string | undefined> {
  try {
    const decoded: unknown = JSON.parse(await readFile(join(rootPath, "package.json"), "utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
    const version = (decoded as { readonly version?: unknown }).version;
    return typeof version === "string" && version.length <= 128 ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Proves that all declared runtime dependencies live inside the copied package
 * payload. npm's executable-link directories are acquisition metadata and are
 * removed without relaxing the general no-symlink resource boundary.
 */
export async function prepareSelfContainedNpmPayload(rootPath: string): Promise<void> {
  const root = normalizedAbsolute(rootPath, "Npm package payload");
  const visited = new Set<string>();
  const visit = async (packageRoot: string): Promise<void> => {
    const identity = pathIdentity(packageRoot);
    if (visited.has(identity)) return;
    if (visited.size >= 10_000) throw new Error("Npm package dependency closure is too large.");
    visited.add(identity);
    assertContained(root, packageRoot, "Npm package dependency");
    const packageInfo = await lstat(packageRoot).catch(() => undefined);
    if (packageInfo === undefined || !packageInfo.isDirectory() || packageInfo.isSymbolicLink()) {
      throw new Error("Npm package dependency is not a safe directory.");
    }
    await removeNpmBinDirectory(root, join(packageRoot, "node_modules", ".bin"));
    const manifest = await readBoundedPackageManifest(packageRoot);
    const required = dependencyNames(manifest.dependencies, "dependencies");
    const optional = dependencyNames(manifest.optionalDependencies, "optionalDependencies");
    const optionalPeers = optionalPeerNames(manifest.peerDependenciesMeta);
    const peers = dependencyNames(manifest.peerDependencies, "peerDependencies").filter((name) => !optionalPeers.has(name));
    for (const dependency of [...new Set([...required, ...optional, ...peers])]) {
      const dependencyRoot = await resolveContainedDependencyRoot(root, packageRoot, dependency);
      if (dependencyRoot === undefined && optional.includes(dependency)) continue;
      if (dependencyRoot === undefined) throw new Error("Npm package acquisition did not produce a self-contained dependency tree.");
      await visit(dependencyRoot);
    }
  };
  await visit(root);
}

async function assembleNpmPayload(npmRoot: string, installedRoot: string): Promise<string> {
  const payloadRoot = join(npmRoot, "package-payload");
  const topLevelModules = join(npmRoot, "node_modules");
  const nestedModules = join(npmRoot, "package-nested-modules");
  const nestedInfo = await lstat(join(installedRoot, "node_modules")).catch(() => undefined);
  if (nestedInfo !== undefined) {
    if (!nestedInfo.isDirectory() || nestedInfo.isSymbolicLink()) throw new Error("Npm package dependency directory is unsafe.");
    await rename(join(installedRoot, "node_modules"), nestedModules);
  }
  await rename(installedRoot, payloadRoot);
  await removeNpmBinDirectory(npmRoot, join(topLevelModules, ".bin"));
  await rename(topLevelModules, join(payloadRoot, "node_modules"));
  if (nestedInfo !== undefined) {
    await removeNpmBinDirectory(npmRoot, join(nestedModules, ".bin"));
    await mergeNestedDependencyTree(npmRoot, nestedModules, join(payloadRoot, "node_modules"));
    await rm(nestedModules, { recursive: true, force: true });
  }
  return payloadRoot;
}

async function mergeNestedDependencyTree(root: string, source: string, destination: string): Promise<void> {
  assertContained(root, source, "Nested npm dependency source");
  assertContained(root, destination, "Nested npm dependency destination");
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const sourceInfo = await lstat(sourcePath);
    if (sourceInfo.isSymbolicLink() || (!sourceInfo.isDirectory() && !sourceInfo.isFile())) {
      throw new Error("Npm package dependency tree contains an unsafe entry.");
    }
    if (entry.name.startsWith("@") && sourceInfo.isDirectory()) {
      const destinationInfo = await lstat(destinationPath).catch(() => undefined);
      if (destinationInfo === undefined) await rename(sourcePath, destinationPath);
      else {
        if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) throw new Error("Npm scoped dependency tree is unsafe.");
        await mergeNestedDependencyTree(root, sourcePath, destinationPath);
      }
      continue;
    }
    const destinationInfo = await lstat(destinationPath).catch(() => undefined);
    if (destinationInfo !== undefined) {
      if (destinationInfo.isSymbolicLink() || (!destinationInfo.isDirectory() && !destinationInfo.isFile())) {
        throw new Error("Npm package dependency destination is unsafe.");
      }
      await rm(destinationPath, { recursive: destinationInfo.isDirectory(), force: true });
    }
    await rename(sourcePath, destinationPath);
  }
}

async function readBoundedPackageManifest(packageRoot: string): Promise<Record<string, unknown>> {
  const manifestPath = join(packageRoot, "package.json");
  const info = await lstat(manifestPath).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
    throw new Error("Npm package manifest is missing or unsafe.");
  }
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Npm package manifest is invalid.");
  }
}

function dependencyNames(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Npm package ${label} are invalid.`);
  const names = Object.keys(value);
  for (const name of names) {
    if (!isNpmPackageName(name)) throw new Error(`Npm package ${label} contain an invalid package name.`);
  }
  return names;
}

function optionalPeerNames(value: unknown): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Npm package peerDependenciesMeta are invalid.");
  const optional = new Set<string>();
  for (const [name, metadata] of Object.entries(value)) {
    if (!isNpmPackageName(name) || typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      throw new Error("Npm package peerDependenciesMeta are invalid.");
    }
    if ((metadata as { readonly optional?: unknown }).optional === true) optional.add(name);
  }
  return optional;
}

async function resolveContainedDependencyRoot(root: string, packageRoot: string, dependency: string): Promise<string | undefined> {
  let directory = packageRoot;
  while (true) {
    if (basename(directory) !== "node_modules") {
      const candidate = join(directory, "node_modules", ...dependency.split("/"));
      assertContained(root, candidate, "Npm package dependency");
      if (await lstat(candidate).catch(() => undefined) !== undefined) return candidate;
    }
    if (samePath(directory, root)) return undefined;
    const parent = dirname(directory);
    const suffix = relative(root, parent);
    if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return undefined;
    directory = parent;
  }
}

async function removeNpmBinDirectory(root: string, binPath: string): Promise<void> {
  assertContained(root, binPath, "Npm executable-link directory");
  const info = await lstat(binPath).catch(() => undefined);
  if (info === undefined) return;
  if (info.isSymbolicLink()) await rm(binPath, { force: true });
  else if (info.isDirectory()) await rm(binPath, { recursive: true, force: true });
  else throw new Error("Npm executable-link path is unsafe.");
}

async function regularFileExists(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined);
  return info !== undefined && info.isFile() && !info.isSymbolicLink();
}

function runWithoutAmbientCredentials(
  command: string,
  args: readonly string[],
  cwd: string,
  isolatedHome: string,
  publicFailure: string,
  environment?: NodeJS.ProcessEnv
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment ?? isolatedProcessEnvironment(isolatedHome),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"]
    });
    child.once("error", () => reject(new Error(publicFailure)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${publicFailure} Process exited with ${code === null ? `signal ${signal ?? "unknown"}` : "a non-zero status"}.`));
    });
  });
}

async function runNpmWithoutAmbientCredentials(
  args: readonly string[],
  cwd: string,
  isolatedHome: string,
  publicFailure: string
): Promise<void> {
  const npmRuntime = await resolveBundledNpmRuntime();
  return runWithoutAmbientCredentials(
    process.execPath,
    [npmRuntime.cliPath, ...args],
    cwd,
    isolatedHome,
    publicFailure,
    nodeExecutableEnvironment(isolatedProcessEnvironment(isolatedHome))
  );
}

function isolatedProcessEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    SSH_ASKPASS_REQUIRE: "never",
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
    npm_config_loglevel: "silent"
  };
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function safeGitRepositoryUrl(value: string): string {
  if (value.length > 2_048 || value.includes("\0")) throw new Error("Git repository URL is invalid.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Git repository URL is invalid."); }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") throw new Error("Git repository must use HTTPS or SSH.");
  if (url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("Git repository URL must not contain credentials, query parameters, or fragments.");
  if (url.username !== "" && !(url.protocol === "ssh:" && url.username === "git")) {
    throw new Error("Git repository URL must not contain user credentials.");
  }
  if (url.hostname === "" || url.pathname === "" || url.pathname === "/") throw new Error("Git repository URL is incomplete.");
  return url.toString();
}

function isNpmPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu.test(value);
}

function normalizeRelativeSubdirectory(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (normalized === "" || normalized.length > 1_024 || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error("Git package subdirectory is invalid.");
  }
  const root = resolve(sep, "__joko_relative_root__");
  const resolved = resolve(root, ...normalized.split("/"));
  const suffix = relative(root, resolved);
  if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error("Git package subdirectory escapes its repository.");
  }
  return normalized;
}

function normalizedAbsolute(path: string, label: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path.includes("\0")) throw new Error(`${label} must be a normalized absolute path.`);
  return path;
}

function assertContained(root: string, candidate: string, label: string): void {
  const suffix = relative(root, candidate);
  if (suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))) return;
  throw new Error(`${label} escapes its approved root.`);
}

function pathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return pathIdentity(left) === pathIdentity(right);
}
