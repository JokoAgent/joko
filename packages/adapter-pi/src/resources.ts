import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RuntimeResource } from "@joko/core";
import { minimatch } from "minimatch";
import { piError } from "./errors.js";

export interface ProjectSkillCandidate {
  readonly sourcePath: string;
  readonly scope: ".pi" | ".agents";
  readonly workspaceRoot: string;
}

export interface ProjectResourceSnapshotOptions {
  readonly workspaceRoot: string;
  readonly destinationRoot: string;
  readonly trusted: boolean;
  readonly approve?: (candidate: ProjectSkillCandidate) => boolean | Promise<boolean>;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

export interface ProjectResourceSnapshot {
  readonly skillPaths: readonly string[];
  readonly resources: readonly RuntimeResource[];
  readonly fileCount: number;
  readonly byteLength: number;
}

/**
 * A host-owned approval snapshot. The adapter never discovers executable
 * resources from Agent Home or the workspace and only consumes these paths
 * after copying them into a generation-scoped runtime directory.
 */
export interface PiManagedRuntimeResourceSnapshot {
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly prompts: readonly string[];
  readonly packages: readonly string[];
  readonly resources: readonly RuntimeResource[];
}

export interface ManagedRuntimeResourceSnapshotOptions {
  readonly snapshot?: PiManagedRuntimeResourceSnapshot;
  readonly destinationRoot: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

export interface ManagedRuntimeResourceSnapshot {
  readonly extensionPaths: readonly string[];
  readonly skillPaths: readonly string[];
  readonly promptTemplatePaths: readonly string[];
  /** Direct paths before headless package expansion, used for layered snapshots. */
  readonly directExtensionPaths: readonly string[];
  readonly directSkillPaths: readonly string[];
  readonly directPromptTemplatePaths: readonly string[];
  readonly packagePaths: readonly string[];
  readonly resources: readonly RuntimeResource[];
  readonly fileCount: number;
  readonly byteLength: number;
}

interface CopyBudget {
  files: number;
  bytes: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
}

export async function snapshotApprovedProjectResources(options: ProjectResourceSnapshotOptions): Promise<ProjectResourceSnapshot> {
  const workspaceRoot = await canonicalDirectory(options.workspaceRoot, "workspace root");
  const destinationRoot = resolve(options.destinationRoot);
  if (!isAbsolute(destinationRoot)) throw piError("PI_RESOURCE_INVALID_DESTINATION", "Resource snapshot destination must be absolute", "resource");
  await mkdir(destinationRoot, { recursive: true }).catch((error) => {
    throw piError("PI_RESOURCE_DESTINATION_UNAVAILABLE", "Failed to create the managed project resource snapshot directory", "resource", {
      retryable: true,
      cause: error
    });
  });
  const destinationInfo = await lstat(destinationRoot);
  if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
    throw piError("PI_RESOURCE_UNSAFE_DESTINATION", "Project resource snapshot destination must be a regular directory", "resource");
  }
  const canonicalDestination = await realpath(destinationRoot);
  if (!samePath(canonicalDestination, destinationRoot)) {
    throw piError("PI_RESOURCE_DESTINATION_ALIAS_DENIED", "Project resource snapshot destination contains a path alias or junction", "resource");
  }
  if (!options.trusted) return { skillPaths: [], resources: [], fileCount: 0, byteLength: 0 };

  const budget: CopyBudget = {
    files: 0,
    bytes: 0,
    maxFiles: options.maxFiles ?? 5_000,
    maxBytes: options.maxBytes ?? 32 * 1024 * 1024
  };
  const skillPaths: string[] = [];
  const resources: RuntimeResource[] = [];
  const projectRoot = await findNearestGitRoot(workspaceRoot) ?? workspaceRoot;
  const agentAncestors = directoriesThroughBoundary(workspaceRoot, projectRoot);
  const candidates: Array<ProjectSkillCandidate & { readonly destinationName: string; readonly resourceId: string }> = [
    {
      scope: ".pi",
      sourcePath: join(workspaceRoot, ".pi", "skills"),
      workspaceRoot,
      destinationName: "pi-skills",
      resourceId: "project:.pi:skills"
    },
    ...agentAncestors.map((directory, index) => ({
      scope: ".agents" as const,
      sourcePath: join(directory, ".agents", "skills"),
      workspaceRoot,
      destinationName: `agents-skills-${index}`,
      resourceId: `project:.agents:skills:${index}`
    }))
  ];

