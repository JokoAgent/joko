import { execFile } from "node:child_process";

import type { DedicatedHardwareActionEvent } from "./actions.js";
import {
  DEDICATED_HARDWARE_SCROLL_WATCHDOG_MS,
  dedicatedHardwareScrollSpeed,
  type ContinuousScrollStopReason
} from "./continuous-scroll.js";

export const SYSTEM_FRONTMOST_WINDOWS_WHEEL_NOTCH = 120;
export const SYSTEM_FRONTMOST_SCROLL_TICK_MS = 16;
export const SYSTEM_FRONTMOST_SCROLL_MAX_ELAPSED_MS = 100;

const COMMAND_TIMEOUT_MS = 4_000;
const MAX_NATIVE_TARGET = 9_223_372_036_854_775_807n;
const WINDOWS_NATIVE_DECLARATION = [
  "$signature = '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
  "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);",
  "[DllImport(\"user32.dll\")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);",
  "[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
  "[DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint source, uint target, bool attach);",
  "[DllImport(\"user32.dll\")] public static extern IntPtr GetFocus();",
  "[DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();';",
  "$native = Add-Type -MemberDefinition $signature -Name JokoFrontmost -Namespace Joko.Native -PassThru;"
].join(" ");
const WINDOWS_RETURN_SCRIPT = [
  WINDOWS_NATIVE_DECLARATION,
  "[int64]$target = 0; [uint32]$expectedPid = 0;",
  "if (![int64]::TryParse($args[0], [ref]$target) -or $target -le 0 -or ![uint32]::TryParse($args[1], [ref]$expectedPid) -or $expectedPid -eq 0) { exit 2 };",
  "$hwnd = [IntPtr]$target; [uint32]$actualPid = 0; [void]$native::GetWindowThreadProcessId($hwnd, [ref]$actualPid);",
  "if ($actualPid -eq 0 -or $actualPid -ne $expectedPid) { exit 3 };",
  "if (!$native::PostMessage($hwnd, 0x0100, [IntPtr]13, [IntPtr]::Zero)) { exit 4 };",
  "if (!$native::PostMessage($hwnd, 0x0101, [IntPtr]13, [IntPtr]::Zero)) { exit 5 }"
].join(" ");
const WINDOWS_SCROLL_SCRIPT = [
  WINDOWS_NATIVE_DECLARATION,
  "[int64]$target = 0; [uint32]$expectedPid = 0; [int32]$wheel = 0;",
  "if (![int64]::TryParse($args[0], [ref]$target) -or $target -le 0 -or ![uint32]::TryParse($args[1], [ref]$expectedPid) -or $expectedPid -eq 0) { exit 2 };",
  "$hwnd = [IntPtr]$target; [uint32]$actualPid = 0; [void]$native::GetWindowThreadProcessId($hwnd, [ref]$actualPid);",
  "if ($actualPid -eq 0 -or $actualPid -ne $expectedPid) { exit 3 };",
  "if (![int32]::TryParse($args[2], [ref]$wheel) -or $wheel -eq 0 -or [Math]::Abs([int64]$wheel) -gt 2400) { exit 4 };",
  "$wParam = [IntPtr]([int64]$wheel -shl 16);",
  "if (!$native::PostMessage($hwnd, 0x020A, $wParam, [IntPtr]::Zero)) { exit 5 }"
].join(" ");
const WINDOWS_PASTE_SCRIPT = [
  WINDOWS_NATIVE_DECLARATION,
  "[int64]$target = 0; [uint32]$expectedPid = 0;",
  "if (![int64]::TryParse($args[0], [ref]$target) -or $target -le 0 -or ![uint32]::TryParse($args[1], [ref]$expectedPid) -or $expectedPid -eq 0) { exit 2 };",
  "$hwnd = [IntPtr]$target; [uint32]$actualPid = 0; [uint32]$targetThread = $native::GetWindowThreadProcessId($hwnd, [ref]$actualPid);",
  "if ($targetThread -eq 0 -or $actualPid -eq 0 -or $actualPid -ne $expectedPid) { exit 3 };",
  "if (!$native::SetForegroundWindow($hwnd)) { exit 4 }; $foreground = $native::GetForegroundWindow(); if ($foreground.ToInt64() -ne $target) { exit 5 };",
  "[uint32]$confirmedPid = 0; [uint32]$confirmedThread = $native::GetWindowThreadProcessId($foreground, [ref]$confirmedPid); if ($confirmedThread -eq 0 -or $confirmedPid -ne $expectedPid) { exit 6 };",
  "$sourceThread = $native::GetCurrentThreadId(); $attached = $false;",
  "try { if ($sourceThread -ne $confirmedThread) { if (!$native::AttachThreadInput($sourceThread, $confirmedThread, $true)) { exit 7 }; $attached = $true };",
  "$focus = $native::GetFocus(); if ($focus -eq [IntPtr]::Zero) { exit 8 }; [uint32]$focusPid = 0; [void]$native::GetWindowThreadProcessId($focus, [ref]$focusPid);",
  "if ($focusPid -eq 0 -or $focusPid -ne $expectedPid) { exit 9 }; if (!$native::PostMessage($focus, 0x0302, [IntPtr]::Zero, [IntPtr]::Zero)) { exit 10 }",
  "} finally { if ($attached) { [void]$native::AttachThreadInput($sourceThread, $confirmedThread, $false) } }"
].join(" ");
const LINUX_RETURN_SCRIPT = [
  "target=\"$1\"; expected_pid=\"$2\"",
  "case \"$target\" in ''|0|0[0-9]*|*[!0-9]*) exit 2;; esac",
  "case \"$expected_pid\" in ''|0|0[0-9]*|*[!0-9]*) exit 3;; esac",
  "actual_pid=\"$(xdotool getwindowpid \"$target\")\" || exit 4",
  "[ \"$actual_pid\" = \"$expected_pid\" ] || exit 5",
  "exec xdotool key --window \"$target\" Return"
].join("\n");
const LINUX_SCROLL_SCRIPT = [
  "target=\"$1\"; expected_pid=\"$2\"; repeats=\"$3\"; button=\"$4\"",
  "case \"$target\" in ''|0|0[0-9]*|*[!0-9]*) exit 2;; esac",
  "case \"$expected_pid\" in ''|0|0[0-9]*|*[!0-9]*) exit 3;; esac",
  "case \"$repeats\" in ''|*[!0-9]*) exit 4;; esac",
  "[ \"$repeats\" -ge 1 ] && [ \"$repeats\" -le 20 ] || exit 4",
  "[ \"$button\" = 4 ] || [ \"$button\" = 5 ] || exit 5",
  "actual_pid=\"$(xdotool getwindowpid \"$target\")\" || exit 6",
  "[ \"$actual_pid\" = \"$expected_pid\" ] || exit 7",
  "exec xdotool click --window \"$target\" --repeat \"$repeats\" \"$button\""
].join("\n");
const LINUX_PASTE_SCRIPT = [
  "target=\"$1\"; expected_pid=\"$2\"",
  "case \"$target\" in ''|0|0[0-9]*|*[!0-9]*) exit 2;; esac",
  "case \"$expected_pid\" in ''|0|0[0-9]*|*[!0-9]*) exit 3;; esac",
  "actual_pid=\"$(xdotool getwindowpid \"$target\")\" || exit 4",
  "[ \"$actual_pid\" = \"$expected_pid\" ] || exit 5",
  "xdotool windowactivate --sync \"$target\" || exit 6",
  "focused=\"$(xdotool getwindowfocus)\" || exit 7",
  "[ \"$focused\" = \"$target\" ] || exit 8",
  "focused_pid=\"$(xdotool getwindowpid \"$focused\")\" || exit 9",
  "[ \"$focused_pid\" = \"$expected_pid\" ] || exit 10",
  "exec xdotool key --window \"$target\" --clearmodifiers ctrl+v"
].join("\n");

