import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const ORCHESTRATOR_RUNTIME_MAXIMUM_FILES = 100_000;
export const ORCHESTRATOR_RUNTIME_MAXIMUM_BYTES = 2 * 1024 * 1024 * 1024;

export const ORCHESTRATOR_BUNDLED_NPM_RUNTIME = {
  name: "npm",
  version: "11.13.0",
  manifestRelativePath: "node_modules/npm/package.json",
  cliRelativePath: "node_modules/npm/bin/npm-cli.js",
  packageBinTarget: "bin/npm-cli.js"
} as const;

export const ORCHESTRATOR_RUNTIME_PACKAGES = [
  { name: "@joko/orchestrator", workspacePath: "apps/orchestrator", candidatePath: "." },
  { name: "@joko/adapter-claude-code", workspacePath: "packages/adapter-claude-code", candidatePath: "node_modules/@joko/adapter-claude-code" },
  { name: "@joko/adapter-codex", workspacePath: "packages/adapter-codex", candidatePath: "node_modules/@joko/adapter-codex" },
  { name: "@joko/adapter-dictation-refinement", workspacePath: "packages/adapter-dictation-refinement", candidatePath: "node_modules/@joko/adapter-dictation-refinement" },
  { name: "@joko/adapter-pi", workspacePath: "packages/adapter-pi", candidatePath: "node_modules/@joko/adapter-pi" },
  { name: "@joko/adapter-transcription-openai", workspacePath: "packages/adapter-transcription-openai", candidatePath: "node_modules/@joko/adapter-transcription-openai" },
  { name: "@joko/adapter-transcription-realtime", workspacePath: "packages/adapter-transcription-realtime", candidatePath: "node_modules/@joko/adapter-transcription-realtime" },
  { name: "@joko/code-host", workspacePath: "packages/code-host", candidatePath: "node_modules/@joko/code-host" },
  { name: "@joko/contracts", workspacePath: "packages/contracts", candidatePath: "node_modules/@joko/contracts" },
  { name: "@joko/core", workspacePath: "packages/core", candidatePath: "node_modules/@joko/core" },
  { name: "@joko/git-safety", workspacePath: "packages/git-safety", candidatePath: "node_modules/@joko/git-safety" },
  { name: "@joko/local-model-runtime", workspacePath: "packages/local-model-runtime", candidatePath: "node_modules/@joko/local-model-runtime" },
  { name: "@joko/outbound-network", workspacePath: "packages/outbound-network", candidatePath: "node_modules/@joko/outbound-network" },
  { name: "@joko/remote-ssh", workspacePath: "packages/remote-ssh", candidatePath: "node_modules/@joko/remote-ssh" },
  { name: "@joko/runtime-governance", workspacePath: "packages/runtime-governance", candidatePath: "node_modules/@joko/runtime-governance" },
  { name: "@joko/store", workspacePath: "packages/store", candidatePath: "node_modules/@joko/store" },
  { name: "@joko/tool-android", workspacePath: "packages/tool-android", candidatePath: "node_modules/@joko/tool-android" },
  { name: "@joko/tool-browser", workspacePath: "packages/tool-browser", candidatePath: "node_modules/@joko/tool-browser" },
  { name: "@joko/tool-computer", workspacePath: "packages/tool-computer", candidatePath: "node_modules/@joko/tool-computer" },
  { name: "@joko/tool-lsp", workspacePath: "packages/tool-lsp", candidatePath: "node_modules/@joko/tool-lsp" },
  { name: "@joko/voice-input", workspacePath: "packages/voice-input", candidatePath: "node_modules/@joko/voice-input" },
  { name: "@joko/worktree", workspacePath: "packages/worktree", candidatePath: "node_modules/@joko/worktree" }
] as const;

