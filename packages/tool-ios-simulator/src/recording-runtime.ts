import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UDID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const MAX_RECORDING_BYTES = 128 * 1024 * 1024;
const START_TIMEOUT_MS = 7_000;
const STOP_TIMEOUT_MS = 8_000;
const CLEANUP_TIMEOUT_MS = 10_000;

type GuardianReply = { readonly type: "ready" | "finalized" | "failed";
  readonly code?: "RECORDING_FAILED" | "RECORDING_INVALID" };

export class SimulatorRecordingRuntimeError extends Error {
  constructor(readonly code: "RECORDING_UNAVAILABLE" | "RECORDING_FAILED" | "RECORDING_INVALID" |
    "RECORDING_OUTCOME_UNKNOWN" | "MUTATION_CANCELLED", message: string,
    readonly cleanupUncertain = false) { super(message); }
}

export interface SimulatorRecordingHandle {
  readonly recordingId: string;
  readonly simulatorUdid: string;
}

export interface SimulatorRecordingOutput {
  readonly file: FileHandle;
  readonly byteLength: number;
}

export interface SimulatorRecordingRuntime {
  start(simulatorUdid: string, signal?: AbortSignal): Promise<SimulatorRecordingHandle>;
  stop(handle: SimulatorRecordingHandle, signal?: AbortSignal): Promise<SimulatorRecordingOutput>;
  isActive(handle: SimulatorRecordingHandle): boolean;
  discard(handle: SimulatorRecordingHandle): Promise<void>;
  release(handle: SimulatorRecordingHandle): Promise<void>;
  close(): Promise<void>;
}

interface RecordingRuntimeOptions {
  readonly rootDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: typeof spawn;
  readonly executablePath?: string;
  readonly guardianPath?: string;
}

interface LiveRecording extends SimulatorRecordingHandle {
  readonly child: ChildProcess;
  readonly outputPath: string;
  failed: boolean;
}

/** A process-local handle to an IPC guardian; parent death closes its pipe and discards the recorder. */
export class MacSimulatorRecordingRuntime implements SimulatorRecordingRuntime {
  readonly #root: string;
  readonly #platform: NodeJS.Platform;
  readonly #spawn: typeof spawn;
  readonly #executable: string;
  readonly #guardianPath: string;
  readonly #active = new Map<string, LiveRecording>();

  constructor(options: RecordingRuntimeOptions) {
    this.#root = resolve(options.rootDirectory);
    this.#platform = options.platform ?? process.platform;
    this.#spawn = options.spawn ?? spawn;
    this.#executable = options.executablePath ?? process.execPath;
    this.#guardianPath = options.guardianPath ?? fileURLToPath(new URL("./recording-guardian.js", import.meta.url));
  }