  for (const candidate of candidates) {
    const sourceStat = await lstat(candidate.sourcePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!sourceStat) continue;
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw piError("PI_RESOURCE_UNSAFE_ROOT", `Project skill root '${candidate.sourcePath}' is not a real directory`, "resource", {
        recovery: "Remove symlinks, junctions, or special files and approve a regular project skill directory."
      });
    }
    const canonicalSource = await realpath(candidate.sourcePath);
    assertContained(projectRoot, canonicalSource, "project skill root");
    // Trust alone never authorizes project code. Without a host-owned approval
    // callback the conventional project resource stays inert.
    const approval = options.approve?.({ scope: candidate.scope, sourcePath: canonicalSource, workspaceRoot }) ?? false;
    if (!(await approval)) continue;

    const destination = join(destinationRoot, candidate.destinationName);
    await mkdir(destination, { recursive: true });
    await copyTreeFailClosed(projectRoot, canonicalSource, destination, budget);
    skillPaths.push(destination);
    resources.push({
      id: candidate.resourceId,
      kind: "skill",
      name: `${candidate.scope}/skills`,
      source: canonicalSource,
      state: "approved",
      runtimePath: destination,
      detail: `Immutable runtime snapshot (${budget.files} files checked)`
    });
  }

  return { skillPaths, resources, fileCount: budget.files, byteLength: budget.bytes };
}