export const ORCHESTRATOR_RUNTIME_CRITICAL_IMPORTS = [
  "@joko/orchestrator",
  "@joko/adapter-claude-code",
  "@joko/adapter-codex",
  "@joko/adapter-dictation-refinement",
  "@joko/adapter-pi",
  "@joko/adapter-transcription-openai",
  "@joko/adapter-transcription-realtime",
  "@joko/code-host",
  "@joko/contracts",
  "@joko/contracts/desktop-bootstrap",
  "@joko/contracts/managed-outbound-proxy",
  "@joko/core",
  "@joko/core/events",
  "@joko/core/policy",
  "@joko/git-safety",
  "@joko/local-model-runtime",
  "@joko/outbound-network",
  "@joko/remote-ssh",
  "@joko/runtime-governance",
  "@joko/store",
  "@joko/tool-android",
  "@joko/tool-browser",
  "@joko/tool-computer",
  "@joko/tool-lsp",
  "@joko/voice-input",
  "@joko/worktree",
  "@earendil-works/pi-coding-agent",
  "@anthropic-ai/claude-agent-sdk",
  "@bufbuild/protobuf",
  "@connectrpc/connect",
  "@connectrpc/connect-fastify",
  "@fastify/cors",
  "@fastify/static",
  "@modelcontextprotocol/sdk/client/index.js",
  "@modelcontextprotocol/sdk/client/stdio.js",
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
  "croner",
  "extract-zip",
  "fastify",
  "minimatch",
  "playwright-core",
  "sharp",
  "sqlite-vec",
  "undici"
] as const;

export interface SqliteVecRuntimeTarget {
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: "arm64" | "x64";
  readonly packageName: string;
  readonly binaryName: "vec0.dll" | "vec0.dylib" | "vec0.so";
  readonly packageRelativePath: string;
  readonly binaryRelativePath: string;
}

/** Converts electron-builder 26's pinned Arch enum (or a test string) without accepting universal/32-bit artifacts. */
export function sqliteVecElectronBuilderArchitecture(value: unknown): "arm64" | "x64" {
  if (value === 1 || value === "x64") return "x64";
  if (value === 3 || value === "arm64") return "arm64";
  throw new Error(`sqlite-vec does not support the electron-builder target architecture ${String(value)}.`);
}

/**
 * Maps an Electron target to sqlite-vec's platform-specific optional package.
 * Unsupported targets are rejected deliberately: a build without the exact
 * native package must never silently ship keyword-only search.
 */
export function sqliteVecRuntimeTarget(platform: string, arch: string): SqliteVecRuntimeTarget {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new Error(`sqlite-vec does not support the Desktop target platform ${platform}.`);
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`sqlite-vec does not support the Desktop target architecture ${arch}.`);
  }
  if (platform === "win32" && arch === "arm64") {
    throw new Error("sqlite-vec 0.1.9 does not publish a Windows arm64 native package.");
  }
  const packagePlatform = platform === "win32" ? "windows" : platform;
  const binaryName = platform === "win32" ? "vec0.dll" : platform === "darwin" ? "vec0.dylib" : "vec0.so";
  const packageName = `sqlite-vec-${packagePlatform}-${arch}`;
  const packageRelativePath = join("node_modules", packageName);
  return {
    platform,
    arch,
    packageName,
    binaryName,
    packageRelativePath,
    binaryRelativePath: join(packageRelativePath, binaryName)
  };
}

/**
 * Produces a self-contained Electron-Node probe. The probe resolves every
 * sqlite-vec input from the supplied staged/packaged runtime root, validates
 * canonical containment, and exercises the native vec0 implementation.
 */