  async start(simulatorUdid: string, signal?: AbortSignal): Promise<SimulatorRecordingHandle> {
    if (this.#platform !== "darwin" || !UDID.test(simulatorUdid) || !isAbsolute(this.#root)) {
      throw new SimulatorRecordingRuntimeError("RECORDING_UNAVAILABLE", "Simulator recording is unavailable.");
    }
    if (signal?.aborted) throw new SimulatorRecordingRuntimeError("MUTATION_CANCELLED",
      "Simulator recording was cancelled before dispatch.");
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.#root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
        (process.getuid !== undefined && ((rootInfo.mode & 0o077) !== 0 ||
          rootInfo.uid !== process.getuid()))) throw new SimulatorRecordingRuntimeError(
      "RECORDING_UNAVAILABLE", "Simulator recording storage is unsafe.");
    const recordingId = randomUUID();
    let child: ChildProcess;
    try {
      child = this.#spawn(this.#executable,
        [this.#guardianPath, "--guardian", simulatorUdid, this.#root, recordingId], {
          shell: false, detached: false, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp",
            ...(process.env.DEVELOPER_DIR === undefined ? {} : { DEVELOPER_DIR: process.env.DEVELOPER_DIR }),
            ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) }
        });
    } catch {
      throw new SimulatorRecordingRuntimeError("RECORDING_UNAVAILABLE",
        "Simulator recording guardian could not start.");
    }
    const active: LiveRecording = { recordingId, simulatorUdid, child,
      outputPath: join(this.#root, recordingId, "recording.mov"), failed: false };
    child.on("message", (value: unknown) => {
      if (typeof value === "object" && value !== null && "type" in value && value.type === "failed") {
        active.failed = true;
      }
    });
    child.on("exit", () => { active.failed = true; });
    child.on("error", () => { active.failed = true; });
    this.#active.set(recordingId, active);
    try {
      await this.#wait(active, "ready", START_TIMEOUT_MS, signal);
      if (!this.isActive(active)) throw new SimulatorRecordingRuntimeError("RECORDING_FAILED",
        "Simulator recorder exited before start completed.");
      return { recordingId, simulatorUdid };
    } catch (error) {
      try { await this.discard(active); }
      catch { throw new SimulatorRecordingRuntimeError("RECORDING_OUTCOME_UNKNOWN",
        "Simulator recorder cleanup is unconfirmed.", true); }
      throw error;
    }
  }

  async stop(handle: SimulatorRecordingHandle, signal?: AbortSignal): Promise<SimulatorRecordingOutput> {
    const active = this.#require(handle);
    if (!this.isActive(handle)) throw new SimulatorRecordingRuntimeError("RECORDING_FAILED",
      "Simulator recorder is no longer active.");
    if (signal?.aborted) throw new SimulatorRecordingRuntimeError("MUTATION_CANCELLED",
      "Simulator recording stop was cancelled before dispatch.");
    this.#send(active, "stop");
    try {
      await this.#wait(active, "finalized", STOP_TIMEOUT_MS, signal);
      const info = await lstat(active.outputPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 8 ||
          info.size > MAX_RECORDING_BYTES) throw new SimulatorRecordingRuntimeError(
        "RECORDING_INVALID", "Simulator recording output is invalid.");
      const file = await open(active.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const exact = await file.stat();
        if (!exact.isFile() || exact.size !== info.size) throw new Error("Recording output changed.");
        const atom = Buffer.alloc(8);
        const read = await file.read(atom, 0, atom.byteLength, 0);
        if (read.bytesRead !== 8 || !["ftyp", "wide", "moov", "mdat", "free"].includes(
          atom.toString("ascii", 4, 8))) throw new Error("Recording container is invalid.");
        return { file, byteLength: exact.size };
      } catch {
        await file.close();
        throw new SimulatorRecordingRuntimeError("RECORDING_INVALID", "Simulator recording output is invalid.");
      }
    } catch (error) {
      try { await this.discard(active); }
      catch { throw new SimulatorRecordingRuntimeError("RECORDING_OUTCOME_UNKNOWN",
        "Simulator recorder cleanup is unconfirmed.", true); }
      throw error;
    }
  }

  async discard(handle: SimulatorRecordingHandle): Promise<void> {
    const active = this.#active.get(handle.recordingId);
    if (!active || active.simulatorUdid !== handle.simulatorUdid) return;
    this.#send(active, "discard");
    await this.#finishCleanup(active);
  }

  isActive(handle: SimulatorRecordingHandle): boolean {
    const active = this.#active.get(handle.recordingId);
    return active !== undefined && active.simulatorUdid === handle.simulatorUdid &&
      !active.failed && active.child.connected && active.child.exitCode === null &&
      active.child.signalCode === null;
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.#active.values()].map(active => this.discard(active)));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length > 0) throw new SimulatorRecordingRuntimeError("RECORDING_OUTCOME_UNKNOWN",
      "Some Simulator recordings could not be safely discarded.");
  }

  #require(handle: SimulatorRecordingHandle): LiveRecording {
    const active = this.#active.get(handle.recordingId);
    if (!active || active.simulatorUdid !== handle.simulatorUdid) throw new SimulatorRecordingRuntimeError(
      "RECORDING_FAILED", "Simulator recording is no longer active.");
    return active;
  }

  #send(active: LiveRecording, type: "stop" | "release" | "discard"): void {
    try { if (active.child.connected) active.child.send({ type }); }
    catch { /* The exit/timeout observation classifies the outcome. */ }
  }

  async release(handle: SimulatorRecordingHandle): Promise<void> {
    const active = this.#require(handle);
    this.#send(active, "release");
    await this.#finishCleanup(active);
  }

  async #finishCleanup(active: LiveRecording): Promise<void> {
    try {
      await this.#waitExit(active, CLEANUP_TIMEOUT_MS);
    } catch {
      try { if (active.child.connected) active.child.disconnect(); }
      catch { /* The second exit observation still decides cleanup certainty. */ }
      await this.#waitExit(active, CLEANUP_TIMEOUT_MS);
    }
    this.#active.delete(active.recordingId);
  }

  #wait(active: LiveRecording, expected: GuardianReply["type"], timeoutMs: number,
    signal?: AbortSignal): Promise<void> {
    return new Promise((resolveWait, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        active.child.off("message", message);
        active.child.off("error", failure);
        active.child.off("exit", exited);
        signal?.removeEventListener("abort", cancelled);
        if (error) reject(error); else resolveWait();
      };
      const message = (value: unknown): void => {
        if (typeof value !== "object" || value === null || !("type" in value)) return;
        const reply = value as GuardianReply;
        if (reply.type === expected) finish();
        else if (reply.type === "failed") finish(new SimulatorRecordingRuntimeError(
          reply.code === "RECORDING_INVALID" ? "RECORDING_INVALID" : "RECORDING_FAILED",
          "Simulator recording process failed."));
      };
      const failure = (): void => finish(new SimulatorRecordingRuntimeError(
        "RECORDING_OUTCOME_UNKNOWN", "Simulator recording guardian failed."));
      const exited = (): void => finish(new SimulatorRecordingRuntimeError(
        "RECORDING_OUTCOME_UNKNOWN", "Simulator recording guardian exited unexpectedly."));
      const cancelled = (): void => finish(new SimulatorRecordingRuntimeError(
        "RECORDING_OUTCOME_UNKNOWN", "Simulator recording was interrupted; inspect before retrying."));
      const timer = setTimeout(() => finish(new SimulatorRecordingRuntimeError(
        "RECORDING_OUTCOME_UNKNOWN", "Simulator recording response timed out.")), timeoutMs);
      active.child.on("message", message);
      active.child.once("error", failure);
      active.child.once("exit", exited);
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted) cancelled();
      else if (active.child.exitCode !== null || typeof active.child.signalCode === "string") exited();
    });
  }

  #waitExit(active: LiveRecording, timeoutMs: number): Promise<void> {
    return new Promise((resolveWait, reject) => {
      if (active.child.exitCode !== null || typeof active.child.signalCode === "string") {
        resolveWait(); return;
      }
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        active.child.off("exit", exited);
        active.child.off("error", failure);
        if (error) reject(error); else resolveWait();
      };
      const exited = (): void => finish();
      const failure = (): void => finish(new SimulatorRecordingRuntimeError(
        "RECORDING_OUTCOME_UNKNOWN", "Simulator recording guardian failed during cleanup."));
      const timer = setTimeout(() => finish(new SimulatorRecordingRuntimeError(
        "RECORDING_OUTCOME_UNKNOWN", "Simulator recording guardian did not exit after cleanup.")), timeoutMs);
      active.child.once("exit", exited);
      active.child.once("error", failure);
    });
  }
}
