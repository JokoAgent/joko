import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { isDesktopRemoteDesktopWayland, readDesktopRemoteDesktopLinuxSessionState } from "./remote-desktop-linux.js";
import type { DesktopRemoteDesktopSessionState } from "./remote-desktop-input.js";

const EXECUTABLE = "/usr/bin/pw-record";
const BYTES_PER_FRAME = 8;
const MAXIMUM_BYTES = 4_800 * BYTES_PER_FRAME;
const ARGUMENTS = Object.freeze([
  "--raw", "--format", "f32", "--rate", "48000", "--channels", "2", "--latency", "20ms",
  "--properties", "{ stream.capture.sink=true node.name=joko-desktop-audio media.role=Screen }", "-"
]);

export interface DesktopRemoteDesktopLinuxAudioRuntime {
  supported(): boolean;
  session(signal: AbortSignal): Promise<DesktopRemoteDesktopSessionState>;
  spawn(file: string, arguments_: readonly string[]): ChildProcessWithoutNullStreams;
  now(): number;
}

interface AudioOccurrence {
  readonly owner: object;
  readonly current: () => boolean;
  readonly signal: AbortSignal;
  readonly aborted: () => void;
  child?: ChildProcessWithoutNullStreams;
  closed?: Promise<void>;
  watchdog?: ReturnType<typeof setInterval>;
  samples: Buffer;
  lastRead: number;
  lastData: number;
  retired: boolean;
  actualClosed: boolean;
}

/** Ephemeral default-output monitor; samples never enter files, logs or public contracts. */
export class DesktopRemoteDesktopLinuxAudio {
  readonly #runtime: DesktopRemoteDesktopLinuxAudioRuntime;
  readonly #occurrences = new WeakMap<object, AudioOccurrence>();
  #active: AudioOccurrence | undefined;
  #closing: Promise<void> = Promise.resolve();

