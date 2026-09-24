import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, realpath, rm, stat } from "node:fs/promises";
import { arch, platform as hostPlatform } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createWdaChildEnvironment } from "./wda-build-plan.js";

const XCODEBUILD = "/usr/bin/xcodebuild";
const XCRUN = "/usr/bin/xcrun";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const PRODUCT_TYPE = "com.apple.product-type.application";
const PIN = "-onlyUsePackageVersionsFromResolvedFile";
const MAX_LOG = 32 * 1024;

export type SimulatorProjectBuildErrorCode = "UNSUPPORTED_PLATFORM" | "INVALID_ARGUMENT" |
  "PROJECT_NOT_FOUND" | "AMBIGUOUS_XCODE_PROJECT" | "APP_ARCH_MISMATCH" |
  "APP_BUILD_FAILED" | "APP_ARTIFACT_INVALID" | "MUTATION_CANCELLED" | "BUILD_OUTCOME_UNKNOWN";

export class SimulatorProjectBuildError extends Error {
  constructor(readonly code: SimulatorProjectBuildErrorCode, message: string,
    readonly buildLogTail = "", readonly resultBundlePath: string | null = null,
    readonly outputTruncated = false) { super(message); }
}

export interface SimulatorProjectDescriptor {
  readonly kind: "xcode-workspace" | "xcode-project";
  readonly worktreeRoot: string;
  readonly projectRoot: string;
  readonly containerPath: string;
}

export interface SimulatorProjectBuildResult extends SimulatorProjectDescriptor {
  readonly scheme: string;
  readonly appPath: string;
  readonly resultBundlePath: string | null;
  readonly buildLogTail: string;
  readonly outputTruncated: boolean;
}

export interface SimulatorBuildCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  readonly outputTruncated?: boolean;
  readonly failed?: boolean;
}

export interface SimulatorBuildCommandRunner {
  run(command: string, args: readonly string[], options: { readonly cwd?: string;
    readonly timeoutMs: number; readonly maxBufferBytes: number;
    readonly signal?: AbortSignal }): Promise<SimulatorBuildCommandResult>;
}