async function findNearestGitRoot(start: string): Promise<string | undefined> {
  let current = start;
  while (true) {
    try {
      const marker = await stat(join(current, ".git"));
      if (marker.isDirectory() || marker.isFile()) return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function directoriesThroughBoundary(start: string, boundary: string): string[] {
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (samePath(current, boundary)) return directories;
    const parent = dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

export async function snapshotManagedRuntimeResources(
  options: ManagedRuntimeResourceSnapshotOptions
): Promise<ManagedRuntimeResourceSnapshot> {
  const destinationRoot = resolve(options.destinationRoot);
  if (!isAbsolute(options.destinationRoot) || destinationRoot !== options.destinationRoot) {
    throw piError("PI_RESOURCE_INVALID_DESTINATION", "Managed resource snapshot destination must be a normalized absolute path", "resource");
  }
  await mkdir(destinationRoot, { recursive: true });
  const destinationInfo = await lstat(destinationRoot);
  if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink() || !samePath(await realpath(destinationRoot), destinationRoot)) {
    throw piError("PI_RESOURCE_UNSAFE_DESTINATION", "Managed resource snapshot destination must be a canonical regular directory", "resource");
  }

  const budget: CopyBudget = {
    files: 0,
    bytes: 0,
    maxFiles: options.maxFiles ?? 10_000,
    maxBytes: options.maxBytes ?? 256 * 1024 * 1024
  };
  assertBudget(budget);
  const extensionPaths: string[] = [];
  const skillPaths: string[] = [];
  const promptTemplatePaths: string[] = [];
  const seen = new Set<string>();
  const copiedBySource = new Map<string, string>();
  const snapshot = options.snapshot ?? { extensions: [], skills: [], prompts: [], packages: [], resources: [] };

  const copyGroup = async (kind: "extension" | "skill" | "prompt" | "package", paths: readonly string[]): Promise<string[]> => {
    const copied: string[] = [];
    const groupRoot = join(destinationRoot, `${kind}s`);
    await mkdir(groupRoot, { recursive: true });
    for (const [index, sourcePath] of paths.entries()) {
      const source = await canonicalApprovedResource(sourcePath, `${kind} resource`);
      if (pathContains(source, destinationRoot) || pathContains(destinationRoot, source)) {
        throw piError("PI_RESOURCE_SNAPSHOT_OVERLAP", `Approved runtime resource '${source}' overlaps its snapshot destination`, "resource", {
          recovery: "Keep host-approved resource storage separate from generation runtime directories."
        });
      }
      const identity = pathIdentity(source);
      if (seen.has(identity)) {
        throw piError("PI_RESOURCE_DUPLICATE_PATH", `Approved runtime resource '${source}' appears more than once`, "resource");
      }
      seen.add(identity);
      const destination = join(groupRoot, `${String(index).padStart(4, "0")}-${safeResourceName(source)}`);
      await copyApprovedResource(source, destination, budget);
      copiedBySource.set(identity, destination);
      copied.push(destination);
    }
    return copied;
  };

  const directExtensionPaths = await copyGroup("extension", snapshot.extensions);
  const directSkillPaths = await copyGroup("skill", snapshot.skills);
  const directPromptTemplatePaths = await copyGroup("prompt", snapshot.prompts);
  extensionPaths.push(...directExtensionPaths);
  skillPaths.push(...directSkillPaths);
  promptTemplatePaths.push(...directPromptTemplatePaths);
  const packagePaths = await copyGroup("package", snapshot.packages);
  for (const packagePath of packagePaths) {
    const expanded = await expandHeadlessPackage(packagePath);
    extensionPaths.push(...expanded.extensionPaths);
    skillPaths.push(...expanded.skillPaths);
    promptTemplatePaths.push(...expanded.promptTemplatePaths);
  }

  return {
    extensionPaths,
    skillPaths,
    promptTemplatePaths,
    directExtensionPaths,
    directSkillPaths,
    directPromptTemplatePaths,
    packagePaths,
    resources: snapshot.resources.map((resource) => {
      const { runtimePath: _previousRuntimePath, ...descriptor } = resource;
      const runtimePath = resource.runtimePath === undefined
        ? undefined
        : copiedBySource.get(pathIdentity(resource.runtimePath));
      return {
        ...descriptor,
        // A descriptor/path mismatch is not evidence. Omitting the path keeps
        // the resource visible as approved without allowing a false loaded
        // promotion.
        ...(runtimePath === undefined ? {} : { runtimePath })
      };
    }),
    fileCount: budget.files,
    byteLength: budget.bytes
  };
}

interface HeadlessPackageResources {
  readonly extensionPaths: readonly string[];
  readonly skillPaths: readonly string[];
  readonly promptTemplatePaths: readonly string[];
}

async function expandHeadlessPackage(packagePath: string): Promise<HeadlessPackageResources> {
  const info = await lstat(packagePath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw piError("PI_RESOURCE_PACKAGE_PATH_UNSAFE", `Approved package '${packagePath}' must be a real directory snapshot`, "resource");
  }
  const manifestPath = join(packagePath, "package.json");
  const manifestText = await readFile(manifestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  let manifest: Record<string, unknown> | undefined;
  if (manifestText !== undefined) {
    try {
      const value: unknown = JSON.parse(manifestText);
      if (isPlainObject(value) && Object.hasOwn(value, "pi")) {
        if (!isPlainObject(value.pi)) {
          throw piError("PI_RESOURCE_PACKAGE_MANIFEST_INVALID", `Approved package '${packagePath}' has an invalid pi manifest`, "resource", {
            recovery: "Repair and re-approve the immutable package snapshot."
          });
        }
        manifest = value.pi;
      }
    } catch (error) {
      if (error instanceof Error && "publicError" in error) throw error;
      throw piError("PI_RESOURCE_PACKAGE_MANIFEST_INVALID", `Approved package '${packagePath}' has invalid package.json`, "resource", {
        cause: error,
        recovery: "Repair and re-approve the immutable package snapshot."
      });
    }
  }

  const extensions = manifest === undefined ? ["extensions"] : manifestEntries(manifest, "extensions", packagePath);
  const skills = manifest === undefined ? ["skills"] : manifestEntries(manifest, "skills", packagePath);
  const prompts = manifest === undefined ? ["prompts"] : manifestEntries(manifest, "prompts", packagePath);
  const [extensionPaths, skillPaths, promptTemplatePaths] = await Promise.all([
    resolvePackageManifestEntries(packagePath, extensions, "extensions"),
    resolvePackageManifestEntries(packagePath, skills, "skills"),
    resolvePackageManifestEntries(packagePath, prompts, "prompts")
  ]);
  return { extensionPaths, skillPaths, promptTemplatePaths };
}

function manifestEntries(manifest: Record<string, unknown>, key: "extensions" | "skills" | "prompts", packagePath: string): string[] {
  const value = manifest[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw piError("PI_RESOURCE_PACKAGE_MANIFEST_INVALID", `Approved package '${packagePath}' has invalid pi.${key}`, "resource", {
      recovery: "Repair and re-approve the immutable package snapshot."
    });
  }
  return value;
}

type PackageResourceType = "extensions" | "skills" | "prompts";
const MAX_PACKAGE_MANIFEST_PATHS = 20_000;

async function resolvePackageManifestEntries(
  packagePath: string,
  entries: readonly string[],
  resourceType: PackageResourceType
): Promise<string[]> {
  for (const entry of entries) validateManifestPattern(packagePath, entry);
  const candidates = await enumeratePackagePaths(packagePath);
  const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
  const sources: string[] = [];
  for (const entry of sourceEntries) {
    if (hasGlobPattern(entry)) {
      for (const candidate of candidates) {
        if (minimatch(toPosix(relative(packagePath, candidate)), toPosix(entry), { dot: false })) sources.push(candidate);
      }
      continue;
    }
    const candidate = resolve(packagePath, entry);
    assertContained(packagePath, candidate, "package resource");
    const found = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!found) continue;
    assertRegularPackagePath(candidate, found);
    sources.push(await canonicalPackagePath(packagePath, candidate));
  }

  const discovered: string[] = [];
  for (const source of stableUnique(sources)) {
    const found = await lstat(source);
    if (found.isFile()) discovered.push(source);
    else discovered.push(...(await collectPackageResources(packagePath, source, resourceType)));
  }
  const allFiles = stableUnique(discovered);
  const enabled = applyManifestOverrides(allFiles, entries, packagePath);
  return allFiles.filter((path) => enabled.has(path));
}

async function enumeratePackagePaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === "." || entry.name === ".." || entry.name.includes("\0")) {
        throw piError("PI_RESOURCE_INVALID_NAME", "Package resource contains an invalid path component", "resource");
      }
      const candidate = join(directory, entry.name);
      const info = await lstat(candidate);
      assertRegularPackagePath(candidate, info);
      const canonical = await canonicalPackagePath(root, candidate);
      paths.push(canonical);
      if (paths.length > MAX_PACKAGE_MANIFEST_PATHS) {
        throw piError("PI_RESOURCE_LIMIT_EXCEEDED", "Approved package manifest expansion exceeds the bounded path limit", "resource", {
          recovery: "Reduce the package resource tree before approving it again."
        });
      }
      if (info.isDirectory()) await visit(canonical);
    }
  };
  await visit(root);
  return paths;
}

