import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

const MAXIMUM_WINDOWS_VERSION_ENTRIES = 128;
const MAXIMUM_WINDOWS_PATH_CHARACTERS = 32_768;
const WINDOWS_VERSION_DIRECTORY_NAME = /^[A-Za-z0-9._-]{1,128}$/u;

export interface CodexExecutableDirectoryEntry {
  readonly name: string;
  readonly directory: boolean;
  readonly symbolicLink: boolean;
}

export interface CodexExecutableFileInspection {
  readonly canonicalPath: string;
  readonly modifiedAtMs: number;
}

export interface CodexExecutableDiscoveryOptions {
  readonly platform?: NodeJS.Platform;
  readonly readDirectory?: (
    path: string,
    maximumEntries: number
  ) => readonly CodexExecutableDirectoryEntry[] | undefined;
  readonly canonicalizePath?: (path: string) => string | undefined;
  readonly isRegularDirectory?: (path: string) => boolean;
  readonly inspectRegularFile?: (path: string) => CodexExecutableFileInspection | undefined;
}

/** Resolve an owner override or the bounded Windows Desktop CLI installation. */
export function discoverCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  options: CodexExecutableDiscoveryOptions = {}
): string | undefined {
  const platform = options.platform ?? process.platform;
  const pathFlavor = platform === "win32" ? win32 : posix;
  const inspectFile = options.inspectRegularFile ?? inspectRegularFile;
  const explicit = environment.JOKO_CODEX_EXECUTABLE;
  if (explicit !== undefined) {
    if (!validAbsolutePath(explicit, pathFlavor)) throw invalidExplicitExecutable();
    const inspected = inspectFile(explicit);
    if (inspected === undefined || !validInspection(inspected, pathFlavor)) {
      throw invalidExplicitExecutable();
    }
    return inspected.canonicalPath;
  }
  if (platform !== "win32") return undefined;

  const localAppData = environment.LOCALAPPDATA;
  if (
    localAppData === undefined
    || localAppData === ""
    || !validAbsolutePath(localAppData, win32)
  ) return undefined;

  const binDirectory = win32.join(localAppData, "OpenAI", "Codex", "bin");
  const canonicalize = options.canonicalizePath ?? canonicalPath;
  const canonicalLocalAppData = canonicalize(localAppData);
  const canonicalBinDirectory = canonicalize(binDirectory);
  const isDirectory = options.isRegularDirectory ?? regularDirectory;
  if (
    canonicalLocalAppData === undefined
    || canonicalBinDirectory === undefined
    || !isDirectory(binDirectory)
    || !isStrictlyContained(canonicalLocalAppData, canonicalBinDirectory, win32)
  ) return undefined;
  const entries = (options.readDirectory ?? readBoundedDirectory)(
    binDirectory,
    MAXIMUM_WINDOWS_VERSION_ENTRIES
  );
  if (entries === undefined) return undefined;

  const versionNames = [...new Set(entries
    .filter((entry) => entry.directory
      && !entry.symbolicLink
      && WINDOWS_VERSION_DIRECTORY_NAME.test(entry.name))
    .map((entry) => entry.name))]
    .sort(codePointOrder);
  const candidates: CodexExecutableFileInspection[] = [];
  for (const versionName of versionNames) {
    const versionDirectory = win32.join(binDirectory, versionName);
    if (!isDirectory(versionDirectory)) continue;
    const canonicalVersionDirectory = canonicalize(versionDirectory);
    if (
      canonicalVersionDirectory === undefined
      || !isStrictlyContained(canonicalBinDirectory, canonicalVersionDirectory, win32)
    ) continue;
    const candidate = win32.join(versionDirectory, "codex.exe");
    const inspected = inspectFile(candidate);
    if (
      inspected === undefined
      || !validInspection(inspected, win32)
      || !isStrictlyContained(canonicalVersionDirectory, inspected.canonicalPath, win32)
    ) continue;
    candidates.push(inspected);
  }
  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs
    || codePointOrder(left.canonicalPath, right.canonicalPath));
  return candidates[0]?.canonicalPath;
}

function readBoundedDirectory(
  path: string,
  maximumEntries: number
): readonly CodexExecutableDirectoryEntry[] | undefined {
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    if (!regularDirectory(path)) return undefined;
    directory = opendirSync(path);
    const entries: CodexExecutableDirectoryEntry[] = [];
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) return entries;
      if (entries.length >= maximumEntries) return undefined;
      entries.push({
        name: entry.name,
        directory: entry.isDirectory(),
        symbolicLink: entry.isSymbolicLink()
      });
    }
  } catch {
    return undefined;
  } finally {
    try { directory?.closeSync(); } catch { /* The directory may already be closed. */ }
  }
}

function regularDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function inspectRegularFile(path: string): CodexExecutableFileInspection | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || !Number.isFinite(info.mtimeMs) || info.mtimeMs < 0) {
      return undefined;
    }
    return { canonicalPath: realpathSync.native(path), modifiedAtMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

function canonicalPath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function validAbsolutePath(value: string, flavor: typeof posix | typeof win32): boolean {
  return value !== ""
    && value.length <= MAXIMUM_WINDOWS_PATH_CHARACTERS
    && !value.includes("\0")
    && flavor.isAbsolute(value);
}

function validInspection(
  value: CodexExecutableFileInspection,
  flavor: typeof posix | typeof win32
): boolean {
  return validAbsolutePath(value.canonicalPath, flavor)
    && Number.isFinite(value.modifiedAtMs)
    && value.modifiedAtMs >= 0;
}

function isStrictlyContained(
  root: string,
  candidate: string,
  flavor: typeof posix | typeof win32
): boolean {
  const child = flavor.relative(root, candidate);
  return child !== ""
    && child !== ".."
    && !child.startsWith(`..${flavor.sep}`)
    && !flavor.isAbsolute(child);
}

function invalidExplicitExecutable(): Error {
  return new Error("JOKO_CODEX_EXECUTABLE must identify an absolute regular file without links.");
}

function codePointOrder(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
