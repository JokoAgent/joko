import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { SimulatorNativeH264FrameParser, type SimulatorNativeH264Frame
} from "./native-h264-protocol.js";

const START_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 2_000;
const PROBE_TIMEOUT_MS = 5_000;
const UDID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const execFileAsync = promisify(execFile);

export interface SimulatorNativeH264Identity {
  readonly simulatorUdid: string;
  readonly generation: number;
}
export interface SimulatorNativeH264Profile {
  readonly framesPerSecond: number;
  readonly scalingPercent: number;
  readonly orientation: "PORTRAIT" | "LANDSCAPE";
}
export interface SimulatorNativeH264Runtime {
  probe(identity: SimulatorNativeH264Identity, signal?: AbortSignal): Promise<boolean>;
  stream(identity: SimulatorNativeH264Identity, profile: SimulatorNativeH264Profile,
    signal?: AbortSignal): AsyncGenerator<SimulatorNativeH264Frame>;
}
export class SimulatorNativeH264Error extends Error {
  constructor(readonly code: "NATIVE_STREAM_UNAVAILABLE" | "NATIVE_STREAM_LOST",
    message: string) { super(message); }
}

interface RuntimeOptions {
  readonly helperPath: string;
  readonly platform?: NodeJS.Platform;
  readonly verifyHelper?: () => Promise<boolean>;
  readonly spawn?: typeof spawn;
  readonly developerDir?: string;
}

function validIdentity(identity: SimulatorNativeH264Identity): boolean {
  return UDID.test(identity.simulatorUdid) && Number.isSafeInteger(identity.generation) &&
    identity.generation > 0;
}
function validProfile(profile: SimulatorNativeH264Profile): boolean {
  return Number.isSafeInteger(profile.framesPerSecond) && profile.framesPerSecond >= 1 &&
    profile.framesPerSecond <= 60 && Number.isSafeInteger(profile.scalingPercent) &&
    profile.scalingPercent >= 1 && profile.scalingPercent <= 100 &&
    (profile.orientation === "PORTRAIT" || profile.orientation === "LANDSCAPE");
}

/** One-shot, exact-device H.264 helper with stdout backpressure and no host output projection. */
export class MacSimulatorNativeH264Runtime implements SimulatorNativeH264Runtime {
  readonly #helperPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #verifyHelper: () => Promise<boolean>;
  readonly #spawn: typeof spawn;
  readonly #developerDir: string | undefined;

  constructor(options: RuntimeOptions) {
    this.#helperPath = options.helperPath;
    this.#platform = options.platform ?? process.platform;
    this.#verifyHelper = options.verifyHelper ?? (() => this.#inspectHelper());
    this.#spawn = options.spawn ?? spawn;
    this.#developerDir = options.developerDir ?? process.env.DEVELOPER_DIR;
  }

  async probe(identity: SimulatorNativeH264Identity, signal?: AbortSignal): Promise<boolean> {
    if (!validIdentity(identity) || this.#platform !== "darwin" || signal?.aborted ||
        !await this.#verifyHelper()) return false;
    try {
      const child = this.#start(identity, "--probe", undefined, await this.#developerDirectory());
      child.stdin.end();
      let closed = false;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const stop = (): void => {
        if (closed) return;
        child.kill("SIGTERM");
        forceKill ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, STOP_TIMEOUT_MS);
      };
      const timer = setTimeout(stop, PROBE_TIMEOUT_MS);
      signal?.addEventListener("abort", stop, { once: true });
      let outputBytes = 0;
      child.stdout.on("data", (chunk: Buffer) => { outputBytes += chunk.byteLength; stop(); });
      const result = await new Promise<boolean>(resolve => {
        child.once("error", () => resolve(false));
        child.once("close", code => { closed = true; resolve(code === 0); });
      });
      clearTimeout(timer);
      clearTimeout(forceKill);
      signal?.removeEventListener("abort", stop);
      return result && outputBytes === 0 && !signal?.aborted;
    } catch { return false; }
  }

