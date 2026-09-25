import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import type { SimulatorNormalizedTouchSample } from "./native-touch-path.js";

const MAX_OUTPUT_BYTES = 256;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const TOUCH_TIMEOUT_MS = 75_000;
const LIVE_READY_TIMEOUT_MS = 10_000;
const LIVE_STEP_TIMEOUT_MS = 5_000;
const LIVE_IDLE_TIMEOUT_MS = 5_000;
const LIVE_MAX_OUTPUT_BYTES = 256 * 1024;
const execFileAsync = promisify(execFile);

export interface SimulatorNativeHidIdentity {
  readonly simulatorUdid: string;
  readonly generation: number;
}

export interface SimulatorNativeHidCapabilities {
  readonly continuousInput: boolean;
  readonly multiTouch: boolean;
}

export interface SimulatorNativeHidRuntime {
  readonly capabilities: SimulatorNativeHidCapabilities;
  probe(identity: SimulatorNativeHidIdentity, signal?: AbortSignal): Promise<boolean>;
  touch(identity: SimulatorNativeHidIdentity, first: readonly SimulatorNormalizedTouchSample[],
    second?: readonly SimulatorNormalizedTouchSample[], signal?: AbortSignal): Promise<void>;
  beginLiveTouch?(identity: SimulatorNativeHidIdentity, gestureId: string,
    point: SimulatorNativeLivePoint, signal?: AbortSignal): Promise<SimulatorNativeLiveContact>;
}

export interface SimulatorNativeLivePoint { readonly x: number; readonly y: number }
export interface SimulatorNativeLiveContact {
  move(point: SimulatorNativeLivePoint, sequence: number, signal?: AbortSignal): Promise<void>;
  end(point: SimulatorNativeLivePoint, sequence: number, signal?: AbortSignal): Promise<void>;
  cancel(point: SimulatorNativeLivePoint, sequence: number, signal?: AbortSignal): Promise<void>;
  forceRelease(): void;
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

function validLivePoint(point: SimulatorNativeLivePoint): boolean {
  return point !== null && typeof point === "object" && Number.isFinite(point.x) &&
    point.x >= 0 && point.x <= 1 && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1;
}

class LiveHidContact implements SimulatorNativeLiveContact {
  readonly #child: ChildProcessByStdio<Writable, Readable, null>;
  readonly #lines: AsyncIterator<string>;
  readonly #gestureId: string;
  #closed = false;
  #terminal = false;
  #pending = false;
  #lastSequence = -1;
  #outputBytes = 0;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #forceKill: ReturnType<typeof setTimeout> | undefined;

