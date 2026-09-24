import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import type { SimulatorNormalizedTouchSample } from "./native-touch-path.js";

const MAX_OUTPUT_BYTES = 256;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const TOUCH_TIMEOUT_MS = 75_000;
const execFileAsync = promisify(execFile);

export interface SimulatorNativeHidIdentity {
  readonly simulatorUdid: string;
  readonly generation: number;
}

export interface SimulatorNativeHidRuntime {
  probe(identity: SimulatorNativeHidIdentity, signal?: AbortSignal): Promise<boolean>;
  touch(identity: SimulatorNativeHidIdentity, first: readonly SimulatorNormalizedTouchSample[],
    second?: readonly SimulatorNormalizedTouchSample[], signal?: AbortSignal): Promise<void>;
}

export class SimulatorNativeHidError extends Error {
  constructor(readonly code: "NATIVE_INPUT_UNAVAILABLE" | "INPUT_OUTCOME_UNKNOWN" |
    "MUTATION_CANCELLED", message: string) { super(message); }
}

interface NativeHidRuntimeOptions {
  readonly helperPath: string;
  readonly platform?: NodeJS.Platform;
  readonly verifyHelper?: () => Promise<boolean>;
  readonly spawn?: typeof spawn;
  readonly developerDir?: string;
}

function validIdentity(identity: SimulatorNativeHidIdentity): boolean {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(identity.simulatorUdid) &&
    Number.isSafeInteger(identity.generation) && identity.generation > 0;
}

/** One-shot, exact-device SimulatorKit helper. No ambient subprocess output is published. */
export class MacSimulatorNativeHidRuntime implements SimulatorNativeHidRuntime {
  readonly #helperPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #verifyHelper: () => Promise<boolean>;
  readonly #spawn: typeof spawn;
  readonly #developerDir: string | undefined;

  constructor(options: NativeHidRuntimeOptions) {
    this.#helperPath = options.helperPath;
    this.#platform = options.platform ?? process.platform;
    this.#verifyHelper = options.verifyHelper ?? (() => this.#inspectHelper());
    this.#spawn = options.spawn ?? spawn;
    this.#developerDir = options.developerDir ?? process.env.DEVELOPER_DIR;
  }

  async probe(identity: SimulatorNativeHidIdentity, signal?: AbortSignal): Promise<boolean> {
    if (!validIdentity(identity) || this.#platform !== "darwin" || signal?.aborted ||
        !await this.#verifyHelper()) return false;
    try { return await this.#run(identity, true, undefined, signal) === "OK"; }
    catch { return false; }
  }

  async touch(identity: SimulatorNativeHidIdentity, first: readonly SimulatorNormalizedTouchSample[],
    second?: readonly SimulatorNormalizedTouchSample[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new SimulatorNativeHidError("MUTATION_CANCELLED",
      "Simulator native touch was cancelled before dispatch.");
    if (!validIdentity(identity) || this.#platform !== "darwin" || !await this.#verifyHelper()) {
      throw new SimulatorNativeHidError("NATIVE_INPUT_UNAVAILABLE",
        "Simulator native touch is unavailable on this host.");
    }
    const payload = JSON.stringify({ simulatorUdid: identity.simulatorUdid,
      generation: identity.generation, first, ...(second === undefined ? {} : { second }) });
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
      throw new SimulatorNativeHidError("NATIVE_INPUT_UNAVAILABLE",
        "Simulator native touch exceeds its input limit.");
    }
    const code = await this.#run(identity, false, payload, signal);
    if (code === "OK") return;
    throw new SimulatorNativeHidError("INPUT_OUTCOME_UNKNOWN",
      "Simulator native touch result is unknown; read a new screen map before retrying.");
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
          manifestInfo.isSymbolicLink() || manifestInfo.size > 1024) return false;
      const manifest: unknown = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
      const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : "unsupported";
      return manifest !== null && typeof manifest === "object" && !Array.isArray(manifest) &&
        (manifest as Record<string, unknown>)["platform"] === "darwin" &&
        ((manifest as Record<string, unknown>)["architecture"] === "universal" ||
          (manifest as Record<string, unknown>)["architecture"] === architecture) &&
        (manifest as Record<string, unknown>)["helper"] === "joko-simulator-hid" &&
        (manifest as Record<string, unknown>)["protocolVersion"] === 1;
    } catch { return false; }
  }

