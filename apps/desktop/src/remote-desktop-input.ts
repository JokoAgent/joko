import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Readable } from "node:stream";

import { app, screen } from "electron";
import type {
  RemoteDesktopDisplay,
  RemoteDesktopDisplayMode,
  RemoteDesktopInput
} from "@joko/device-peer";

import type { DesktopRemoteDesktopInputPort } from "./remote-desktop-host.js";
import { verifyPackagedDesktopRemoteDesktopBinary } from "./remote-desktop-native-manifest.js";
import {
  linuxRemoteDesktopInputMapping, readDesktopRemoteDesktopLinuxInputSupport,
  readDesktopRemoteDesktopLinuxMonitors, readDesktopRemoteDesktopLinuxSessionState,
  resolveDesktopRemoteDesktopLinuxBinary, type DesktopRemoteDesktopLinuxMonitor
} from "./remote-desktop-linux.js";

const exec = promisify(execFile);
const MAXIMUM_QUEUE_BYTES = 32_768;
const HELPER_READY_MS = 8_000;
const HELPER_STOP_MS = 1_500;

export type DesktopRemoteDesktopSessionState =
  | "unknown"
  | "unlocked"
  | "locked-logged-in"
  | "unsupported";

export interface DesktopRemoteDesktopInputRuntime {
  readonly platform: NodeJS.Platform;
  resolveBinary(prepare?: boolean): Promise<string>;
  spawn(binary: string): ChildProcessWithoutNullStreams;
  display(displayId: string): RemoteDesktopDisplay & {
    readonly x: number;
    readonly y: number;
  } | undefined;
  toPhysicalPoint(point: { readonly x: number; readonly y: number }): {
    readonly x: number;
    readonly y: number;
  };
  cursorScreenPoint?(): { readonly x: number; readonly y: number };
  linuxSupport?(signal: AbortSignal): Promise<boolean>;
  linuxSession?(signal: AbortSignal): Promise<DesktopRemoteDesktopSessionState>;
  linuxMonitors?(signal: AbortSignal): Promise<readonly DesktopRemoteDesktopLinuxMonitor[]>;
}

export class DesktopRemoteDesktopInput implements DesktopRemoteDesktopInputPort {
  readonly #onFailure: () => void;
  readonly #runtime: DesktopRemoteDesktopInputRuntime;
  #child: ChildProcessWithoutNullStreams | undefined;
  #displayId = "";
  #generation = 0;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #stopping: Promise<void> = Promise.resolve();
  readonly #pendingInputReleases = new Set<ChildProcessWithoutNullStreams>();
  #retired = false;
  #privacyPaused = false;
  #linuxMapping: ((x: number, y: number) => { x: number; y: number }) | undefined;
  #linuxLayout = "";
  #linuxQueue: Promise<void> = Promise.resolve();
  #linuxQueueBytes = 0;
  #linuxAck: ((error?: Error) => void) | undefined;

  constructor(onFailure: () => void, runtime: DesktopRemoteDesktopInputRuntime = electronInputRuntime(),
    private readonly onPointer?: (points: { x: number; y: number }[]) => (() => void) | void) {
    this.#onFailure = onFailure;
    this.#runtime = runtime;
  }