const SYSTEM_FRONTMOST_TARGET = Symbol("system-frontmost-target");
/** Opaque, validated native target and owning process captured at press time. */
export interface SystemFrontmostInputTarget {
  readonly platform: "win32" | "linux" | "darwin";
  readonly nativeId: string;
  readonly processId: number;
  readonly [SYSTEM_FRONTMOST_TARGET]: true;
}

export interface SystemFrontmostInputRunner {
  /** Posts Return only after revalidating the press-time target and owning process. */
  readonly postReturn: (target: SystemFrontmostInputTarget) => Promise<void>;
  /** Captures one external foreground target for the lifetime of a gesture. */
  readonly captureTarget: () => SystemFrontmostInputTarget;
  /** Sends the fixed paste capability; no text crosses this boundary. */
  readonly postPaste: (target: SystemFrontmostInputTarget) => Promise<void>;
  /** Positive deltas scroll up; negative deltas scroll down. */
  readonly postScroll: (target: SystemFrontmostInputTarget, deltaY: number) => Promise<void>;
}

export interface MacSystemFrontmostInputHelper {
  /** The helper must capture the native id and owning PID atomically. */
  readonly captureTarget: () => Readonly<{ nativeId: string; processId: number }>;
  /** Each helper effect must revalidate that nativeId still belongs to processId. */
  readonly postReturn: (target: Readonly<{ nativeId: string; processId: number }>) => Promise<void>;
  /** The helper must activate, revalidate, and paste without accepting arbitrary text. */
  readonly postPaste: (target: Readonly<{ nativeId: string; processId: number }>) => Promise<void>;
  readonly postScroll: (target: Readonly<{ nativeId: string; processId: number }>, deltaY: number) => Promise<void>;
}