  constructor(child: ChildProcessByStdio<Writable, Readable, null>, gestureId: string) {
    this.#child = child;
    this.#gestureId = gestureId;
    this.#lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    child.stdout.on("data", (chunk: Buffer) => {
      this.#outputBytes += chunk.byteLength;
      if (this.#outputBytes > LIVE_MAX_OUTPUT_BYTES) this.forceRelease();
    });
    child.on("close", () => { this.#closed = true; this.#clearTimers(); });
    child.on("error", () => { this.#closed = true; this.#clearTimers(); });
  }

  async ready(): Promise<void> {
    await this.#reply("READY", undefined, LIVE_READY_TIMEOUT_MS, false);
  }

  async begin(point: SimulatorNativeLivePoint, signal?: AbortSignal): Promise<void> {
    await this.#send("begin", point, 0, signal);
  }

  move(point: SimulatorNativeLivePoint, sequence: number, signal?: AbortSignal): Promise<void> {
    return this.#send("move", point, sequence, signal);
  }

  end(point: SimulatorNativeLivePoint, sequence: number, signal?: AbortSignal): Promise<void> {
    return this.#send("end", point, sequence, signal);
  }

  cancel(point: SimulatorNativeLivePoint, sequence: number, signal?: AbortSignal): Promise<void> {
    return this.#send("cancel", point, sequence, signal);
  }

  async #send(phase: "begin" | "move" | "end" | "cancel", point: SimulatorNativeLivePoint,
    sequence: number, signal?: AbortSignal): Promise<void> {
    if (!validLivePoint(point) || !Number.isSafeInteger(sequence) ||
        sequence !== this.#lastSequence + 1 || this.#terminal || this.#pending) {
      throw new SimulatorNativeHidError("INPUT_OUTCOME_UNKNOWN", "Native live touch state is invalid.");
    }
    if (signal?.aborted) throw new SimulatorNativeHidError("MUTATION_CANCELLED",
      "Native live touch was cancelled before dispatch.");
    if (this.#closed) throw new SimulatorNativeHidError("INPUT_OUTCOME_UNKNOWN",
      "Native live touch helper has exited.");
    this.#pending = true;
    this.#clearIdle();
    try {
      const payload = JSON.stringify({ gestureId: this.#gestureId, sequence, phase,
        x: point.x, y: point.y });
      this.#child.stdin.write(`${payload}\n`);
      await this.#reply("OK", sequence, LIVE_STEP_TIMEOUT_MS, true);
      this.#lastSequence = sequence;
      if (phase === "end" || phase === "cancel") {
        this.#terminal = true;
        this.#child.stdin.end();
      } else {
        this.#idle = setTimeout(() => this.forceRelease(), LIVE_IDLE_TIMEOUT_MS);
      }
    } catch (error) {
      this.forceRelease();
      throw error;
    } finally { this.#pending = false; }
  }

  async #reply(code: "READY" | "OK", sequence: number | undefined,
    timeoutMs: number, dispatched: boolean): Promise<void> {
    if (this.#closed) throw this.#failure(dispatched);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onClose: (() => void) | undefined;
    let onError: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        onClose = () => reject(this.#failure(dispatched));
        onError = () => reject(this.#failure(dispatched));
        this.#child.once("close", onClose);
        this.#child.once("error", onError);
        timeout = setTimeout(() => reject(this.#failure(dispatched)), timeoutMs);
      });
      const next = await Promise.race([this.#lines.next(), interrupted]);
      if (next.done || next.value.length > 256) throw this.#failure(dispatched);
      let message: unknown;
      try { message = JSON.parse(next.value); }
      catch { throw this.#failure(dispatched); }
      if (!message || typeof message !== "object" || Array.isArray(message) ||
          (message as Record<string, unknown>)["code"] !== code ||
          (sequence !== undefined && (message as Record<string, unknown>)["sequence"] !== sequence)) {
        throw this.#failure(dispatched);
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onClose) this.#child.off("close", onClose);
      if (onError) this.#child.off("error", onError);
    }
  }

  #failure(dispatched: boolean): SimulatorNativeHidError {
    return new SimulatorNativeHidError(dispatched ? "INPUT_OUTCOME_UNKNOWN" : "NATIVE_INPUT_UNAVAILABLE",
      dispatched ? "Native live touch outcome is unknown." : "Native live touch helper is unavailable.");
  }

  #clearIdle(): void { if (this.#idle !== undefined) clearTimeout(this.#idle); this.#idle = undefined; }
  #clearTimers(): void {
    this.#clearIdle();
    if (this.#forceKill !== undefined) clearTimeout(this.#forceKill);
    this.#forceKill = undefined;
  }

  forceRelease(): void {
    if (this.#closed || this.#terminal) return;
    this.#terminal = true;
    this.#clearIdle();
    this.#child.kill("SIGTERM");
    this.#forceKill = setTimeout(() => this.#child.kill("SIGKILL"), 2_000);
    this.#forceKill.unref?.();
  }
}

/** One-shot, exact-device SimulatorKit helper. No ambient subprocess output is published. */
export class MacSimulatorNativeHidRuntime implements SimulatorNativeHidRuntime {
  readonly capabilities = { continuousInput: true, multiTouch: true } as const;
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

  async beginLiveTouch(identity: SimulatorNativeHidIdentity, gestureId: string,
    point: SimulatorNativeLivePoint, signal?: AbortSignal): Promise<SimulatorNativeLiveContact> {
    if (signal?.aborted) throw new SimulatorNativeHidError("MUTATION_CANCELLED",
      "Native live touch was cancelled before admission.");
    if (!validIdentity(identity) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(gestureId) ||
        !validLivePoint(point) || this.#platform !== "darwin" || !await this.#verifyHelper()) {
      throw new SimulatorNativeHidError("NATIVE_INPUT_UNAVAILABLE",
        "Native live touch is unavailable on this host.");
    }
    const developerDir = await this.#developerDirectory();
    if (signal?.aborted) throw new SimulatorNativeHidError("MUTATION_CANCELLED",
      "Native live touch was cancelled before dispatch.");
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = this.#spawn(this.#helperPath, ["--simulator-udid", identity.simulatorUdid,
        "--generation", String(identity.generation), "--live-touch"], {
        stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true,
        env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "",
          TMPDIR: process.env.TMPDIR ?? "/tmp", DEVELOPER_DIR: developerDir }
      });
    } catch {
      throw new SimulatorNativeHidError("NATIVE_INPUT_UNAVAILABLE",
        "Native live touch helper could not start.");
    }
    const contact = new LiveHidContact(child, gestureId);
    try { await contact.ready(); await contact.begin(point, signal); return contact; }
    catch (error) { contact.forceRelease(); throw error; }
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