async function collectPackageResources(root: string, source: string, resourceType: PackageResourceType): Promise<string[]> {
  if (resourceType === "extensions") return collectPackageExtensions(root, source);
  if (resourceType === "skills") return collectPackageSkills(root, source, true);
  return collectPackageMarkdown(root, source);
}

async function collectPackageExtensions(root: string, directory: string): Promise<string[]> {
  const declaredEntries = await declaredPackageExtensionEntries(root, directory);
  if (declaredEntries.length > 0) return declaredEntries;
  const ownEntry = await firstExistingRegularFile(root, [join(directory, "index.ts"), join(directory, "index.js")]);
  if (ownEntry) return [ownEntry];
  const values: string[] = [];
  const entries = await safePackageDirectoryEntries(root, directory);
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entry.info.isFile() && /\.(?:ts|js)$/u.test(entry.name)) values.push(entry.path);
    else if (entry.info.isDirectory()) {
      const childEntry = await firstExistingRegularFile(root, [join(entry.path, "index.ts"), join(entry.path, "index.js")]);
      if (childEntry) values.push(childEntry);
    }
  }
  return stableUnique(values);
}

async function declaredPackageExtensionEntries(root: string, directory: string): Promise<string[]> {
  const manifestPath = join(directory, "package.json");
  const text = await readFile(manifestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw piError("PI_RESOURCE_PACKAGE_MANIFEST_INVALID", `Approved package '${directory}' has invalid package.json`, "resource", { cause: error });
  }
  if (!isPlainObject(decoded) || !isPlainObject(decoded.pi) || decoded.pi["extensions"] === undefined) return [];
  const values = decoded.pi["extensions"];
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string" && value.length > 0)) {
    throw piError("PI_RESOURCE_PACKAGE_MANIFEST_INVALID", `Approved package '${directory}' has invalid pi.extensions`, "resource");
  }
  const paths: string[] = [];
  for (const value of values) {
    const candidate = resolve(directory, value);
    assertContained(root, candidate, "nested package extension");
    const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) continue;
    assertRegularPackagePath(candidate, info);
    paths.push(await canonicalPackagePath(root, candidate));
  }
  return stableUnique(paths);
}