export type SystemFrontmostCommandExecutor = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ timeoutMs: number; windowsHide: boolean }>
) => Promise<string | undefined>;

export type PlatformSystemFrontmostInput =
  | {
    readonly status: "available";
    readonly runner: SystemFrontmostInputRunner;
    readonly wheelNotch: number;
  }
  | { readonly status: "unsupported"; readonly reason: "platform" | "helper-unavailable" };

export interface PlatformSystemFrontmostInputOptions {
  readonly platform: NodeJS.Platform;
  readonly execute?: SystemFrontmostCommandExecutor;
  /** Must sample target+PID inside the admitted physical press callback without async work or process startup. */
  readonly atomicCapture?: () => Readonly<{ nativeId: string; processId: number }>;
  readonly macHelper?: MacSystemFrontmostInputHelper;
  readonly currentProcessId?: number;
}

interface NativeTargetIdentity {
  readonly nativeId: string;
  readonly processId: number;
}

/** Resolves only audited fixed commands; macOS remains unavailable without an injected Joko helper. */
export function createPlatformSystemFrontmostInput(
  options: PlatformSystemFrontmostInputOptions
): PlatformSystemFrontmostInput {
  if (options.platform !== "win32" && options.platform !== "linux" && options.platform !== "darwin") {
    return Object.freeze({ status: "unsupported", reason: "platform" });
  }
  const currentProcessId = validProcessId(options.currentProcessId ?? process.pid);
  if (options.platform === "darwin") {
    if (options.macHelper === undefined) return Object.freeze({ status: "unsupported", reason: "helper-unavailable" });
    const helper = options.macHelper;
    return Object.freeze({
      status: "available",
      wheelNotch: 0,
      runner: guardedRunner({
        captureTarget: helper.captureTarget,
        postReturn: (target) => helper.postReturn(target),
        postPaste: (target) => helper.postPaste(target),
        postScroll: (target, deltaY) => helper.postScroll(target, deltaY)
      }, "darwin", currentProcessId)
    });
  }
  const execute = options.execute ?? executeFile;
  const atomicCapture = options.atomicCapture;
  if (atomicCapture === undefined) {
    return Object.freeze({ status: "unsupported", reason: "helper-unavailable" });
  }
  if (options.platform === "win32") {
    return Object.freeze({
      status: "available",
      wheelNotch: SYSTEM_FRONTMOST_WINDOWS_WHEEL_NOTCH,
      runner: guardedRunner({
        postReturn: async (target) => {
          await execute("powershell.exe", [
            "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_RETURN_SCRIPT,
            target.nativeId, String(target.processId)
          ], commandOptions());
        },
        captureTarget: atomicCapture,
        postPaste: async (target) => {
          await execute("powershell.exe", [
            "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PASTE_SCRIPT,
            target.nativeId, String(target.processId)
          ], commandOptions());
        },
        postScroll: async (target, deltaY) => {
          await execute("powershell.exe", [
            "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCROLL_SCRIPT,
            target.nativeId, String(target.processId), String(deltaY)
          ], commandOptions());
        }
      }, "win32", currentProcessId)
    });
  }
  return Object.freeze({
    status: "available",
    wheelNotch: 0,
    runner: guardedRunner({
      postReturn: async (target) => {
        await execute("/bin/sh", [
          "-c", LINUX_RETURN_SCRIPT, "joko-system-input", target.nativeId, String(target.processId)
        ], commandOptions());
      },
      captureTarget: atomicCapture,
      postPaste: async (target) => {
        await execute("/bin/sh", [
          "-c", LINUX_PASTE_SCRIPT, "joko-system-input", target.nativeId, String(target.processId)
        ], commandOptions());
      },
      postScroll: async (target, deltaY) => {
        const repeats = Math.max(1, Math.min(20, Math.abs(Math.round(deltaY / 40))));
        await execute("/bin/sh", [
          "-c", LINUX_SCROLL_SCRIPT, "joko-system-input", target.nativeId, String(target.processId),
          String(repeats), deltaY > 0 ? "4" : "5"
        ], commandOptions());
      }
    }, "linux", currentProcessId)
  });
}