  async #developerDirectory(): Promise<string> {
    if (this.#developerDir !== undefined) return this.#developerDir;
    try {
      const { stdout } = await execFileAsync("/usr/bin/xcode-select", ["-p"], {
        timeout: 5_000, maxBuffer: 4_096, windowsHide: true,
        env: { PATH: "/usr/bin:/bin" }
      });
      const directory = stdout.trim();
      if (!directory.startsWith("/") || directory.includes("\n")) throw new Error("Invalid developer directory.");
      return directory;
    } catch {
      throw new SimulatorNativeHidError("NATIVE_INPUT_UNAVAILABLE",
        "Active Xcode developer directory is unavailable.");
    }
  }

  async #run(identity: SimulatorNativeHidIdentity, probe: boolean, payload?: string,
    signal?: AbortSignal): Promise<string> {
    const developerDir = await this.#developerDirectory();
    if (signal?.aborted) throw new SimulatorNativeHidError("MUTATION_CANCELLED",
      "Simulator native touch was cancelled before dispatch.");
    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new SimulatorNativeHidError("MUTATION_CANCELLED",
          "Simulator native touch was cancelled before dispatch."));
        return;
      }
      let child: ChildProcessByStdio<Writable, Readable, null>;
      try {
        child = this.#spawn(this.#helperPath, ["--simulator-udid", identity.simulatorUdid,
          "--generation", String(identity.generation), probe ? "--probe" : "--touch"], {
          stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true,
          env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "",
            TMPDIR: process.env.TMPDIR ?? "/tmp",
            DEVELOPER_DIR: developerDir }
        });
      } catch {
        reject(new SimulatorNativeHidError(probe ? "NATIVE_INPUT_UNAVAILABLE" : "INPUT_OUTCOME_UNKNOWN",
          "Simulator native helper could not start."));
        return;
      }
      let settled = false;
      let output = "";
      let cancelled = false;
      const finish = (error: Error | null, code?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceKill);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(code ?? "");
      };
      const abort = (): void => { if (cancelled) return; cancelled = true; child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000); };
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(abort, probe ? PROBE_TIMEOUT_MS : TOUCH_TIMEOUT_MS);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) abort();
      });
      child.on("error", () => finish(new SimulatorNativeHidError(probe
        ? "NATIVE_INPUT_UNAVAILABLE" : "INPUT_OUTCOME_UNKNOWN",
      "Simulator native helper failed.")));
      child.on("close", status => {
        if (cancelled) {
          finish(new SimulatorNativeHidError("INPUT_OUTCOME_UNKNOWN",
            "Simulator native touch outcome is unknown; read a new screen map."));
          return;
        }
        try {
          const result: unknown = JSON.parse(output.trim());
          const code = result !== null && typeof result === "object" && !Array.isArray(result)
            ? (result as Record<string, unknown>)["code"] : null;
          if (typeof code !== "string" || !/^[A-Z_]{2,40}$/u.test(code) ||
              (status === 0) !== (code === "OK")) throw new Error("Invalid helper result.");
          finish(null, code);
        } catch {
          finish(new SimulatorNativeHidError(probe ? "NATIVE_INPUT_UNAVAILABLE"
            : "INPUT_OUTCOME_UNKNOWN", "Simulator native helper returned an invalid result."));
        }
      });
      child.stdin.on("error", () => { /* The close event classifies the helper outcome. */ });
      child.stdin.end(payload ?? "");
    });
  }
}