export function sqliteVecElectronSmokeSource(platform: string, arch: string): string {
  const target = sqliteVecRuntimeTarget(platform, arch);
  return [
    'import { lstat, readFile, realpath } from "node:fs/promises";',
    'import { createRequire } from "node:module";',
    'import { DatabaseSync } from "node:sqlite";',
    'import { isAbsolute, relative, resolve, sep } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    `const expected = ${JSON.stringify(target)};`,
    'if (process.platform !== expected.platform || process.arch !== expected.arch) {',
    '  throw new Error(`Electron-Node target mismatch: expected ${expected.platform}-${expected.arch}, received ${process.platform}-${process.arch}.`);',
    '}',
    'if (typeof process.versions.electron !== "string" || process.versions.electron === "") {',
    '  throw new Error("sqlite-vec native smoke must run under Electron-Node.");',
    '}',
    'const runtimeArgument = process.argv[2];',
    'if (typeof runtimeArgument !== "string" || runtimeArgument === "" || !isAbsolute(runtimeArgument) || resolve(runtimeArgument) !== runtimeArgument) {',
    '  throw new Error("sqlite-vec smoke requires one normalized absolute runtime root.");',
    '}',
    'const runtimeRoot = await canonicalDirectory(runtimeArgument, "runtime root");',
    'const runtimeManifestPath = await canonicalRegularFile(runtimeRoot, resolve(runtimeRoot, "package.json"), "runtime package manifest");',
    'const runtimeRequire = createRequire(runtimeManifestPath);',
    'const sqlitePackageRoot = resolve(runtimeRoot, "node_modules", "sqlite-vec");',
    'const sqliteManifestPath = await canonicalRegularFile(runtimeRoot, resolve(sqlitePackageRoot, "package.json"), "sqlite-vec package manifest");',
    'const sqliteManifest = parseManifest(await readFile(sqliteManifestPath, "utf8"), "sqlite-vec");',
    'if (sqliteManifest.name !== "sqlite-vec" || typeof sqliteManifest.version !== "string" || sqliteManifest.version === "") {',
    '  throw new Error("The sqlite-vec package identity is invalid.");',
    '}',
    'if (sqliteManifest.optionalDependencies?.[expected.packageName] !== sqliteManifest.version) {',
    '  throw new Error("The sqlite-vec manifest does not pin the required native package generation.");',
    '}',
    'const commonJsEntry = await canonicalRegularFile(runtimeRoot, runtimeRequire.resolve("sqlite-vec"), "sqlite-vec CommonJS entry");',
    'const expectedCommonJsEntry = await canonicalRegularFile(runtimeRoot, resolve(sqlitePackageRoot, manifestRelativeTarget(sqliteManifest.main, "sqlite-vec main")), "sqlite-vec declared CommonJS entry");',
    'if (!samePath(commonJsEntry, expectedCommonJsEntry)) throw new Error("sqlite-vec CommonJS resolution did not match its manifest.");',
    'const importTarget = sqliteManifest.exports?.["."]?.import;',
    'const moduleEntry = await canonicalRegularFile(runtimeRoot, resolve(sqlitePackageRoot, manifestRelativeTarget(importTarget, "sqlite-vec import export")), "sqlite-vec ESM entry");',
    'const nativePackageRoot = resolve(runtimeRoot, expected.packageRelativePath);',
    'const nativeManifestPath = await canonicalRegularFile(runtimeRoot, resolve(nativePackageRoot, "package.json"), "sqlite-vec native package manifest");',
    'const nativeManifest = parseManifest(await readFile(nativeManifestPath, "utf8"), expected.packageName);',
    'if (nativeManifest.name !== expected.packageName || nativeManifest.version !== sqliteManifest.version) {',
    '  throw new Error("The sqlite-vec JS and native package identities do not match.");',
    '}',
    'if (!Array.isArray(nativeManifest.os) || !nativeManifest.os.includes(expected.platform) ||',
    '    !Array.isArray(nativeManifest.cpu) || !nativeManifest.cpu.includes(expected.arch)) {',
    '  throw new Error("The sqlite-vec native package metadata does not match the Electron target.");',
    '}',
    'if (nativeManifest.exports?.[`./${expected.binaryName}`]?.default !== `./${expected.binaryName}`) {',
    '  throw new Error("The sqlite-vec native package does not export the expected binary.");',
    '}',
    'const expectedBinary = await canonicalRegularFile(runtimeRoot, resolve(runtimeRoot, expected.binaryRelativePath), "sqlite-vec native binary");',
    'const resolvedBinary = await canonicalRegularFile(runtimeRoot, runtimeRequire.resolve(`${expected.packageName}/${expected.binaryName}`), "resolved sqlite-vec native binary");',
    'if (!samePath(expectedBinary, resolvedBinary)) throw new Error("sqlite-vec native resolution selected an unexpected binary.");',
    'const sqliteVec = await import(pathToFileURL(moduleEntry).href);',
    'if (typeof sqliteVec.load !== "function" || typeof sqliteVec.getLoadablePath !== "function") {',
    '  throw new Error("The sqlite-vec ESM entry does not expose the required API.");',
    '}',
    'const moduleBinary = await canonicalRegularFile(runtimeRoot, sqliteVec.getLoadablePath(), "sqlite-vec module-selected binary");',
    'if (!samePath(moduleBinary, expectedBinary)) throw new Error("sqlite-vec selected a native binary outside the target package.");',
    'const database = new DatabaseSync(":memory:", { allowExtension: true });',
    'let version;',
    'try {',
    '  sqliteVec.load(database);',
    '  database.enableLoadExtension(false);',
    '  version = database.prepare("SELECT vec_version() AS version").get()?.version;',
    '  if (version !== `v${sqliteManifest.version}`) throw new Error(`Unexpected sqlite-vec extension version: ${String(version)}.`);',
    '  database.exec("CREATE VIRTUAL TABLE vector_smoke USING vec0(document_id INTEGER, live INTEGER, embedding float[3] distance_metric=cosine)");',
    '  const bytes = (values) => new Uint8Array(Float32Array.from(values).buffer);',
    '  const insert = database.prepare("INSERT INTO vector_smoke(rowid, document_id, live, embedding) VALUES (?, ?, ?, ?)");',
    '  insert.run(1n, 101n, 1n, bytes([1, 0, 0]));',
    '  insert.run(2n, 202n, 1n, bytes([0, 1, 0]));',
    '  const knn = database.prepare("SELECT rowid, document_id, live, distance FROM vector_smoke WHERE embedding MATCH ? AND k = ? AND live = 1 ORDER BY distance");',
    '  const before = knn.all(bytes([1, 0, 0]), 2n);',
    '  if (before.length !== 2 || before[0]?.rowid !== 1 || before[0]?.document_id !== 101 || before[0]?.live !== 1 || before[0]?.distance !== 0) {',
    '    throw new Error("sqlite-vec insert/KNN smoke returned an invalid nearest neighbor.");',
    '  }',
    '  const tombstone = database.prepare("UPDATE vector_smoke SET live = 0 WHERE rowid = ?").run(1n);',
    '  if (tombstone.changes !== 1) throw new Error("sqlite-vec metadata tombstone did not update exactly one row.");',
    '  const after = knn.all(bytes([1, 0, 0]), 2n);',
    '  if (after.length !== 1 || after[0]?.rowid !== 2 || after[0]?.document_id !== 202 || after[0]?.live !== 1) {',
    '    throw new Error("sqlite-vec KNN did not honor the metadata tombstone.");',
    '  }',
    '} finally {',
    '  database.close();',
    '}',
    'process.stdout.write(JSON.stringify({ ok: true, runtimeRoot, moduleEntry, nativePackageRoot, nativeBinary: expectedBinary, version, electronVersion: process.versions.electron, nodeVersion: process.versions.node }));',
    '',
    'async function canonicalDirectory(path, label) {',
    '  const normalized = resolve(path);',
    '  const info = await lstat(normalized);',
    '  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`The ${label} is not a regular directory.`);',
    '  const canonical = await realpath(normalized);',
    '  if (!samePath(canonical, normalized)) throw new Error(`The ${label} is not canonical.`);',
    '  return canonical;',
    '}',
    'async function canonicalRegularFile(root, path, label) {',
    '  const normalized = resolve(path);',
    '  assertContained(root, normalized, label);',
    '  const info = await lstat(normalized);',
    '  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`The ${label} is not a regular file.`);',
    '  const canonical = await realpath(normalized);',
    '  assertContained(root, canonical, label);',
    '  if (!samePath(canonical, normalized)) throw new Error(`The ${label} is not canonical.`);',
    '  return canonical;',
    '}',
    'function assertContained(root, candidate, label) {',
    '  const suffix = relative(root, candidate);',
    '  if (suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))) return;',
    '  throw new Error(`The ${label} escapes the packaged Orchestrator runtime.`);',
    '}',
    'function manifestRelativeTarget(value, label) {',
    '  if (typeof value !== "string" || !value.startsWith("./") || value.includes("\\0")) throw new Error(`The ${label} is invalid.`);',
    '  return value;',
    '}',
    'function parseManifest(source, label) {',
    '  try { return JSON.parse(source); } catch { throw new Error(`The ${label} manifest is invalid JSON.`); }',
    '}',
    'function samePath(left, right) {',
    '  return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);',
    '}'
  ].join("\n");
}