export function accumulateSystemFrontmostScrollNotches(
  remainder: number,
  deltaY: number,
  notch = SYSTEM_FRONTMOST_WINDOWS_WHEEL_NOTCH
): Readonly<{ remainder: number; deltaY: number }> {
  if (!Number.isFinite(remainder) || !Number.isFinite(deltaY)) return Object.freeze({ remainder: 0, deltaY: 0 });
  if (!Number.isFinite(notch) || notch <= 0) return Object.freeze({ remainder: 0, deltaY });
  const total = remainder + deltaY;
  const notches = total < 0 ? Math.ceil(total / notch) : Math.floor(total / notch);
  const emitted = notches * notch;
  return Object.freeze({ remainder: total - emitted, deltaY: emitted });
}

export interface SystemFrontmostScrollPumpOptions {
  readonly now?: () => number;
  readonly wheelNotch?: number;
  readonly tickMs?: number;
  readonly watchdogMs?: number;
  readonly onFailure?: (error: unknown) => void;
  readonly onStop?: (reason: ContinuousScrollStopReason) => void;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

type ScrollPhase = "idle" | "active";

/** Async-safe scroll pump: one captured target and at most one OS operation at a time, with no queue. */
export class SystemFrontmostScrollPump {
  readonly #runner: SystemFrontmostInputRunner;
  readonly #now: () => number;
  readonly #wheelNotch: number;
  readonly #tickMs: number;
  readonly #watchdogMs: number;
  readonly #onFailure: ((error: unknown) => void) | undefined;
  readonly #onStop: ((reason: ContinuousScrollStopReason) => void) | undefined;
  readonly #setInterval: typeof globalThis.setInterval;
  readonly #clearInterval: typeof globalThis.clearInterval;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #clearTimeout: typeof globalThis.clearTimeout;
  #interval: ReturnType<typeof globalThis.setInterval> | undefined;
  #watchdog: ReturnType<typeof globalThis.setTimeout> | undefined;
  #phase: ScrollPhase = "idle";
  #target: SystemFrontmostInputTarget | undefined;
  #speed = 0;
  #lastTickAt = 0;
  #remainder = 0;
  #postInFlight: symbol | undefined;
  #generation = 0;