async function collectPackageSkills(root: string, directory: string, topLevel: boolean): Promise<string[]> {
  const ownSkill = await firstExistingRegularFile(root, [join(directory, "SKILL.md")]);
  if (ownSkill) return [ownSkill];
  const values: string[] = [];
  for (const entry of await safePackageDirectoryEntries(root, directory)) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (topLevel && entry.info.isFile() && entry.name.endsWith(".md")) values.push(entry.path);
    else if (entry.info.isDirectory()) values.push(...(await collectPackageSkills(root, entry.path, false)));
  }
  return stableUnique(values);
}

async function collectPackageMarkdown(root: string, directory: string): Promise<string[]> {
  const values: string[] = [];
  for (const entry of await safePackageDirectoryEntries(root, directory)) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entry.info.isFile() && entry.name.endsWith(".md")) values.push(entry.path);
    else if (entry.info.isDirectory()) values.push(...(await collectPackageMarkdown(root, entry.path)));
  }
  return stableUnique(values);
}

async function safePackageDirectoryEntries(root: string, directory: string): Promise<readonly { name: string; path: string; info: Awaited<ReturnType<typeof lstat>> }[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const values: { name: string; path: string; info: Awaited<ReturnType<typeof lstat>> }[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    assertRegularPackagePath(path, info);
    values.push({ name: entry.name, path: await canonicalPackagePath(root, path), info });
  }
  return values;
}

async function firstExistingRegularFile(root: string, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) continue;
    assertRegularPackagePath(candidate, info);
    if (info.isFile()) return canonicalPackagePath(root, candidate);
  }
  return undefined;
}

function applyManifestOverrides(allFiles: readonly string[], entries: readonly string[], baseDir: string): Set<string> {
  const excludes = entries.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1));
  const includes = entries.filter((entry) => entry.startsWith("+")).map((entry) => entry.slice(1));
  const forceExcludes = entries.filter((entry) => entry.startsWith("-")).map((entry) => entry.slice(1));
  const enabled = new Set(allFiles);
  for (const path of allFiles) if (matchesManifestPattern(path, excludes, baseDir)) enabled.delete(path);
  for (const path of allFiles) if (matchesExactManifestPath(path, includes, baseDir)) enabled.add(path);
  for (const path of allFiles) if (matchesExactManifestPath(path, forceExcludes, baseDir)) enabled.delete(path);
  return enabled;
}