export interface RuntimeTreeLimits {
  readonly maximumFiles?: number;
  readonly maximumBytes?: number;
}

export interface RuntimeTreeAudit {
  readonly files: number;
  readonly bytes: number;
}

export function runtimeBuildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
    "TEMP", "TMP", "TMPDIR", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"
  ]);
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    NO_UPDATE_NOTIFIER: "1",
    PNPM_DISABLE_SELF_UPDATE_CHECK: "1"
  };
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(name)) environment[name] = value;
  }
  return environment;
}

export function runtimeExecutablePath(value: string | undefined, forbiddenRoots: readonly string[]): string {
  if (value === undefined) return "";
  const canonicalForbiddenRoots = forbiddenRoots.map((root) => resolve(root));
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const rawEntry of value.split(delimiter)) {
    const entry = rawEntry.trim();
    if (entry === "" || !isAbsolute(entry)) continue;
    const normalized = resolve(entry);
    if (canonicalForbiddenRoots.some((root) => pathContained(root, normalized))) continue;
    const identity = pathIdentity(normalized);
    if (seen.has(identity)) continue;
    seen.add(identity);
    entries.push(normalized);
  }
  return entries.join(delimiter);
}

export function rewriteRuntimePackageManifest(value: unknown, expectedName: string): Record<string, unknown> {
  if (!isRecord(value) || value["name"] !== expectedName || !expectedName.startsWith("@joko/")) {
    throw new Error(`Unexpected runtime workspace package manifest for ${expectedName}.`);
  }
  const rewritten = structuredClone(value);
  if ("exports" in rewritten) rewritten["exports"] = rewriteExportTarget(rewritten["exports"]);
  assertNoSourceExport(rewritten["exports"]);
  return rewritten;
}