/** Dedicated bounded runner: project builds are deliberately longer than simctl probes. */
export function createNodeSimulatorBuildCommandRunner(
  hostEnvironment: Readonly<NodeJS.ProcessEnv> = process.env): SimulatorBuildCommandRunner {
  const childEnvironment = createWdaChildEnvironment(hostEnvironment);
  return { run(command, args, options) {
    const { timeoutMs, maxBufferBytes, signal } = options;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000 ||
        !Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 1 || maxBufferBytes > 4 * 1024 * 1024) {
      throw new RangeError("Simulator build process budget is invalid.");
    }
    if (signal?.aborted) return Promise.resolve({ stdout: "", stderr: "", exitCode: null, aborted: true });
    return new Promise<SimulatorBuildCommandResult>(resolveResult => {
      let child: ChildProcess;
      try { child = spawn(command, [...args], { cwd: options.cwd, env: childEnvironment,
        shell: false, windowsHide: true,
        detached: hostPlatform() === "darwin", stdio: ["ignore", "pipe", "pipe"] }); }
      catch { resolveResult({ stdout: "", stderr: "", exitCode: null, failed: true }); return; }
      const chunks: Array<{ readonly stream: "stdout" | "stderr"; bytes: Buffer }> = [];
      let bytes = 0;
      let timedOut = false;
      let aborted = false;
      let outputTruncated = false;
      let failed = false;
      let settled = false;
      let stopping = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        signal?.removeEventListener("abort", onAbort);
        resolveResult({ stdout: Buffer.concat(chunks.filter(item => item.stream === "stdout")
          .map(item => item.bytes)).toString("utf8"),
          stderr: Buffer.concat(chunks.filter(item => item.stream === "stderr")
            .map(item => item.bytes)).toString("utf8"), exitCode,
          timedOut, aborted, outputTruncated, failed });
      };
      const stop = (): void => {
        if (stopping || settled) return;
        stopping = true;
        clearTimeout(timer);
        if (hostPlatform() === "darwin" && child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
        } else {
          try { child.kill("SIGKILL"); } catch { /* already exited */ }
        }
        forceTimer = setTimeout(() => {
          if (hostPlatform() === "darwin" && child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
          }
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          finish(null);
        }, 1_000);
      };
      const groupAlive = (): boolean => {
        if (hostPlatform() !== "darwin" || !child.pid) return false;
        try { process.kill(-child.pid, 0); return true; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
      };
      const onAbort = (): void => { aborted = true; stop(); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        if (settled || stopping) return;
        bytes += chunk.length;
        chunks.push({ stream, bytes: Buffer.from(chunk) });
        while (bytes > maxBufferBytes) {
          outputTruncated = true;
          const first = chunks[0];
          if (!first) break;
          const excess = bytes - maxBufferBytes;
          if (first.bytes.length <= excess) {
            chunks.shift();
            bytes -= first.bytes.length;
          } else {
            first.bytes = first.bytes.subarray(excess);
            bytes -= excess;
          }
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("error", () => { failed = true; if (!stopping) finish(null); });
      child.once("close", code => { if (stopping && groupAlive()) return; finish(code); });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  } };
}

function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function isContainer(path: string): boolean {
  return extname(path) === ".xcworkspace" || extname(path) === ".xcodeproj";
}

async function containersIn(directory: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return []; }
  return entries.filter(entry => entry.isDirectory() && isContainer(entry.name) &&
    entry.name !== "Pods.xcodeproj" && entry.name !== "project.xcworkspace")
    .map(entry => join(directory, entry.name));
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SimulatorProjectBuildError("MUTATION_CANCELLED", "Simulator build was cancelled before dispatch.");
}

function resultProblem(result: SimulatorBuildCommandResult, signal?: AbortSignal): void {
  if (signal?.aborted || result.aborted || result.timedOut || result.failed) {
    throw new SimulatorProjectBuildError("BUILD_OUTCOME_UNKNOWN",
      "Simulator build process outcome is unknown; inspect diagnostics before another build.",
      logTail([result]), null, Boolean(result.outputTruncated));
  }
}

function logTail(results: readonly SimulatorBuildCommandResult[]): string {
  const text = results.map(result => `${result.stdout}\n${result.stderr}`).join("\n");
  const bytes = Buffer.from(text, "utf8");
  const marker = results.some(result => result.outputTruncated)
    ? "[Earlier command output was omitted after the capture limit was reached.]\n" : "";
  return marker + bytes.subarray(-Math.max(0, MAX_LOG - Buffer.byteLength(marker))).toString("utf8");
}

function missingResolvedFile(result: SimulatorBuildCommandResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`;
  return text.split(/\r?\n/u).some(line => /\bPackage\.resolved\b/iu.test(line) &&
    /\b(missing|does not exist|could(?:n\x27t| not) be opened|unable to read|no such file|unable to load the resolved file)\b/iu.test(line)) ||
    /a resolved file is required when automatic dependency resolution is disabled and should be placed at .*?Package\.resolved/iu.test(text.replace(/\s+/gu, " "));
}

function primaryAppSettings(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const entries = parsed.flatMap(entry => {
    const settings = entry && typeof entry === "object" ? (entry as Record<string, unknown>)["buildSettings"] : null;
    return settings && typeof settings === "object" && !Array.isArray(settings)
      ? [settings as Record<string, unknown>] : [];
  });
  const typed = entries.filter(settings => typeof settings["PRODUCT_TYPE"] === "string");
  const apps = typed.length > 0 ? typed.filter(settings => settings["PRODUCT_TYPE"] === PRODUCT_TYPE)
    : entries.filter(settings => typeof settings["WRAPPER_NAME"] === "string" &&
      String(settings["WRAPPER_NAME"]).endsWith(".app"));
  return apps.length === 1 ? apps[0]! : null;
}

function summarize(values: readonly string[]): string {
  return values.slice(0, 8).map(value => JSON.stringify(value.slice(0, 256))).join(", ") +
    (values.length > 8 ? `, and ${values.length - 8} more` : "");
}

export class SimulatorProjectBuilder {
  readonly #runner: SimulatorBuildCommandRunner;
  readonly #platform: NodeJS.Platform;
  readonly #buildTimeoutMs: number;
  readonly #inspectionTimeoutMs: number;

  constructor(options: { readonly runner?: SimulatorBuildCommandRunner;
    readonly platform?: NodeJS.Platform; readonly buildTimeoutMs?: number;
    readonly inspectionTimeoutMs?: number } = {}) {
    this.#runner = options.runner ?? createNodeSimulatorBuildCommandRunner();
    this.#platform = options.platform ?? process.platform;
    this.#buildTimeoutMs = options.buildTimeoutMs ?? 30 * 60_000;
    this.#inspectionTimeoutMs = options.inspectionTimeoutMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.#buildTimeoutMs) || this.#buildTimeoutMs < 1 ||
        this.#buildTimeoutMs > 30 * 60_000 || !Number.isSafeInteger(this.#inspectionTimeoutMs) ||
        this.#inspectionTimeoutMs < 1 || this.#inspectionTimeoutMs > 5 * 60_000) {
      throw new RangeError("Simulator project build timeout is invalid.");
    }
  }

  async inspect(worktreeRoot: string, explicitContainerPath?: string): Promise<SimulatorProjectDescriptor> {
    if (this.#platform !== "darwin") throw new SimulatorProjectBuildError("UNSUPPORTED_PLATFORM", "iOS Simulator requires a local macOS host.");
    let root: string;
    try { root = await realpath(worktreeRoot); }
    catch { throw new SimulatorProjectBuildError("PROJECT_NOT_FOUND", "The current worktree is unavailable."); }
    let containerPath: string;
    if (explicitContainerPath !== undefined) {
      if (!explicitContainerPath.trim() || explicitContainerPath.length > 4_096 ||
          !isContainer(explicitContainerPath)) {
        throw new SimulatorProjectBuildError("INVALID_ARGUMENT", "Xcode container path is invalid.");
      }
      try { containerPath = await realpath(isAbsolute(explicitContainerPath)
        ? explicitContainerPath : resolve(root, explicitContainerPath)); }
      catch { throw new SimulatorProjectBuildError("PROJECT_NOT_FOUND", "Selected Xcode container does not exist."); }
    } else {
      const candidates = [...await containersIn(root), ...await containersIn(join(root, "ios"))];
      const workspaces = candidates.filter(path => extname(path) === ".xcworkspace");
      const preferred = workspaces.length > 0 ? workspaces : candidates;
      if (preferred.length === 0) throw new SimulatorProjectBuildError("PROJECT_NOT_FOUND",
        "No Xcode container was found at the worktree or its ios directory.");
      if (preferred.length !== 1) throw new SimulatorProjectBuildError("AMBIGUOUS_XCODE_PROJECT",
        `Select one Xcode container explicitly: ${summarize(preferred.map(path => relative(root, path)))}.`);
      containerPath = await realpath(preferred[0]!);
    }
    let directory = false;
    try { directory = (await stat(containerPath)).isDirectory(); } catch { /* fail closed below */ }
    if (!inside(root, containerPath) || !isContainer(containerPath) || !directory) {
      throw new SimulatorProjectBuildError("INVALID_ARGUMENT", "Xcode container must be a directory inside this worktree.");
    }
    return { kind: extname(containerPath) === ".xcworkspace" ? "xcode-workspace" : "xcode-project",
      worktreeRoot: root, projectRoot: dirname(containerPath), containerPath };
  }

  async build(input: { readonly worktreeRoot: string; readonly derivedDataPath: string;
    readonly simulatorUdid: string; readonly containerPath?: string; readonly scheme?: string;
    readonly expectedArch?: "arm64" | "x86_64"; readonly signal?: AbortSignal }): Promise<SimulatorProjectBuildResult> {
    cancelled(input.signal);
    if (!UUID.test(input.simulatorUdid) || input.scheme !== undefined &&
        (!input.scheme.trim() || input.scheme.length > 256 || /[\0\r\n]/u.test(input.scheme))) {
      throw new SimulatorProjectBuildError("INVALID_ARGUMENT", "Simulator build arguments are invalid.");
    }
    const project = await this.inspect(input.worktreeRoot, input.containerPath);
    cancelled(input.signal);
    const flag = project.kind === "xcode-workspace" ? "-workspace" : "-project";
    const run = async (args: readonly string[], timeoutMs: number, maxBufferBytes: number,
      pinned: boolean): Promise<SimulatorBuildCommandResult> => {
      cancelled(input.signal);
      const commandArgs = pinned
        ? args.at(-1) === "build" ? [...args.slice(0, -1), PIN, "build"] : [...args, PIN]
        : args;
      const result = await this.#runner.run(XCODEBUILD, commandArgs,
        { cwd: project.projectRoot, timeoutMs, maxBufferBytes, signal: input.signal });
      resultProblem(result, input.signal);
      return result;
    };
    let pinned = true;
    const runPinned = async (args: readonly string[], timeoutMs: number, maxBufferBytes: number):
      Promise<{ result: SimulatorBuildCommandResult; attempts: SimulatorBuildCommandResult[] }> => {
      const attempts = [await run(args, timeoutMs, maxBufferBytes, pinned)];
      let result = attempts[0]!;
      if (pinned && result.exitCode !== 0 && missingResolvedFile(result)) {
        pinned = false;
        result = await run(args, timeoutMs, maxBufferBytes, false);
        attempts.push(result);
      }
      return { result, attempts };
    };
    const listed = await runPinned(["-list", "-json", flag, project.containerPath],
      this.#inspectionTimeoutMs, 1024 * 1024);
    if (listed.result.exitCode !== 0 || listed.result.outputTruncated) throw new SimulatorProjectBuildError("APP_BUILD_FAILED",
      "Xcode could not inspect the selected project.", logTail(listed.attempts));
    let schemes: string[] = [];
    try {
      const catalog = JSON.parse(listed.result.stdout) as Record<string, { schemes?: unknown }>;
      const values = (catalog.workspace ?? catalog.project)?.schemes;
      if (Array.isArray(values)) schemes = values.filter(value => typeof value === "string" && value.length > 0);
    } catch { /* untrusted Xcode response */ }
    const requested = input.scheme?.trim();
    const scheme = requested ?? (schemes.length === 1 ? schemes[0]! : "");
    if (!scheme || !schemes.includes(scheme)) throw new SimulatorProjectBuildError("AMBIGUOUS_XCODE_PROJECT",
      `Select an available shared Xcode scheme: ${summarize(schemes)}.`);
    const common = [flag, project.containerPath, "-scheme", scheme, "-configuration", "Debug",
      "-destination", `platform=iOS Simulator,id=${input.simulatorUdid.toUpperCase()}`,
      "-derivedDataPath", input.derivedDataPath];
    const settings = await runPinned([...common, "-showBuildSettings", "-json"],
      this.#inspectionTimeoutMs, 4 * 1024 * 1024);
    if (settings.result.exitCode !== 0 || settings.result.outputTruncated) throw new SimulatorProjectBuildError("APP_BUILD_FAILED",
      "Xcode build settings are unavailable.", logTail(settings.attempts));
    const appSettings = primaryAppSettings(settings.result.stdout);
    if (!appSettings) throw new SimulatorProjectBuildError("APP_ARTIFACT_INVALID",
      "Xcode did not identify one primary installable application target.", logTail(settings.attempts));
    const expectedArch = input.expectedArch ?? (arch() === "x64" ? "x86_64" : "arm64");
    const arches = String(appSettings["ARCHS"] ?? "").split(/\s+/u).filter(Boolean);
    const excluded = String(appSettings["EXCLUDED_ARCHS"] ?? "").split(/\s+/u).filter(Boolean);
    if (arches.length > 0 && !arches.some(value => value === expectedArch && !excluded.includes(value))) {
      throw new SimulatorProjectBuildError("APP_ARCH_MISMATCH",
        "The primary app target cannot build for this Simulator host architecture.", logTail(settings.attempts));
    }
    let bundlePath = join(input.derivedDataPath, `JokoBuild-${randomUUID()}.xcresult`);
    const buildAttempts: SimulatorBuildCommandResult[] = [];
    let buildResult = await run([...common, "-resultBundlePath", bundlePath, "build"],
      this.#buildTimeoutMs, 1024 * 1024, pinned);
    buildAttempts.push(buildResult);
    if (pinned && buildResult.exitCode !== 0 && missingResolvedFile(buildResult)) {
      pinned = false;
      const failedBundle = bundlePath;
      bundlePath = join(input.derivedDataPath, `JokoBuild-${randomUUID()}.xcresult`);
      await rm(failedBundle, { recursive: true, force: true }).catch(() => undefined);
      buildResult = await run([...common, "-resultBundlePath", bundlePath, "build"],
        this.#buildTimeoutMs, 1024 * 1024, false);
      buildAttempts.push(buildResult);
    }
    let availableBundle: string | null = null;
    try { availableBundle = await realpath(bundlePath); } catch { /* Xcode need not produce a result bundle */ }
    if (availableBundle && !inside(await realpath(input.derivedDataPath), availableBundle)) {
      throw new SimulatorProjectBuildError("APP_ARTIFACT_INVALID",
        "Xcode result bundle escaped its managed build root.", logTail(buildAttempts));
    }
    if (buildResult.exitCode !== 0) throw new SimulatorProjectBuildError("APP_BUILD_FAILED",
      "The Xcode app build failed.", logTail(buildAttempts), availableBundle);
    const directory = appSettings["TARGET_BUILD_DIR"];
    const wrapper = appSettings["WRAPPER_NAME"];
    if (typeof directory !== "string" || typeof wrapper !== "string" ||
        !wrapper.endsWith(".app") || basename(wrapper) !== wrapper) {
      throw new SimulatorProjectBuildError("APP_ARTIFACT_INVALID",
        "The primary app target has no unambiguous app artifact.", logTail(buildAttempts), availableBundle);
    }
    let appPath: string;
    try { appPath = await realpath(join(directory, wrapper)); }
    catch { throw new SimulatorProjectBuildError("APP_ARTIFACT_INVALID",
      "The built app artifact was not found.", logTail(buildAttempts), availableBundle); }
    if (!inside(await realpath(input.derivedDataPath), appPath) || !(await stat(appPath)).isDirectory()) {
      throw new SimulatorProjectBuildError("APP_ARTIFACT_INVALID",
        "The built app artifact escaped its managed build root.", logTail(buildAttempts), availableBundle);
    }
    return { ...project, scheme, appPath, resultBundlePath: availableBundle,
      buildLogTail: logTail(buildAttempts),
      outputTruncated: buildAttempts.some(result => Boolean(result.outputTruncated)) };
  }

  async readXcresult(resultBundlePath: string, signal?: AbortSignal): Promise<string> {
    cancelled(signal);
    let result = await this.#runner.run(XCRUN,
      ["xcresulttool", "get", "--path", resultBundlePath, "--format", "json"],
      { timeoutMs: 60_000, maxBufferBytes: 2 * 1024 * 1024, signal });
    resultProblem(result, signal);
    if (result.exitCode !== 0 && /--legacy flag is required/iu.test(`${result.stdout}\n${result.stderr}`)) {
      result = await this.#runner.run(XCRUN,
        ["xcresulttool", "get", "object", "--legacy", "--path", resultBundlePath, "--format", "json"],
        { timeoutMs: 60_000, maxBufferBytes: 2 * 1024 * 1024, signal });
      resultProblem(result, signal);
    }
    if (result.exitCode !== 0 || result.outputTruncated) throw new SimulatorProjectBuildError("APP_BUILD_FAILED",
      "Xcode result bundle could not be read.");
    return result.stdout;
  }
}