  constructor(runtime: DesktopRemoteDesktopLinuxAudioRuntime = audioRuntime()) { this.#runtime = runtime; }
  supports(): boolean { return this.#runtime.supported(); }

  async start(owner: object, current: () => boolean, signal: AbortSignal): Promise<void> {
    if (this.#occurrences.has(owner)) throw unavailable();
    if (this.#active !== undefined) this.#retire(this.#active);
    let occurrence!: AudioOccurrence;
    occurrence = { owner, current, signal, aborted: () => { this.#retire(occurrence); },
      samples: Buffer.alloc(0), lastRead: 0, lastData: 0, retired: false, actualClosed: false };
    this.#occurrences.set(owner, occurrence); this.#active = occurrence;
    signal.addEventListener("abort", occurrence.aborted, { once: true });
    try {
      this.#check(occurrence, current, signal);
      await this.#closing;
      await this.#proof(occurrence, current, signal);
      const child = this.#runtime.spawn(EXECUTABLE, ARGUMENTS);
      occurrence.child = child;
      occurrence.closed = new Promise(resolve => child.once("close", () => {
        occurrence.actualClosed = true; this.#retire(occurrence); resolve();
      }));
      occurrence.lastRead = occurrence.lastData = this.#runtime.now();
      child.stderr.resume();
      const failed = (): void => { this.#retire(occurrence); };
      child.stdin.on("error", failed); child.on("error", failed); child.once("exit", failed);
      child.stdout.on("data", (chunk: Buffer) => {
        if (!this.#valid(occurrence) || occurrence.actualClosed) return;
        if (chunk.length) occurrence.lastData = this.#runtime.now();
        // Drop whole old frames, preserve the trailing partial frame, and allocate only the bounded tail.
        const discard = Math.max(0, Math.ceil((occurrence.samples.length + chunk.length - MAXIMUM_BYTES) / BYTES_PER_FRAME) * BYTES_PER_FRAME);
        occurrence.samples = discard >= occurrence.samples.length
          ? Buffer.from(chunk.subarray(discard - occurrence.samples.length))
          : Buffer.concat([occurrence.samples.subarray(discard), chunk]);
      });
      occurrence.watchdog = setInterval(() => {
        const now = this.#runtime.now();
        if (!this.#valid(occurrence) || now - occurrence.lastRead > 3_000 || now - occurrence.lastData > 5_000) failed();
      }, 1_000);
      occurrence.watchdog.unref?.();
      await this.#proof(occurrence, current, signal);
    } catch {
      await this.#retire(occurrence);
      throw unavailable();
    }
  }

  async read(owner: object, current: () => boolean, signal: AbortSignal): Promise<Uint8Array> {
    const occurrence = this.#occurrences.get(owner);
    if (occurrence === undefined) throw unavailable();
    try {
      await this.#proof(occurrence, current, signal);
      const size = occurrence.samples.length - occurrence.samples.length % BYTES_PER_FRAME;
      const result = Uint8Array.from(occurrence.samples.subarray(0, size));
      occurrence.samples = Buffer.from(occurrence.samples.subarray(size));
      occurrence.lastRead = this.#runtime.now();
      await this.#proof(occurrence, current, signal);
      return result;
    } catch {
      await this.#retire(occurrence);
      throw unavailable();
    }
  }

  /** Exact-owner retirement, or instance-wide complete-exit cleanup when owner is omitted. */
  stop(owner?: object): Promise<void> {
    if (owner !== undefined) {
      const occurrence = this.#occurrences.get(owner);
      return occurrence === undefined ? Promise.resolve() : this.#retire(occurrence);
    }
    if (this.#active !== undefined) this.#retire(this.#active);
    return this.#closing;
  }

  #valid(occurrence: AudioOccurrence): boolean {
    return this.#active === occurrence && !occurrence.retired && !occurrence.signal.aborted && occurrence.current();
  }
  #check(occurrence: AudioOccurrence, current: () => boolean, signal: AbortSignal): void {
    if (!this.#valid(occurrence) || occurrence.actualClosed || signal.aborted || !current()) throw unavailable();
  }
  async #proof(occurrence: AudioOccurrence, current: () => boolean, signal: AbortSignal): Promise<void> {
    this.#check(occurrence, current, signal);
    if (!this.supports() || await this.#runtime.session(signal) !== "unlocked") throw unavailable();
    this.#check(occurrence, current, signal);
  }
  #retire(occurrence: AudioOccurrence): Promise<void> {
    if (this.#active === occurrence) this.#active = undefined;
    if (!occurrence.retired) {
      occurrence.retired = true; occurrence.samples = Buffer.alloc(0);
      clearInterval(occurrence.watchdog); occurrence.watchdog = undefined;
      occurrence.signal.removeEventListener("abort", occurrence.aborted);
      if (occurrence.closed !== undefined) this.#closing = Promise.all([this.#closing, occurrence.closed]).then(() => undefined);
      if (occurrence.child !== undefined && !occurrence.actualClosed) {
        try { occurrence.child.stdin.destroy(); occurrence.child.kill("SIGKILL"); } catch { /* Exact actual close owns settlement. */ }
      }
    }
    return occurrence.closed ?? Promise.resolve();
  }
}

function unavailable(): Error { return new Error("DESKTOP_AUDIO_UNAVAILABLE"); }
function audioRuntime(): DesktopRemoteDesktopLinuxAudioRuntime {
  return {
    supported: supportsDesktopRemoteDesktopLinuxAudio,
    session: readDesktopRemoteDesktopLinuxSessionState,
    spawn: (file, arguments_) => spawn(file, [...arguments_], { stdio: "pipe" }),
    now: Date.now
  };
}
export function supportsDesktopRemoteDesktopLinuxAudio(): boolean {
  if (!isDesktopRemoteDesktopWayland() || !process.env["HYPRLAND_INSTANCE_SIGNATURE"]) return false;
  try { accessSync(EXECUTABLE, constants.X_OK); return true; } catch { return false; }
}