function matchesManifestPattern(path: string, patterns: readonly string[], baseDir: string): boolean {
  const relativePath = toPosix(relative(baseDir, path));
  const absolutePath = toPosix(path);
  const name = basename(path);
  const skillParent = name === "SKILL.md" ? dirname(path) : undefined;
  return patterns.some((pattern) => {
    const normalized = toPosix(pattern);
    return minimatch(relativePath, normalized) || minimatch(name, normalized) || minimatch(absolutePath, normalized) ||
      (skillParent !== undefined && (
        minimatch(toPosix(relative(baseDir, skillParent)), normalized) ||
        minimatch(basename(skillParent), normalized) ||
        minimatch(toPosix(skillParent), normalized)
      ));
  });
}

function matchesExactManifestPath(path: string, patterns: readonly string[], baseDir: string): boolean {
  const relativePath = toPosix(relative(baseDir, path));
  const absolutePath = toPosix(path);
  const skillParent = basename(path) === "SKILL.md" ? dirname(path) : undefined;
  return patterns.some((pattern) => {
    const normalized = toPosix(pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern);
    return normalized === relativePath || normalized === absolutePath ||
      (skillParent !== undefined && (normalized === toPosix(relative(baseDir, skillParent)) || normalized === toPosix(skillParent)));
  });
}

function validateManifestPattern(root: string, entry: string): void {
  const pattern = isOverridePattern(entry) ? entry.slice(1) : entry;
  if (pattern.length === 0 || pattern.includes("\0")) {
    throw piError("PI_RESOURCE_PACKAGE_MANIFEST_INVALID", `Approved package '${root}' contains an invalid empty resource pattern`, "resource");
  }
  const candidate = resolve(root, pattern);
  assertContained(root, candidate, "package resource pattern");
}

function hasGlobPattern(value: string): boolean {
  return /[*?\[\]{}]/u.test(value);
}

function isOverridePattern(value: string): boolean {
  return value.startsWith("!") || value.startsWith("+") || value.startsWith("-");
}

function assertRegularPackagePath(path: string, info: Awaited<ReturnType<typeof lstat>>): void {
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
    throw piError("PI_RESOURCE_PACKAGE_PATH_UNSAFE", `Package resource '${path}' is not a regular file or directory`, "resource");
  }
}

async function canonicalPackagePath(root: string, path: string): Promise<string> {
  const canonical = await realpath(path);
  assertContained(root, canonical, "package resource");
  return canonical;
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

async function canonicalApprovedResource(path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw piError("PI_RESOURCE_PATH_NOT_NORMALIZED", `${label} must be a normalized absolute path`, "resource");
  }
  const info = await lstat(path).catch((error) => {
    throw piError("PI_RESOURCE_PATH_UNAVAILABLE", `${label} is unavailable`, "resource", { cause: error });
  });
  if ((!info.isDirectory() && !info.isFile()) || info.isSymbolicLink()) {
    throw piError("PI_RESOURCE_UNSAFE_PATH", `${label} must be a regular file or directory, not a symlink or special file`, "resource");
  }
  const canonical = await realpath(path);
  if (!samePath(canonical, path)) {
    throw piError("PI_RESOURCE_PATH_ALIAS_DENIED", `${label} contains a path alias or parent junction`, "resource");
  }
  return canonical;
}

async function copyApprovedResource(source: string, destination: string, budget: CopyBudget): Promise<void> {
  const before = await lstat(source);
  if (before.isDirectory()) {
    await mkdir(destination, { recursive: false });
    await copyTreeFailClosed(source, source, destination, budget);
    const after = await lstat(source);
    if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after) || after.mtimeMs !== before.mtimeMs) {
      throw piError("PI_RESOURCE_RACE", `Approved resource directory '${source}' changed during snapshot`, "resource");
    }
    return;
  }
  budget.files += 1;
  budget.bytes += before.size;
  assertBudget(budget);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  const after = await stat(source);
  if (!after.isFile() || !sameIdentity(before, after) || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw piError("PI_RESOURCE_RACE", `Approved resource file '${source}' changed during snapshot`, "resource");
  }
}

