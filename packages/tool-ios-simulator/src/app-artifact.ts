import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { createNodeSimulatorCommandRunner, type SimulatorCommandRunner } from "./environment.js";

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/u;
const EXECUTABLE = /^[^/\\\0\r\n]{1,255}$/u;
const MAX_ENTRIES = 100_000;

export class SimulatorAppArtifactError extends Error {
  constructor(readonly code: "APP_ARTIFACT_INVALID" | "APP_ARCH_MISMATCH" | "MUTATION_CANCELLED",
    message: string) { super(message); }
}

export interface SimulatorAppArtifactIdentity {
  readonly appPath: string;
  readonly bundleId: string;
  readonly executable: string;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SimulatorAppArtifactError("MUTATION_CANCELLED",
    "App artifact inspection was cancelled.");
}

/** Inspects an immutable copy, not mutable DerivedData, before publishing its handle. */
export async function inspectSimulatorAppArtifact(input: { readonly appPath: string;
  readonly authorizedRoot: string; readonly expectedArch: "arm64" | "x86_64";
  readonly signal?: AbortSignal; readonly runner?: SimulatorCommandRunner }):
  Promise<SimulatorAppArtifactIdentity> {
  const runner = input.runner ?? createNodeSimulatorCommandRunner();
  cancelled(input.signal);
  let root: string;
  let app: string;
  try { root = await realpath(input.authorizedRoot); app = await realpath(input.appPath); }
  catch { throw new SimulatorAppArtifactError("APP_ARTIFACT_INVALID", "Managed app artifact is unavailable."); }
  if (!inside(root, app) || extname(app) !== ".app" || !(await stat(app)).isDirectory()) {
    throw new SimulatorAppArtifactError("APP_ARTIFACT_INVALID", "App artifact escaped its managed root.");
  }
  const pending = [app];
  let count = 0;
  while (pending.length > 0) {
    cancelled(input.signal);
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    count += entries.length;
    if (count > MAX_ENTRIES) throw new SimulatorAppArtifactError("APP_ARTIFACT_INVALID",
      "App artifact entry count exceeds the inspection bound.");
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let resolved: string;
        try { resolved = await realpath(path); }
        catch { throw new SimulatorAppArtifactError("APP_ARTIFACT_INVALID", "App artifact contains a broken link."); }
        if (!inside(app, resolved)) throw new SimulatorAppArtifactError("APP_ARTIFACT_INVALID",
          "App artifact contains a link outside the app bundle.");
      } else if (entry.isDirectory()) pending.push(path);
      else if (!entry.isFile()) throw new SimulatorAppArtifactError("APP_ARTIFACT_INVALID",
        "App artifact contains an unsupported filesystem entry.");
    }
  }
  const plist = join(app, "Info.plist");
  if (!(await lstat(plist).catch(() => null))?.isFile()) throw new SimulatorAppArtifactError(
    "APP_ARTIFACT_INVALID", "App artifact has no regular Info.plist.");
  const read = async (key: string): Promise<string> => {
    cancelled(input.signal);
    const result = await runner.run("/usr/bin/plutil",
      ["-extract", key, "raw", "-o", "-", plist], { signal: input.signal, timeoutMs: 15_000 });
    cancelled(input.signal);
    if (result.exitCode !== 0 || result.failed || result.timedOut || result.aborted ||
        result.outputTruncated || result.stdout.length > 4_096) {
      throw new SimulatorAppArtifactError("APP_ARTIFACT_INVALID", "App artifact identity could not be read.");
    }
    return result.stdout.trim();
  };
  const bundleId = await read("CFBundleIdentifier");
  const executable = await read("CFBundleExecutable");
  if (!BUNDLE_ID.test(bundleId) || !EXECUTABLE.test(executable) || basename(executable) !== executable) {
    throw new SimulatorAppArtifactError("APP_ARTIFACT_INVALID", "App artifact identity is invalid.");
  }
  const executablePath = join(app, executable);
  if (!(await lstat(executablePath).catch(() => null))?.isFile()) {
    throw new SimulatorAppArtifactError("APP_ARTIFACT_INVALID", "App executable is unavailable.");
  }
  cancelled(input.signal);
  const platforms = await runner.run("/usr/bin/plutil",
    ["-extract", "CFBundleSupportedPlatforms", "json", "-o", "-", plist],
    { signal: input.signal, timeoutMs: 15_000 });
  cancelled(input.signal);
  let simulatorPlatform = false;
  try { const parsed: unknown = JSON.parse(platforms.stdout);
    simulatorPlatform = Array.isArray(parsed) && parsed.includes("iPhoneSimulator"); }
  catch { /* invalid platform list */ }
  if (platforms.exitCode !== 0 || platforms.failed || platforms.timedOut ||
      platforms.aborted || platforms.outputTruncated || !simulatorPlatform) {
    throw new SimulatorAppArtifactError("APP_ARTIFACT_INVALID", "App is not an iOS Simulator build.");
  }
  cancelled(input.signal);
  const architectures = await runner.run("/usr/bin/lipo", ["-archs", executablePath],
    { signal: input.signal, timeoutMs: 15_000 });
  cancelled(input.signal);
  if (architectures.exitCode !== 0 || architectures.failed || architectures.timedOut ||
      architectures.aborted || architectures.outputTruncated) {
    throw new SimulatorAppArtifactError("APP_ARTIFACT_INVALID", "App executable architecture could not be read.");
  }
  if (!architectures.stdout.trim().split(/\s+/u).includes(input.expectedArch)) {
    throw new SimulatorAppArtifactError("APP_ARCH_MISMATCH", "App executable cannot run on this Simulator host architecture.");
  }
  return { appPath: app, bundleId, executable };
}