export async function rewriteRuntimePackageManifestFile(path: string, expectedName: string): Promise<void> {
  const bytes = await readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    bytes.fill(0);
  }
  const rewritten = Buffer.from(`${JSON.stringify(rewriteRuntimePackageManifest(parsed, expectedName), null, 2)}\n`, "utf8");
  try {
    await writeFile(path, rewritten, { encoding: "utf8", mode: 0o644, flag: "w" });
  } finally {
    rewritten.fill(0);
  }
}

export async function digestFile(path: string): Promise<string | undefined> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Workspace-state path is unsafe: ${path}`);
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function auditRegularRuntimeTree(root: string, limits: RuntimeTreeLimits = {}): Promise<RuntimeTreeAudit> {
  const canonicalRoot = await assertCanonicalDirectory(root);
  const maximumFiles = limits.maximumFiles ?? ORCHESTRATOR_RUNTIME_MAXIMUM_FILES;
  const maximumBytes = limits.maximumBytes ?? ORCHESTRATOR_RUNTIME_MAXIMUM_BYTES;
  let files = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      validateEntryName(entry.name);
      const path = join(directory, entry.name);
      assertContained(canonicalRoot, path);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Orchestrator runtime contains a symlink or junction: ${path}`);
      if (info.isDirectory()) {
        const canonical = await realpath(path);
        assertContained(canonicalRoot, canonical);
        if (!samePath(canonical, path)) throw new Error(`Orchestrator runtime directory is an alias or reparse point: ${path}`);
        await visit(path);
        continue;
      }
      if (!info.isFile()) throw new Error(`Orchestrator runtime contains a special file: ${path}`);
      const canonical = await realpath(path);
      assertContained(canonicalRoot, canonical);
      if (!samePath(canonical, path)) throw new Error(`Orchestrator runtime file is an alias: ${path}`);
      files += 1;
      bytes += info.size;
      if (files > maximumFiles) throw new Error("Orchestrator runtime exceeds the file-count limit.");
      if (bytes > maximumBytes) throw new Error("Orchestrator runtime exceeds the byte-size limit.");
    }
  };
  await visit(canonicalRoot);
  return { files, bytes };
}