function assertBudget(budget: CopyBudget): void {
  if (!Number.isSafeInteger(budget.maxFiles) || budget.maxFiles < 1 || !Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1) {
    throw piError("PI_RESOURCE_INVALID_LIMIT", "Managed resource snapshot limits must be positive safe integers", "resource");
  }
  if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes) {
    throw piError("PI_RESOURCE_LIMIT_EXCEEDED", "Approved runtime resources exceed the snapshot safety limits", "resource", {
      recovery: "Reduce the approved resource set or explicitly raise the managed snapshot limits."
    });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pathIdentity(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function pathContains(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}

async function copyTreeFailClosed(workspaceRoot: string, source: string, destination: string, budget: CopyBudget): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === "." || entry.name === ".." || entry.name.includes("\0")) {
      throw piError("PI_RESOURCE_INVALID_NAME", "Project resource contains an invalid path component", "resource");
    }
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const before = await lstat(sourcePath);
    if (before.isSymbolicLink() || entry.isSymbolicLink()) {
      throw piError("PI_RESOURCE_SYMLINK_DENIED", `Project resource '${sourcePath}' is a symlink or junction`, "resource", {
        recovery: "Replace it with regular files inside the trusted workspace and approve again."
      });
    }
    const canonicalSource = await realpath(sourcePath);
    assertContained(workspaceRoot, canonicalSource, "project resource");
    if (before.isDirectory()) {
      if (!entry.isDirectory()) throw piError("PI_RESOURCE_RACE", `Project resource '${sourcePath}' changed during snapshot`, "resource");
      await mkdir(destinationPath, { recursive: false });
      await copyTreeFailClosed(workspaceRoot, canonicalSource, destinationPath, budget);
      const after = await lstat(sourcePath);
      if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after) || after.mtimeMs !== before.mtimeMs) {
        throw piError("PI_RESOURCE_RACE", `Project resource directory '${sourcePath}' changed during snapshot`, "resource");
      }
      continue;
    }
    if (!before.isFile() || !entry.isFile()) {
      throw piError("PI_RESOURCE_SPECIAL_FILE_DENIED", `Project resource '${sourcePath}' is not a regular file`, "resource");
    }
    budget.files += 1;
    budget.bytes += before.size;
    if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes) {
      throw piError("PI_RESOURCE_LIMIT_EXCEEDED", "Approved project resources exceed the snapshot safety limits", "resource", {
        recovery: "Reduce the project skill set or explicitly raise the managed snapshot limits."
      });
    }
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
    const after = await stat(sourcePath);
    if (!after.isFile() || !sameIdentity(before, after) || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw piError("PI_RESOURCE_RACE", `Project resource file '${sourcePath}' changed during snapshot`, "resource", {
        recovery: "Retry after other writers stop modifying project skills."
      });
    }
  }
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const resolved = resolve(path);
  const info = await lstat(resolved).catch((error) => {
    throw piError("PI_RESOURCE_PATH_UNAVAILABLE", `${label} is unavailable`, "resource", { cause: error });
  });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw piError("PI_RESOURCE_UNSAFE_PATH", `${label} must be a regular directory, not a symlink or special file`, "resource");
  }
  return realpath(resolved);
}

function assertContained(root: string, candidate: string, label: string): void {
  const suffix = relative(root, candidate);
  if (suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))) return;
  throw piError("PI_RESOURCE_PATH_ESCAPE", `${label} escapes the trusted workspace`, "resource");
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  // Windows can expose ino=0 on some filesystems; in that case the other race
  // checks (kind, size and mtime) remain authoritative.
  return left.dev === right.dev && (left.ino === 0 || right.ino === 0 || left.ino === right.ino);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

export function safeResourceName(path: string): string {
  return basename(resolve(path));
}