  async start(displayId: string, signal: AbortSignal): Promise<void> {
    if (this.#retired) throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    this.stop();
    if (this.#runtime.platform !== "darwin" && this.#runtime.platform !== "win32" && this.#runtime.platform !== "linux") {
      throw new Error("REMOTE_DESKTOP_INPUT_UNSUPPORTED");
    }
    const generation = this.#generation;
    await this.#stopping;
    throwIfAborted(signal);
    if (generation !== this.#generation) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    const binary = await this.#runtime.resolveBinary();
    let linuxMapping: ((x: number, y: number) => { x: number; y: number }) | undefined;
    let linuxLayout = "";
    if (this.#runtime.platform === "linux") {
      if (!await (this.#runtime.linuxSupport ?? readDesktopRemoteDesktopLinuxInputSupport)(signal)
        || await (this.#runtime.linuxSession ?? readDesktopRemoteDesktopLinuxSessionState)(signal) !== "unlocked") {
        throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
      }
      const monitors = await (this.#runtime.linuxMonitors ?? readDesktopRemoteDesktopLinuxMonitors)(signal);
      linuxMapping = linuxRemoteDesktopInputMapping(monitors, displayId);
      linuxLayout = JSON.stringify(monitors);
      if (await (this.#runtime.linuxSession ?? readDesktopRemoteDesktopLinuxSessionState)(signal) !== "unlocked") {
        throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
      }
    }
    throwIfAborted(signal);
    if (generation !== this.#generation) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    const child = this.#runtime.spawn(binary);
    this.#child = child;
    this.#displayId = displayId;
    this.#linuxMapping = linuxMapping;
    this.#linuxLayout = linuxLayout;
    child.stderr.resume();
    child.stdin.on("error", () => {
      if (this.#child === child) this.#failed();
    });
    child.on("exit", () => {
      if (this.#child === child) this.#failed();
    });
    try {
      await Promise.race([
        new Promise<void>((resolveReady, rejectReady) => {
          const timer = setTimeout(() => finish(new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE")), HELPER_READY_MS);
          let bytes = 0;
          let text = "";
          const receive = (chunk: Buffer): void => {
            bytes += chunk.byteLength;
            if (bytes > 1_024) {
              finish(new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE"));
              return;
            }
            text += chunk.toString("utf8");
            const newline = text.indexOf("\n");
            if (newline < 0) return;
            const status = text.slice(0, newline).trim();
            finish(status === "ready"
              ? undefined
              : new Error(status === "permission"
                ? "REMOTE_DESKTOP_ACCESSIBILITY_PERMISSION_REQUIRED"
                : status === "locked"
                  ? "REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED"
                  : "REMOTE_DESKTOP_INPUT_UNAVAILABLE"));
          };
          const failed = (): void => finish(new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE"));
          const finish = (error?: Error): void => {
            clearTimeout(timer);
            child.stdout.off("data", receive);
            child.off("error", failed);
            child.off("exit", failed);
            if (error === undefined) resolveReady();
            else rejectReady(error);
          };
          child.stdout.on("data", receive);
          child.once("error", failed);
          child.once("exit", failed);
        }),
        abortPromise(signal)
      ]);
      if (generation !== this.#generation || this.#child !== child) {
        throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
      }
      if (this.#runtime.platform === "linux"
        && (await (this.#runtime.linuxSession ?? readDesktopRemoteDesktopLinuxSessionState)(signal) !== "unlocked"
          || generation !== this.#generation || this.#child !== child)) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
      {
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          if (this.#child !== child) return;
          output += chunk.toString("ascii");
          if (output.length > 1_024) { this.#failed(); return; }
          for (let newline = output.indexOf("\n"); newline >= 0; newline = output.indexOf("\n")) {
            const status = output.slice(0, newline); output = output.slice(newline + 1);
            if (status !== "ok" || this.#linuxAck === undefined) { this.#failed(); return; }
            this.#linuxAck();
          }
        });
      }
      this.#heartbeat = setInterval(() => this.#write([]), 2_000);
      this.#heartbeat.unref?.();
    } catch (error) {
      if (generation === this.#generation) this.stop();
      throw error;
    }
  }

  send(events: readonly RemoteDesktopInput[]): void {
    if (this.#privacyPaused) return;
    if (this.#runtime.platform === "linux") {
      if (this.#linuxMapping === undefined || this.#child === undefined) throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
      const projected = events.flatMap((event) => {
        if (event.kind === "move" || event.kind === "button") return [{ ...event, ...this.#linuxMapping!(event.x, event.y) }];
        if (event.kind !== "text") return [event];
        const scalars = Array.from(event.text); const parts: RemoteDesktopInput[] = [];
        for (let index = 0; index < scalars.length; index += 256) parts.push({ kind: "text", text: scalars.slice(index, index + 256).join("") });
        return parts;
      });
      for (let index = 0; index < projected.length; index += 256) this.#write(projected.slice(index, index + 256));
      return;
    }
    const display = this.#runtime.display(this.#displayId);
    if (display === undefined || this.#child === undefined) {
      throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    }
    const points: { x: number; y: number }[] = [];
    const projected = events.map((event) => {
      if (event.kind !== "move" && event.kind !== "button") return event;
      const dip = {
        x: Math.round(display.x + event.x * (display.width - 1)),
        y: Math.round(display.y + event.y * (display.height - 1))
      };
      points.push(dip);
      const point = this.#runtime.toPhysicalPoint(dip);
      return Object.freeze({ ...event, x: point.x, y: point.y });
    });
    this.#write(projected, points, events.some(event => event.kind === "scroll"));
  }

  stop(): void {
    this.#generation += 1;
    this.#privacyPaused = false;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    const child = this.#child;
    this.#child = undefined;
    this.#displayId = "";
    this.#linuxMapping = undefined;
    this.#linuxLayout = "";
    this.#linuxAck?.(new Error("REMOTE_DESKTOP_LEASE_EXPIRED"));
    this.#linuxQueueBytes = 0;
    this.#linuxQueue = Promise.resolve();
    if (child === undefined) return;
    this.#pendingInputReleases.add(child);
    this.#stopping = new Promise<void>((resolveStopped) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolveStopped();
      };
      const confirmed = (): void => {
        this.#pendingInputReleases.delete(child);
        child.off("exit", confirmed);
      };
      const closed = (): void => {
        confirmed();
        finish();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* Process already retired. */ }
        if (this.#runtime.platform !== "linux") finish();
      }, HELPER_STOP_MS);
      timer.unref?.();
      if (this.#runtime.platform !== "linux") child.once("exit", confirmed);
      child.once("close", closed);
      if (this.#runtime.platform !== "linux" && (!child.pid || child.exitCode !== null || child.signalCode !== null)) {
        confirmed();
        finish();
      }
      else {
        try { child.stdin.end('[{"kind":"release"}]\n'); }
        catch { try { child.kill(); } catch { /* Actual close owns Linux settlement. */ } if (this.#runtime.platform !== "linux") finish(); }
      }
    });
  }

  async retire(): Promise<void> {
    if (this.#retired) { if (this.#runtime.platform === "linux") await this.#stopping; return; }
    this.#retired = true;
    this.stop();
    await this.#stopping;
  }

  async release(): Promise<void> {
    this.stop();
    await this.#stopping;
    if (this.#pendingInputReleases.size > 0) throw new Error("REMOTE_DESKTOP_LOCK_FAILED");
  }

  async pauseForPrivacy(current: () => boolean, signal: AbortSignal): Promise<() => Promise<void>> {
    if (this.#child === undefined || !current() || signal.aborted) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
    const displayId = this.#displayId;
    this.stop();
    this.#privacyPaused = true;
    const generation = this.#generation;
    await this.#stopping;
    if (this.#pendingInputReleases.size > 0) throw new Error("REMOTE_DESKTOP_PRIVACY_FAILED");
    if (generation !== this.#generation || !current() || signal.aborted) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
    return async () => {
      if (generation !== this.#generation || !current() || signal.aborted) return;
      const restoring = generation + 1;
      try {
        await this.start(displayId, signal);
        if (!current() || signal.aborted) {
          if (this.#generation === restoring) this.stop();
          throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
        }
      } catch (error) {
        if (this.#generation === restoring) this.#failed();
        throw error;
      }
    };
  }

  async resumeAfterPrivacy(displayId: string, current: () => boolean, signal: AbortSignal): Promise<void> {
    if (!this.#privacyPaused) return;
    const generation = this.#generation;
    const check = (): void => {
      if (generation !== this.#generation || !current() || signal.aborted) {
        throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
      }
    };
    check();
    await this.#stopping;
    check();
    if (this.#pendingInputReleases.size > 0) {
      this.#failed();
      throw new Error("REMOTE_DESKTOP_PRIVACY_FAILED");
    }
    const restoring = generation + 1;
    try {
      // start joins actual helper retirement and clears the paused flag.
      await this.start(displayId, signal);
      if (restoring !== this.#generation || !current() || signal.aborted) {
        if (this.#generation === restoring) {
          this.stop();
          await this.#stopping;
        }
        throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
      }
    } catch (error) {
      if (this.#generation === restoring) this.#failed();
      throw error;
    }
  }

  #write(events: readonly unknown[], points: { x: number; y: number }[] = [], wheel = false): void {
    const child = this.#child;
    if (child === undefined) throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    const line = `${JSON.stringify(events)}\n`;
    const size = Buffer.byteLength(line, "utf8");
    if (size > MAXIMUM_QUEUE_BYTES || this.#linuxQueueBytes + size > MAXIMUM_QUEUE_BYTES || child.stdin.destroyed) {
      this.#failed(); throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    }
    this.#linuxQueueBytes += size;
    const generation = this.#generation;
    this.#linuxQueue = this.#linuxQueue.then(async () => {
      if (generation !== this.#generation || this.#child !== child) return;
      if (this.#runtime.platform === "linux") {
        const signal = new AbortController().signal;
        const monitors = await (this.#runtime.linuxMonitors ?? readDesktopRemoteDesktopLinuxMonitors)(signal);
        const state = await (this.#runtime.linuxSession ?? readDesktopRemoteDesktopLinuxSessionState)(signal);
        if (generation !== this.#generation || this.#child !== child) return;
        if (state !== "unlocked" || JSON.stringify(monitors) !== this.#linuxLayout) throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
      }
      const settled = this.onPointer && (points.length || wheel)
        ? this.onPointer(wheel ? [this.#runtime.cursorScreenPoint?.() ?? screen.getCursorScreenPoint(), ...points] : points) : undefined;
      try {
        // Completion owns the actual native injection, not just stdin's buffer.
        await new Promise<void>((resolveAck, rejectAck) => {
          let done = false;
          const timer = setTimeout(() => finish(new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE")), 10_000);
          const finish = (error?: Error): void => {
            if (done) return; done = true;
            clearTimeout(timer); if (this.#linuxAck === finish) this.#linuxAck = undefined;
            if (error === undefined) resolveAck(); else rejectAck(error);
          };
          this.#linuxAck = finish;
          try { child.stdin.write(line, error => { if (error) finish(new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE")); }); }
          catch { finish(new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE")); }
        });
      } finally { settled?.(); }
    }).catch(() => { if (generation === this.#generation && this.#child === child) this.#failed(); })
      .finally(() => { if (generation === this.#generation) this.#linuxQueueBytes -= size; });
  }

  #failed(): void {
    this.stop();
    this.#onFailure();
  }
}

export async function readDesktopRemoteDesktopInputPermission(
  resolveBinary: (prepare?: boolean) => Promise<string> = resolveDesktopRemoteDesktopInputBinary
): Promise<"granted" | "missing" | "unknown" | "notRequired"> {
  if (process.platform !== "darwin") return "notRequired";
  try {
    const { stdout } = await exec(await resolveBinary(false), ["--check"], {
      timeout: 5_000,
      maxBuffer: 1_024,
      windowsHide: true
    });
    const value = stdout.trim();
    return value === "ready" ? "granted" : value === "permission" ? "missing" : "unknown";
  } catch {
    return "unknown";
  }
}

export interface DesktopRemoteDesktopLockRuntime {
  readonly platform: NodeJS.Platform;
  resolveBinary(): Promise<string>;
  execute(binary: string, args: readonly string[], signal: AbortSignal): Promise<{ readonly stdout: string }>;
}

/** One trusted fixed command; no caller-provided keys, password or shell. */
export async function lockDesktopRemoteDesktopScreen(
  current: () => boolean,
  signal: AbortSignal,
  runtime: DesktopRemoteDesktopLockRuntime = {
    platform: process.platform,
    resolveBinary: resolveDesktopRemoteDesktopInputBinary,
    execute: (binary, args, cancellation) => exec(binary, args, {
      timeout: 5_000, maxBuffer: 1_024, windowsHide: true, signal: cancellation
    })
  }
): Promise<void> {
  if (runtime.platform !== "darwin") throw new Error("REMOTE_DESKTOP_LOCK_UNAVAILABLE");
  const check = (): void => {
    if (signal.aborted || !current()) throw new Error("REMOTE_DESKTOP_LOCK_EXPIRED");
  };
  check();
  try {
    const binary = await runtime.resolveBinary();
    check();
    const { stdout } = await runtime.execute(binary, ["--lock-screen"], signal);
    check();
    if (stdout.trim() !== "locked") throw new Error("REMOTE_DESKTOP_LOCK_FAILED");
  } catch {
    check();
    // execFile errors can contain native stdout/stderr. Keep only the code.
    throw new Error("REMOTE_DESKTOP_LOCK_FAILED");
  }
}

/**
 * Positive native proof of the current macOS console session. Unknown helper
 * output, pre-login/FileVault/loginwindow, another user and process errors are
 * never promoted to a viewable state.
 */
export async function readDesktopRemoteDesktopSessionState(
  signal: AbortSignal,
  resolveBinary: (prepare?: boolean) => Promise<string> = resolveDesktopRemoteDesktopInputBinary
): Promise<DesktopRemoteDesktopSessionState> {
  if (process.platform !== "darwin") return "unsupported";
  throwIfAborted(signal);
  try {
    const binary = await resolveBinary();
    throwIfAborted(signal);
    const { stdout } = await exec(binary, ["--lock-state"], {
      timeout: 5_000,
      maxBuffer: 1_024,
      windowsHide: true,
      signal
    });
    throwIfAborted(signal);
    const value = stdout.trim();
    return value === "unlocked" || value === "locked-logged-in" || value === "unsupported"
      ? value
      : "unknown";
  } catch {
    if (signal.aborted) throw signal.reason ?? new Error("Remote Desktop session probe was aborted.");
    return "unknown";
  }
}

/** Enumerates only bounded, desktop-usable modes from the selected display. */
export async function readDesktopRemoteDesktopDisplayModes(
  displayId: string,
  signal: AbortSignal,
  resolveBinary: (prepare?: boolean) => Promise<string> = resolveDesktopRemoteDesktopInputBinary
): Promise<readonly RemoteDesktopDisplayMode[]> {
  if (process.platform !== "darwin" || !/^[0-9]{1,10}$/u.test(displayId)) {
    throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
  }
  throwIfAborted(signal);
  try {
    const binary = await resolveBinary();
    throwIfAborted(signal);
    const { stdout } = await exec(binary, ["--display-modes", displayId], {
      timeout: 5_000,
      maxBuffer: 64_000,
      windowsHide: true,
      signal
    });
    throwIfAborted(signal);
    const value: unknown = JSON.parse(stdout);
    if (!Array.isArray(value) || value.length < 1 || value.length > 256) throw new Error("invalid");
    const modes = value.map((candidate): RemoteDesktopDisplayMode => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)
        || Object.keys(candidate).sort().join(",") !== "current,height,id,native,width") {
        throw new Error("invalid");
      }
      const mode = candidate as Record<string, unknown>;
      if (typeof mode["id"] !== "string" || !/^[0-9]{1,10}$/u.test(mode["id"])
        || !Number.isSafeInteger(mode["width"]) || !Number.isSafeInteger(mode["height"])
        || (mode["width"] as number) < 1 || (mode["width"] as number) > 32_768
        || (mode["height"] as number) < 1 || (mode["height"] as number) > 32_768
        || typeof mode["current"] !== "boolean" || typeof mode["native"] !== "boolean") {
        throw new Error("invalid");
      }
      return Object.freeze({
        id: mode["id"],
        width: mode["width"] as number,
        height: mode["height"] as number,
        current: mode["current"],
        native: mode["native"]
      });
    });
    if (new Set(modes.map((mode) => mode.id)).size !== modes.length
      || modes.filter((mode) => mode.current).length !== 1) {
      throw new Error("invalid");
    }
    return Object.freeze(modes);
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? new Error("Remote Desktop display mode request was aborted.");
    if (error instanceof Error && error.message === "REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE") throw error;
    throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
  }
}

let changingDisplayMode = false;

export interface DesktopRemoteDesktopDisplayModeProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface DesktopRemoteDesktopDisplayModeRuntime {
  readonly platform: NodeJS.Platform;
  resolveBinary(): Promise<string>;
  readModes(displayId: string, signal: AbortSignal): Promise<readonly RemoteDesktopDisplayMode[]>;
  spawn(binary: string, arguments_: readonly string[]): DesktopRemoteDesktopDisplayModeProcess;
  display(displayId: string): RemoteDesktopDisplay | undefined;
}

/** Re-enumerates, drains old input, then waits for actual native close and geometry. */
export async function setDesktopRemoteDesktopDisplayMode(
  displayId: string,
  modeId: string,
  beforeChange: () => void | Promise<void>,
  signal: AbortSignal,
  expected?: { readonly width: number; readonly height: number },
  runtime: DesktopRemoteDesktopDisplayModeRuntime = electronDisplayModeRuntime()
): Promise<RemoteDesktopDisplay> {
  if (changingDisplayMode) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
  changingDisplayMode = true;
  try {
    validateDisplayModeTarget(displayId, modeId, runtime);
    throwIfAborted(signal);
    const modes = await runtime.readModes(displayId, signal);
    const mode = modes.find((candidate) => candidate.id === modeId);
    if (mode === undefined || (expected !== undefined
      && (mode.width !== expected.width || mode.height !== expected.height))) {
      throw new Error("REMOTE_DESKTOP_DISPLAY_MODE_MISSING");
    }
    const binary = await runtime.resolveBinary();
    throwIfAborted(signal);
    await beforeChange();
    throwIfAborted(signal);
    await writeDesktopDisplayMode(binary, ["--display-mode", displayId, modeId], signal, runtime);
    return await waitForDesktopDisplayGeometry(displayId, expected ?? mode, () => true, signal, runtime);
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Remote Desktop display mode request was aborted.");
    }
    const code = error instanceof Error ? error.message : "";
    if (code === "REMOTE_DESKTOP_DISPLAY_BUSY"
      || code === "REMOTE_DESKTOP_DISPLAY_MODE_MISSING"
      || code === "REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE"
      || code === "REMOTE_DESKTOP_LEASE_EXPIRED"
      || code === "REMOTE_DESKTOP_VIEW_ONLY"
      || code === "REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED") throw error;
    throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
  } finally {
    changingDisplayMode = false;
  }
}

/** Original mode IDs are validated by native full CG enumeration, without UI deduplication. */
export async function restoreDesktopRemoteDesktopDisplayMode(
  displayId: string,
  modeId: string,
  current: () => boolean,
  expected: { readonly width: number; readonly height: number },
  signal: AbortSignal,
  runtime: DesktopRemoteDesktopDisplayModeRuntime = electronDisplayModeRuntime()
): Promise<RemoteDesktopDisplay> {
  if (changingDisplayMode) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
  changingDisplayMode = true;
  try {
    validateDisplayModeTarget(displayId, modeId, runtime);
    const check = (): void => {
      if (!current() || signal.aborted) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    };
    check();
    const binary = await runtime.resolveBinary();
    check();
    await writeDesktopDisplayMode(binary, ["--restore-display-mode", displayId, modeId], signal, runtime);
    check();
    return await waitForDesktopDisplayGeometry(displayId, expected, current, signal, runtime);
  } catch {
    throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
  } finally {
    changingDisplayMode = false;
  }
}

function validateDisplayModeTarget(
  displayId: string,
  modeId: string,
  runtime: DesktopRemoteDesktopDisplayModeRuntime
): void {
  if (runtime.platform !== "darwin") throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
  if (!/^[0-9]{1,10}$/u.test(displayId) || !/^[0-9]{1,10}$/u.test(modeId)) {
    throw new Error("REMOTE_DESKTOP_DISPLAY_MODE_MISSING");
  }
}

async function writeDesktopDisplayMode(
  binary: string,
  arguments_: readonly string[],
  signal: AbortSignal,
  runtime: DesktopRemoteDesktopDisplayModeRuntime
): Promise<void> {
  throwIfAborted(signal);
  const child = runtime.spawn(binary, arguments_);
  // Killing a dispatched helper is not proof that its display write did not happen.
  // The global write slot remains occupied until this exact child actually closes.
  await new Promise<void>((resolveWrite, rejectWrite) => {
    let failed = false;
    let output = Buffer.alloc(0);
    const stop = (): void => {
      failed = true;
      try { child.kill("SIGKILL"); } catch { /* Actual close still owns settlement. */ }
    };
    const data = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (output.length + bytes.length > 1_024) { stop(); return; }
      output = Buffer.concat([output, bytes]);
    };
    const timer = setTimeout(stop, 5_000);
    signal.addEventListener("abort", stop, { once: true });
    child.stderr.resume();
    child.stderr.on("error", stop);
    child.stdout.on("data", data);
    child.stdout.on("error", stop);
    child.once("error", stop);
    child.once("close", (code, termination) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      child.stdout.removeListener("data", data);
      child.stdout.removeListener("error", stop);
      child.stderr.removeListener("error", stop);
      if (signal.aborted) rejectWrite(signal.reason ?? new Error("REMOTE_DESKTOP_LEASE_EXPIRED"));
      else if (failed || code !== 0 || termination !== null || output.toString("utf8").trim() !== "ready") {
        rejectWrite(new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE"));
      } else resolveWrite();
    });
    if (signal.aborted) stop();
  });
}

async function waitForDesktopDisplayGeometry(
  displayId: string,
  expected: { readonly width: number; readonly height: number },
  current: () => boolean,
  signal: AbortSignal,
  runtime: DesktopRemoteDesktopDisplayModeRuntime
): Promise<RemoteDesktopDisplay> {
  for (let attempt = 0; attempt <= 60; attempt += 1) {
    throwIfAborted(signal);
    if (!current()) throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    const display = runtime.display(displayId);
    if (display === undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
    if (display.width === expected.width && display.height === expected.height) return display;
    if (attempt < 60) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
}

function electronDisplayModeRuntime(): DesktopRemoteDesktopDisplayModeRuntime {
  return {
    platform: process.platform,
    resolveBinary: resolveDesktopRemoteDesktopInputBinary,
    readModes: readDesktopRemoteDesktopDisplayModes,
    spawn: (binary, arguments_) => spawn(binary, [...arguments_], { stdio: "pipe", windowsHide: true }),
    display: (displayId) => {
      const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === displayId);
      return display === undefined ? undefined : Object.freeze({
        id: String(display.id), name: display.label || `Display ${displayId}`,
        width: display.size.width, height: display.size.height
      });
    }
  };
}

/** Reads only the native clipboard change counter; clipboard content never enters helper output. */
export async function readDesktopRemoteDesktopClipboardVersion(
  portable: boolean,
  signal: AbortSignal,
  resolveBinary: (prepare?: boolean) => Promise<string> = resolveDesktopRemoteDesktopInputBinary
): Promise<string> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
  }
  throwIfAborted(signal);
  try {
    const binary = await resolveBinary();
    throwIfAborted(signal);
    const { stdout } = await exec(binary, [
      portable && process.platform === "darwin"
        ? "--clipboard-content-version"
        : "--clipboard-version"
    ], {
      timeout: 2_000,
      maxBuffer: 128,
      windowsHide: true,
      signal
    });
    throwIfAborted(signal);
    const version = stdout.trim();
    if (!/^[0-9]+$/u.test(version)) throw new Error("invalid");
    return version;
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Remote Desktop clipboard request was aborted.");
    }
    if (portable && process.platform === "darwin"
      && typeof error === "object" && error !== null && "code" in error
      && error.code === 3) {
      throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
    }
    // Never preserve native stderr/stdout in a public error: some operating
    // system failures can include clipboard metadata.
    throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
  }
}

/**
 * Reads the focused accessibility selection. An empty string is a confirmed
 * empty selection; every permission/protected/unsupported/error case throws.
 */
export async function readDesktopRemoteDesktopSelection(
  portable: boolean,
  signal: AbortSignal,
  resolveBinary: (prepare?: boolean) => Promise<string> = resolveDesktopRemoteDesktopInputBinary
): Promise<string> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
  }
  throwIfAborted(signal);
  try {
    const binary = await resolveBinary();
    throwIfAborted(signal);
    const { stdout } = await exec(binary, [
      portable ? "--clipboard-content-selection" : "--clipboard-selection"
    ], {
      timeout: 3_000,
      maxBuffer: 128 * 1_024,
      windowsHide: true,
      signal
    });
    throwIfAborted(signal);
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.keys(value).length !== 1 || !("text" in value)
      || typeof value.text !== "string"
      || value.text.length > 16_384) {
      throw new Error("invalid");
    }
    return value.text;
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Remote Desktop clipboard request was aborted.");
    }
    // execFile and JSON errors may carry stdout. Always replace them so a
    // selected value can never enter a diagnostic or log through the error.
    throw new Error("REMOTE_DESKTOP_CLIPBOARD_COPY_FAILED");
  }
}

let inputBuild: Promise<string> | undefined;

export async function resolveDesktopRemoteDesktopInputBinary(prepare = true): Promise<string> {
  const platform = process.platform;
  if (platform === "linux") return resolveDesktopRemoteDesktopLinuxBinary("input");
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("REMOTE_DESKTOP_INPUT_UNSUPPORTED");
  }
  const binaryName = platform === "darwin"
    ? "joko-macos-remote-desktop-input"
    : "joko-windows-remote-desktop-input.exe";
  if (app.isPackaged) {
    try {
      return await verifyPackagedDesktopRemoteDesktopBinary(
        join(process.resourcesPath, "native-remote-desktop"),
        "input",
        binaryName,
        platform,
        process.arch
      );
    } catch {
      throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    }
  }
  if (inputBuild !== undefined && prepare) return inputBuild;
  const build = async (): Promise<string> => {
    const sourceRoot = join(app.getAppPath(), "native", "remote-desktop");
    const source = platform === "darwin"
      ? join(sourceRoot, "macos-input.swift")
      : join(sourceRoot, "windows-input", "src", "main.rs");
    const digest = createHash("sha256").update(await readFile(source)).update(process.arch).update("v1-O");
    if (platform === "darwin") {
      digest.update(await readFile(join(sourceRoot, "macos-caller.swift")));
    } else {
      for (const file of [
        join(sourceRoot, "windows-input", "src", "desktop.rs"),
        join(sourceRoot, "windows-input", "src", "selection.rs"),
        join(sourceRoot, "windows-input", "Cargo.toml"),
        join(sourceRoot, "windows-input", "Cargo.lock")
      ]) digest.update(await readFile(file));
    }
    const directory = join(app.getPath("userData"), "remote-desktop", "native", digest.digest("hex"));
    const binary = join(directory, binaryName);
    try {
      await access(binary);
      return binary;
    } catch {
      if (!prepare) throw new Error("REMOTE_DESKTOP_INPUT_NOT_PREPARED");
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${binary}.${process.pid}.tmp`;
    try {
      if (platform === "darwin") {
        const buildDirectory = await mkdtemp(join(directory, "compile-"));
        try {
          const main = join(buildDirectory, "main.swift");
          const caller = await readFile(join(sourceRoot, "macos-caller.swift"), "utf8");
          const body = await readFile(source, "utf8");
          const program = `${caller}\n${body}`.replace(
            "REMOTE_DESKTOP_INPUT_DEVELOPMENT_EXECUTABLE",
            Buffer.from(process.execPath).toString("base64")
          );
          await writeFile(main, program, { mode: 0o600 });
          await exec("xcrun", ["--sdk", "macosx", "swiftc", "-D", "REMOTE_DESKTOP_INPUT_DEVELOPMENT",
            main, "-O", "-framework", "ApplicationServices", "-framework", "AppKit", "-framework", "Security",
            "-framework", "IOKit",
            "-o", temporary], { timeout: 120_000, windowsHide: true });
        } finally {
          await rm(buildDirectory, { recursive: true, force: true });
        }
      } else {
        const manifest = join(sourceRoot, "windows-input", "Cargo.toml");
        const buildDirectory = join(directory, "build");
        const portableCargo = resolve(app.getAppPath(), "..", "..", ".runtime", "rust-toolchain", "bin", "cargo.exe");
        const cargo = process.env.JOKO_CARGO_EXECUTABLE
          ?? await access(portableCargo).then(() => portableCargo, () => "cargo");
        const target = process.arch === "x64"
          ? "x86_64-pc-windows-msvc"
          : process.arch === "arm64"
            ? "aarch64-pc-windows-msvc"
            : undefined;
        if (target === undefined) throw new Error("REMOTE_DESKTOP_INPUT_UNSUPPORTED");
        await exec(cargo, ["build", "--release", "--locked", "--manifest-path", manifest,
          "--target", target, "--target-dir", buildDirectory], {
          timeout: 180_000,
          windowsHide: true,
          env: {
            ...process.env,
            PATH: `${dirname(cargo)};${process.env.PATH ?? process.env.Path ?? ""}`
          }
        });
        await copyFile(join(buildDirectory, target, "release", binaryName), temporary);
      }
      await rename(temporary, binary);
    } finally {
      await rm(temporary, { force: true });
    }
    return binary;
  };
  if (!prepare) return build();
  inputBuild = build().finally(() => { inputBuild = undefined; });
  return inputBuild;
}

function electronInputRuntime(): DesktopRemoteDesktopInputRuntime {
  return {
    platform: process.platform,
    resolveBinary: resolveDesktopRemoteDesktopInputBinary,
    spawn: (binary) => spawn(binary, [], { stdio: "pipe", windowsHide: true }),
    display: (displayId) => {
      const display = screen.getAllDisplays().find((item) => String(item.id) === displayId);
      return display === undefined ? undefined : Object.freeze({
        id: String(display.id),
        name: display.label || `Display ${displayId}`,
        width: display.bounds.width,
        height: display.bounds.height,
        x: display.bounds.x,
        y: display.bounds.y
      });
    },
    toPhysicalPoint: (point) => process.platform === "win32" ? screen.dipToScreenPoint(point) : point
  };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Remote Desktop input was aborted.");
}