export async function copyRegularTree(
  sourceRoot: string,
  destinationRoot: string,
  options: {
    readonly limits?: RuntimeTreeLimits;
    readonly skip?: (relativePath: string) => boolean;
    readonly allowContainedLinks?: boolean;
  } = {}
): Promise<RuntimeTreeAudit> {
  const canonicalSource = await assertCanonicalDirectory(sourceRoot);
  const destination = resolve(destinationRoot);
  if (!isAbsolute(destinationRoot) || destination !== destinationRoot || samePath(canonicalSource, destination)) {
    throw new Error("Orchestrator runtime copy destination must be a distinct normalized absolute path.");
  }
  await mkdir(destination, { recursive: false, mode: 0o755 });
  const maximumFiles = options.limits?.maximumFiles ?? ORCHESTRATOR_RUNTIME_MAXIMUM_FILES;
  const maximumBytes = options.limits?.maximumBytes ?? ORCHESTRATOR_RUNTIME_MAXIMUM_BYTES;
  let files = 0;
  let bytes = 0;
  const ancestors = new Set<string>();

  const copyDirectory = async (sourceDirectory: string, destinationDirectory: string, logicalPrefix: string): Promise<void> => {
    const canonicalDirectory = await realpath(sourceDirectory);
    assertContained(canonicalSource, canonicalDirectory);
    const identity = pathIdentity(canonicalDirectory);
    if (ancestors.has(identity)) throw new Error(`Orchestrator runtime source contains a directory-link cycle: ${sourceDirectory}`);
    ancestors.add(identity);
    try {
      const entries = await readdir(sourceDirectory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        validateEntryName(entry.name);
        const logicalPath = logicalPrefix === "" ? entry.name : `${logicalPrefix}/${entry.name}`;
        if (options.skip?.(logicalPath) === true) continue;
        const sourcePath = join(sourceDirectory, entry.name);
        const destinationPath = join(destinationDirectory, entry.name);
        const linkInfo = await lstat(sourcePath);
        let effectivePath = sourcePath;
        let info = linkInfo;
        if (linkInfo.isSymbolicLink()) {
          if (options.allowContainedLinks !== true) throw new Error(`Orchestrator runtime source contains a symlink or junction: ${sourcePath}`);
          effectivePath = await realpath(sourcePath);
          assertContained(canonicalSource, effectivePath);
          info = await stat(effectivePath);
        } else {
          const canonical = await realpath(sourcePath);
          assertContained(canonicalSource, canonical);
          if (!samePath(canonical, sourcePath)) throw new Error(`Orchestrator runtime source contains an alias or reparse point: ${sourcePath}`);
        }
        if (info.isDirectory()) {
          await mkdir(destinationPath, { recursive: false, mode: 0o755 });
          await copyDirectory(effectivePath, destinationPath, logicalPath);
          continue;
        }
        if (!info.isFile()) throw new Error(`Orchestrator runtime source contains a special file: ${sourcePath}`);
        files += 1;
        bytes += info.size;
        if (files > maximumFiles) throw new Error("Orchestrator runtime exceeds the file-count limit while copying.");
        if (bytes > maximumBytes) throw new Error("Orchestrator runtime exceeds the byte-size limit while copying.");
        await copyFile(effectivePath, destinationPath, constants.COPYFILE_EXCL);
        await chmod(destinationPath, info.mode & 0o777);
      }
    } finally {
      ancestors.delete(identity);
    }
  };

  try {
    await copyDirectory(canonicalSource, destination, "");
    return { files, bytes };
  } catch (error) {
    await removeCreatedDirectory(destination);
    throw error;
  }
}