  async *stream(identity: SimulatorNativeH264Identity, profile: SimulatorNativeH264Profile,
    signal?: AbortSignal): AsyncGenerator<SimulatorNativeH264Frame> {
    if (!validIdentity(identity) || !validProfile(profile) || this.#platform !== "darwin" ||
        signal?.aborted || !await this.#verifyHelper()) throw new SimulatorNativeH264Error(
      "NATIVE_STREAM_UNAVAILABLE", "Simulator native H.264 streaming is unavailable.");
    let developerDir: string;
    try { developerDir = await this.#developerDirectory(); }
    catch { throw new SimulatorNativeH264Error("NATIVE_STREAM_UNAVAILABLE",
      "Active Xcode developer directory is unavailable."); }
    if (signal?.aborted) throw new SimulatorNativeH264Error("NATIVE_STREAM_UNAVAILABLE",
      "Simulator native H.264 stream was cancelled before dispatch.");
    const child = this.#start(identity, "--stream-h264", profile, developerDir);
    child.stdin.end();
    const parser = new SimulatorNativeH264FrameParser();
    let closed = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (closed) return;
      child.kill("SIGTERM");
      forceKill ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, STOP_TIMEOUT_MS);
    };
    const arm = (milliseconds: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; stop(); }, milliseconds);
    };
    const completion = new Promise<{ code: number | null; error: boolean }>(resolve => {
      child.once("error", () => resolve({ code: null, error: true }));
      child.once("close", code => { closed = true; resolve({ code, error: false }); });
    });
    signal?.addEventListener("abort", stop, { once: true });
    arm(START_TIMEOUT_MS);
    try {
      for await (const chunk of child.stdout) {
        if (signal?.aborted || timedOut) break;
        for (const frame of parser.push(chunk)) {
          arm(IDLE_TIMEOUT_MS);
          yield frame;
          if (signal?.aborted || timedOut) break;
        }
      }
      if (signal?.aborted) return;
      const result = await completion;
      if (timedOut || result.error || result.code !== 0) throw new SimulatorNativeH264Error(
        "NATIVE_STREAM_LOST", "Simulator native H.264 stream ended unexpectedly.");
      parser.finish();
    } catch {
      if (signal?.aborted) return;
      throw new SimulatorNativeH264Error("NATIVE_STREAM_LOST",
        "Simulator native H.264 stream output is invalid or disconnected.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      stop();
      await completion;
      clearTimeout(forceKill);
    }
  }

  #start(identity: SimulatorNativeH264Identity, mode: "--probe" | "--stream-h264",
    profile: SimulatorNativeH264Profile | undefined,
    developerDir: string): ChildProcessByStdio<Writable, Readable, null> {
    const args = ["--simulator-udid", identity.simulatorUdid, "--generation",
      String(identity.generation), mode];
    if (profile) args.push("--fps", String(profile.framesPerSecond), "--scale",
      String(profile.scalingPercent), "--orientation", profile.orientation);
    const child = this.#spawn(this.#helperPath, args, { stdio: ["pipe", "pipe", "ignore"],
      shell: false, windowsHide: true,
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp", DEVELOPER_DIR: developerDir } });
    child.stdin.on("error", () => { /* The close event classifies a failed helper. */ });
    return child;
  }

  async #developerDirectory(): Promise<string> {
    const directory = this.#developerDir ?? (await execFileAsync("/usr/bin/xcode-select", ["-p"], {
      timeout: 5_000, maxBuffer: 4_096, windowsHide: true, env: { PATH: "/usr/bin:/bin" }
    })).stdout.trim();
    if (!directory.startsWith("/") || directory.includes("\n") || directory.includes("\0"))
      throw new Error("Invalid developer directory.");
    return directory;
  }

  async #inspectHelper(): Promise<boolean> {
    try {
      const root = dirname(this.#helperPath);
      const [directory, binary, manifestInfo] = await Promise.all([
        lstat(root), lstat(this.#helperPath), lstat(join(root, "manifest.json"))
      ]);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !binary.isFile() ||
          binary.isSymbolicLink() || (binary.mode & 0o111) === 0 || binary.size <= 0 ||
          binary.size > 16 * 1024 * 1024 || !manifestInfo.isFile() ||
          manifestInfo.isSymbolicLink() || manifestInfo.size > 1_024) return false;
      const manifest: unknown = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
      const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64"
        ? "x86_64" : "unsupported";
      return manifest !== null && typeof manifest === "object" && !Array.isArray(manifest) &&
        (manifest as Record<string, unknown>)["platform"] === "darwin" &&
        ((manifest as Record<string, unknown>)["architecture"] === "universal" ||
          (manifest as Record<string, unknown>)["architecture"] === architecture) &&
        (manifest as Record<string, unknown>)["helper"] === "joko-simulator-h264" &&
        (manifest as Record<string, unknown>)["protocolVersion"] === 1;
    } catch { return false; }
  }
}
