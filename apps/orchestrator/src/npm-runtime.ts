import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const runtimeRequire = createRequire(import.meta.url);

export const BUNDLED_NPM_RUNTIME_VERSION = "11.13.0";
export const BUNDLED_NPM_CLI_TARGET = "bin/npm-cli.js";

export interface BundledNpmRuntime {
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly cliPath: string;
  readonly version: string;
}

/** Resolves and authenticates the npm CLI carried by the Orchestrator production closure. */
export async function resolveBundledNpmRuntime(): Promise<BundledNpmRuntime> {
  let unresolvedManifestPath: string;
  try {
    unresolvedManifestPath = runtimeRequire.resolve("npm/package.json");
  } catch {
    throw new Error("Npm package acquisition runtime is unavailable.");
  }
  const manifestPath = await canonicalRegularFile(unresolvedManifestPath, "Npm runtime manifest");
  const packageRoot = await realpath(dirname(manifestPath));
  const manifest = await readNpmManifest(manifestPath);
  const cliTarget = npmCliTarget(manifest);
  if (manifest.version !== BUNDLED_NPM_RUNTIME_VERSION || cliTarget !== BUNDLED_NPM_CLI_TARGET) {
    throw new Error("Npm package acquisition runtime is invalid.");
  }
  const cliPath = await canonicalRegularFile(resolve(packageRoot, ...cliTarget.split("/")), "Npm runtime CLI");
  assertContained(packageRoot, cliPath);
  return {
    packageRoot,
    manifestPath,
    cliPath,
    version: manifest.version
  };
}

/** Ensures an Electron executable remains in Node mode when it launches the bundled CLI. */
export function nodeExecutableEnvironment(
  environment: NodeJS.ProcessEnv,
  electronVersion: string | undefined = typeof process.versions.electron === "string"
    ? process.versions.electron
    : undefined
): NodeJS.ProcessEnv {
  const isolated = { ...environment };
  delete isolated.ELECTRON_RUN_AS_NODE;
  if (electronVersion !== undefined && electronVersion !== "") isolated.ELECTRON_RUN_AS_NODE = "1";
  return isolated;
}

async function readNpmManifest(path: string): Promise<{ readonly version: string; readonly bin: unknown }> {
  const info = await lstat(path);
  if (info.size > 1024 * 1024) throw new Error("Npm package acquisition runtime is invalid.");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Npm package acquisition runtime is invalid.");
  }
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    (value as { readonly name?: unknown }).name !== "npm" ||
    typeof (value as { readonly version?: unknown }).version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test((value as { readonly version: string }).version)
  ) throw new Error("Npm package acquisition runtime is invalid.");
  return value as { readonly version: string; readonly bin: unknown };
}

function npmCliTarget(manifest: { readonly bin: unknown }): string {
  const value = typeof manifest.bin === "object" && manifest.bin !== null && !Array.isArray(manifest.bin)
    ? (manifest.bin as { readonly npm?: unknown }).npm
    : undefined;
  if (
    typeof value !== "string" || value === "" || value.includes("\\") || value.includes("\0") ||
    isAbsolute(value) || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new Error("Npm package acquisition runtime is invalid.");
  return value;
}

async function canonicalRegularFile(path: string, label: string): Promise<string> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is unavailable.`);
  const canonical = await realpath(path);
  const canonicalInfo = await lstat(canonical);
  if (!canonicalInfo.isFile() || canonicalInfo.isSymbolicLink()) throw new Error(`${label} is unavailable.`);
  return canonical;
}

function assertContained(root: string, candidate: string): void {
  const suffix = relative(root, candidate);
  if (suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))) return;
  throw new Error("Npm package acquisition runtime escaped its package root.");
}