export async function replaceDirectoryFromPrepared(preparedRoot: string, destinationRoot: string): Promise<void> {
  const prepared = await assertCanonicalDirectory(preparedRoot);
  const destination = resolve(destinationRoot);
  if (!isAbsolute(destinationRoot) || destination !== destinationRoot || dirname(prepared) !== dirname(destination)) {
    throw new Error("Prepared and destination runtime directories must be normalized siblings.");
  }
  if (!basename(prepared).startsWith(".orchestrator-runtime-stage-") || basename(destination) !== "orchestrator-runtime") {
    throw new Error("Orchestrator runtime publication paths do not have the required fixed names.");
  }
  const parent = dirname(destination);
  const backup = join(parent, `.orchestrator-runtime-backup-${randomUUID()}`);
  let backedUp = false;
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || !samePath(await realpath(destination), destination)) {
      throw new Error("Existing Orchestrator runtime stage is unsafe.");
    }
    await auditRegularRuntimeTree(destination);
    await rename(destination, backup);
    backedUp = true;
  }
  try {
    await rename(prepared, destination);
  } catch (error) {
    if (backedUp) await rename(backup, destination).catch(() => undefined);
    throw error;
  }
  if (backedUp) await removeSafeTemporaryDirectory(backup);
}

export async function removeSafeTemporaryDirectory(path: string): Promise<void> {
  const target = resolve(path);
  const name = basename(target);
  if (!name.startsWith(".orchestrator-runtime-") && !name.startsWith("joko-orchestrator-runtime-")) {
    throw new Error(`Refusing to remove an unrecognized runtime temporary directory: ${path}`);
  }
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return;
  if (info.isSymbolicLink()) {
    await unlink(target);
    return;
  }
  if (!info.isDirectory() || !samePath(await realpath(target), target)) {
    throw new Error(`Runtime temporary path is unsafe: ${path}`);
  }
  await rm(target, { recursive: true, force: false });
}

export function assertContained(root: string, candidate: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const suffix = relative(normalizedRoot, normalizedCandidate);
  if (suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))) return;
  throw new Error(`Path escapes the Orchestrator runtime root: ${candidate}`);
}

function pathContained(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate));
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}

function rewriteExportTarget(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^\.\/src\/.+\.tsx?$/u.test(value)) return value.replace(/^\.\/src\//u, "./dist/").replace(/\.tsx?$/u, ".js");
    if (/^\.\/src\/.+\.cts$/u.test(value)) return value.replace(/^\.\/src\//u, "./dist/").replace(/\.cts$/u, ".cjs");
    if (/^\.\/src\/.+\.mts$/u.test(value)) return value.replace(/^\.\/src\//u, "./dist/").replace(/\.mts$/u, ".mjs");
    return value;
  }
  if (Array.isArray(value)) return value.map(rewriteExportTarget);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, target]) => [key, rewriteExportTarget(target)]));
}

function assertNoSourceExport(value: unknown): void {
  if (typeof value === "string") {
    if (value.startsWith("./src/")) throw new Error("Runtime workspace package exports may not reference source TypeScript.");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSourceExport(item);
    return;
  }
  if (isRecord(value)) for (const item of Object.values(value)) assertNoSourceExport(item);
}

async function assertCanonicalDirectory(path: string): Promise<string> {
  const normalized = resolve(path);
  if (!isAbsolute(path) || normalized !== path) throw new Error(`Runtime directory must be a normalized absolute path: ${path}`);
  const info = await lstat(normalized);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Runtime path is not a regular directory: ${path}`);
  const canonical = await realpath(normalized);
  if (!samePath(canonical, normalized)) throw new Error(`Runtime directory is an alias or reparse point: ${path}`);
  return canonical;
}

function validateEntryName(name: string): void {
  if (name === "." || name === ".." || name.includes("\0") || /[\\/]/u.test(name)) {
    throw new Error("Orchestrator runtime contains an invalid path entry.");
  }
}

function samePath(left: string, right: string): boolean {
  return pathIdentity(left) === pathIdentity(right);
}

function pathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function removeCreatedDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return;
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new Error(`Created runtime destination was replaced with an unsafe path: ${path}`);
  }
  await rm(path, { recursive: true, force: false });
}