  constructor(runner: SystemFrontmostInputRunner, options: SystemFrontmostScrollPumpOptions = {}) {
    const wheelNotch = options.wheelNotch ?? 0;
    const tickMs = options.tickMs ?? SYSTEM_FRONTMOST_SCROLL_TICK_MS;
    const watchdogMs = options.watchdogMs ?? DEDICATED_HARDWARE_SCROLL_WATCHDOG_MS;
    if (!Number.isFinite(wheelNotch) || wheelNotch < 0
      || !Number.isFinite(tickMs) || tickMs <= 0
      || !Number.isFinite(watchdogMs) || watchdogMs <= 0) {
      throw new TypeError("System frontmost scroll timing is invalid.");
    }
    this.#runner = runner;
    this.#now = options.now ?? Date.now;
    this.#wheelNotch = wheelNotch;
    this.#tickMs = tickMs;
    this.#watchdogMs = watchdogMs;
    this.#onFailure = options.onFailure;
    this.#onStop = options.onStop;
    this.#setInterval = options.setInterval ?? globalThis.setInterval;
    this.#clearInterval = options.clearInterval ?? globalThis.clearInterval;
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  }

  start(direction: "up" | "down", distance: number): boolean {
    if (this.#phase !== "idle") return this.move(direction, distance);
    if (this.#postInFlight !== undefined) return false;
    if (!this.#setSpeed(direction, distance)) return false;
    const generation = ++this.#generation;
    try {
      this.#target = this.#runner.captureTarget();
    } catch (error) {
      if (generation === this.#generation) {
        this.#speed = 0;
        this.#target = undefined;
        this.#reportFailure(error);
      }
      return false;
    }
    this.#phase = "active";
    this.#lastTickAt = this.#safeNow();
    this.#interval = this.#setInterval(() => this.tick(), this.#tickMs);
    const timer = this.#interval as ReturnType<typeof globalThis.setInterval> & { unref?: () => void };
    timer.unref?.();
    this.#armWatchdog();
    return true;
  }

  move(direction: "up" | "down", distance: number): boolean {
    if (this.#phase === "idle") return false;
    if (!this.#setSpeed(direction, distance)) {
      this.stop(validScrollInput(direction, distance) ? "dead-zone" : "invalid-input");
      return false;
    }
    this.#armWatchdog();
    return true;
  }

  tick(): void {
    if (this.#phase !== "active" || this.#target === undefined || this.#speed === 0 ||
        this.#postInFlight !== undefined) return;
    const now = this.#safeNow();
    const elapsedMs = Math.max(0, Math.min(SYSTEM_FRONTMOST_SCROLL_MAX_ELAPSED_MS, now - this.#lastTickAt));
    this.#lastTickAt = now;
    let deltaY = Math.round(this.#speed * elapsedMs / 1_000);
    if (this.#wheelNotch > 0) {
      const accumulated = accumulateSystemFrontmostScrollNotches(this.#remainder, deltaY, this.#wheelNotch);
      this.#remainder = accumulated.remainder;
      deltaY = accumulated.deltaY;
    }
    if (deltaY === 0) return;
    const generation = this.#generation;
    const target = this.#target;
    const post = Symbol("post");
    this.#postInFlight = post;
    void Promise.resolve()
      .then(() => this.#runner.postScroll(target, deltaY))
      .catch((error: unknown) => {
        if (generation !== this.#generation) return;
        this.stop("output-failed");
        this.#reportFailure(error);
      })
      .finally(() => {
        if (this.#postInFlight === post) this.#postInFlight = undefined;
      });
  }

  stop(reason: ContinuousScrollStopReason = "release"): boolean {
    const wasActive = this.#phase !== "idle";
    this.#generation += 1;
    this.#phase = "idle";
    this.#target = undefined;
    this.#speed = 0;
    this.#lastTickAt = 0;
    this.#remainder = 0;
    if (this.#interval !== undefined) {
      this.#clearInterval(this.#interval);
      this.#interval = undefined;
    }
    if (this.#watchdog !== undefined) {
      this.#clearTimeout(this.#watchdog);
      this.#watchdog = undefined;
    }
    if (wasActive) {
      try {
        this.#onStop?.(reason);
      } catch {
        // An observer cannot keep the synthetic input owner alive.
      }
    }
    return wasActive;
  }

  active(): boolean {
    return this.#phase !== "idle";
  }

  #setSpeed(direction: "up" | "down", distance: number): boolean {
    if (!validScrollInput(direction, distance)) return false;
    const magnitude = dedicatedHardwareScrollSpeed(distance);
    if (magnitude === 0) return false;
    this.#speed = direction === "up" ? magnitude : -magnitude;
    return true;
  }

  #armWatchdog(): void {
    if (this.#watchdog !== undefined) this.#clearTimeout(this.#watchdog);
    this.#watchdog = this.#setTimeout(() => {
      this.#watchdog = undefined;
      this.stop("watchdog");
    }, this.#watchdogMs);
    const timer = this.#watchdog as ReturnType<typeof globalThis.setTimeout> & { unref?: () => void };
    timer.unref?.();
  }

  #safeNow(): number {
    const value = this.#now();
    return Number.isFinite(value) ? value : 0;
  }

  #reportFailure(error: unknown): void {
    try {
      this.#onFailure?.(error);
    } catch {
      // Failure reporting cannot restart or retain an input stream.
    }
  }
}

export interface SystemFrontmostInputControllerOptions {
  readonly scrollPump?: SystemFrontmostScrollPump;
  readonly wheelNotch?: number;
  readonly onFailure?: (error: unknown) => void;
}

/** Consumes only the three system-authorized shapes; voice uses the separate generation lease. */
export class SystemFrontmostInputController {
  readonly #runner: SystemFrontmostInputRunner;
  readonly #scrollPump: SystemFrontmostScrollPump;
  readonly #onFailure: ((error: unknown) => void) | undefined;
  #returnInFlight: symbol | undefined;
  #returnGeneration = 0;

  constructor(runner: SystemFrontmostInputRunner, options: SystemFrontmostInputControllerOptions = {}) {
    this.#runner = runner;
    this.#onFailure = options.onFailure;
    this.#scrollPump = options.scrollPump ?? new SystemFrontmostScrollPump(runner, {
      ...(options.wheelNotch === undefined ? {} : { wheelNotch: options.wheelNotch }),
      ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure })
    });
  }

  handle(event: DedicatedHardwareActionEvent): boolean {
    if (event.kind === "button") {
      if (event.phase !== "press"
        || event.action.kind !== "command"
        || event.action.command !== "submit") return false;
      if (this.#returnInFlight !== undefined) return true;
      let target: SystemFrontmostInputTarget;
      try {
        target = this.#runner.captureTarget();
      } catch (error) {
        this.#reportFailure(error);
        return false;
      }
      const generation = ++this.#returnGeneration;
      const post = Symbol("return");
      this.#returnInFlight = post;
      void Promise.resolve()
        .then(() => generation === this.#returnGeneration ? this.#runner.postReturn(target) : undefined)
        .catch((error: unknown) => {
          if (generation === this.#returnGeneration) this.#reportFailure(error);
        })
        .finally(() => {
          if (this.#returnInFlight === post) this.#returnInFlight = undefined;
        });
      return true;
    }
    if (event.phase === "press") {
      this.#scrollPump.start(event.direction, event.distance);
      return true;
    }
    if (event.phase === "move") {
      this.#scrollPump.move(event.direction, event.distance);
      return true;
    }
    this.#scrollPump.stop(event.phase === "cancel" ? "cancel" : "release");
    return true;
  }

  cancel(): void {
    this.#returnGeneration += 1;
    this.#scrollPump.stop("cancel");
  }

  #reportFailure(error: unknown): void {
    try {
      this.#onFailure?.(error);
    } catch {
      // Failure reporting cannot cause command replay.
    }
  }
}

function guardedRunner(
  runner: {
    readonly postReturn: (target: NativeTargetIdentity) => Promise<void>;
    readonly captureTarget: () => unknown;
    readonly postPaste: (target: NativeTargetIdentity) => Promise<void>;
    readonly postScroll: (target: NativeTargetIdentity, deltaY: number) => Promise<void>;
  },
  platform: SystemFrontmostInputTarget["platform"],
  currentProcessId: number
): SystemFrontmostInputRunner {
  return Object.freeze({
    captureTarget: () => createTarget(runner.captureTarget(), platform, currentProcessId),
    postReturn: (target: SystemFrontmostInputTarget) => {
      let parsed: SystemFrontmostInputTarget;
      try {
        parsed = assertTargetForPlatform(target, platform);
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve().then(() => runner.postReturn(targetIdentity(parsed)));
    },
    postPaste: (target: SystemFrontmostInputTarget) => {
      let parsed: SystemFrontmostInputTarget;
      try {
        parsed = assertTargetForPlatform(target, platform);
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve().then(() => runner.postPaste(targetIdentity(parsed)));
    },
    postScroll: (target: SystemFrontmostInputTarget, deltaY: number) => {
      let parsed: SystemFrontmostInputTarget;
      try {
        parsed = assertTargetForPlatform(target, platform);
      } catch (error) {
        return Promise.reject(error);
      }
      if (!Number.isFinite(deltaY) || deltaY === 0) return Promise.reject(new TypeError("Scroll delta is invalid."));
      const bounded = Math.max(-2_400, Math.min(2_400, Math.round(deltaY)));
      return Promise.resolve().then(() => runner.postScroll(targetIdentity(parsed), bounded));
    }
  });
}

function parseNativeId(value: unknown): string {
  const target = typeof value === "string" ? value.trim() : "";
  if (!/^[1-9][0-9]{0,18}$/u.test(target) || BigInt(target) > MAX_NATIVE_TARGET) {
    throw new TypeError("System frontmost target is invalid.");
  }
  return target;
}

function parseProcessId(value: unknown): number {
  const parsed = parseNativeId(value);
  const numeric = Number(parsed);
  return validProcessId(numeric);
}

function createTarget(
  value: unknown,
  platform: SystemFrontmostInputTarget["platform"],
  currentProcessId: number
): SystemFrontmostInputTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("System frontmost captured identity is invalid.");
  }
  const identity = value as Record<string, unknown>;
  const keys = Object.keys(identity);
  if (keys.length !== 2 || !Object.hasOwn(identity, "nativeId") || !Object.hasOwn(identity, "processId")) {
    throw new TypeError("System frontmost captured identity is invalid.");
  }
  const nativeId = parseNativeId(identity.nativeId);
  const processId = validProcessId(identity.processId as number);
  if (processId === currentProcessId) throw new Error("The foreground target belongs to this process.");
  return Object.freeze({ platform, nativeId, processId, [SYSTEM_FRONTMOST_TARGET]: true as const });
}

function assertCapturedTarget(value: unknown): SystemFrontmostInputTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      (value as Partial<SystemFrontmostInputTarget>)[SYSTEM_FRONTMOST_TARGET] !== true || !Object.isFrozen(value)) {
    throw new TypeError("System frontmost target token is invalid.");
  }
  const target = value as SystemFrontmostInputTarget;
  if ((target.platform !== "win32" && target.platform !== "linux" && target.platform !== "darwin") ||
      parseNativeId(target.nativeId) !== target.nativeId || validProcessId(target.processId) !== target.processId) {
    throw new TypeError("System frontmost target token is invalid.");
  }
  return target;
}

function assertTargetForPlatform(
  value: unknown,
  platform: SystemFrontmostInputTarget["platform"]
): SystemFrontmostInputTarget {
  const target = assertCapturedTarget(value);
  if (target.platform !== platform) throw new TypeError("System frontmost target platform is invalid.");
  return target;
}

function targetIdentity(target: SystemFrontmostInputTarget): NativeTargetIdentity {
  return Object.freeze({ nativeId: target.nativeId, processId: target.processId });
}

function validProcessId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new TypeError("Current process identity is invalid.");
  }
  return value;
}

function validScrollInput(direction: unknown, distance: unknown): direction is "up" | "down" {
  return (direction === "up" || direction === "down") && typeof distance === "number" &&
    Number.isFinite(distance) && distance >= 0 && distance <= 1;
}

function commandOptions(): Readonly<{ timeoutMs: number; windowsHide: boolean }> {
  return Object.freeze({ timeoutMs: COMMAND_TIMEOUT_MS, windowsHide: true });
}

function executeFile(
  executable: string,
  args: readonly string[],
  options: Readonly<{ timeoutMs: number; windowsHide: boolean }>
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], {
      timeout: options.timeoutMs,
      windowsHide: options.windowsHide,
      encoding: "utf8"
    }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(error);
    });
  });
}
