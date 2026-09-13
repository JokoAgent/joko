import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { DesktopGlobalVoiceShortcut } from "./channels.js";
import { ShortcutHoldController, type ShortcutHoldPhase } from "./shortcut-hold-controller.js";

const FUNCTION_KEY = /^F(?:[1-9]|1\d|2[0-4])$/u;
const MAC_BARE_MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "Fn"
]);
const MAC_MODIFIER_CODES = new Set([
  ...MAC_BARE_MODIFIER_CODES,
  "ShiftLeft",
  "ShiftRight"
]);
const MAC_NATIVE_KEY_CODES = new Set([
  ...Array.from({ length: 26 }, (_value, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_value, index) => `Digit${index}`),
  ...Array.from({ length: 24 }, (_value, index) => `F${index + 1}`),
  "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash",
  "Semicolon", "Quote", "Comma", "Period", "Slash", "Space", "Tab", "Enter",
  "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"
]);
const MAC_HELPER_KEYS = new Set([
  ...MAC_MODIFIER_CODES,
  ...MAC_NATIVE_KEY_CODES,
  "Other",
]);
const START_TIMEOUT_MS = 3_000;
const RESTART_LIMIT = 3;
const MAX_PROTOCOL_LINE_BYTES = 64 * 1024;

export type NativeVoiceShortcutStartResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly reason: "unsupported" | "permission";
    readonly superseded?: true;
    readonly restorationFailed?: true;
  };

export type NativeVoiceInputMonitoringStatus = "granted" | "denied" | "not-required" | "unknown";

export interface NativeVoiceShortcutListenerOptions {
  readonly platform: NodeJS.Platform;
  readonly binaryPath?: string;
  readonly holdDelayMs?: number;
  readonly onPhase: (phase: ShortcutHoldPhase) => void;
  readonly onCaptureKeys?: (keys: readonly string[]) => void;
  readonly onMouseUp?: () => void;
  readonly onRestartLimitReached?: () => void;
  readonly spawnProcess?: (binary: string, args: readonly string[]) => ChildProcess;
}

export interface NativeVoiceShortcutBackend {
  readonly setShortcut: (shortcut: DesktopGlobalVoiceShortcut) => Promise<NativeVoiceShortcutStartResult>;
  readonly clearShortcut: () => void;
}

export interface NativeVoiceShortcutCaptureBackend {
  readonly startCapture: () => Promise<NativeVoiceShortcutStartResult>;
  readonly stopCapture: () => void;
}

interface NativeTarget {
  readonly code: string;
  readonly helperKey: string;
  readonly shortcut: DesktopGlobalVoiceShortcut;
}

interface ListenerPayload {
  readonly type?: unknown;
  readonly code?: unknown;
  readonly keys?: unknown;
  readonly message?: unknown;
  readonly pressed?: unknown;
}

/**
 * Owns the small platform helper used when Electron cannot observe key-up.
 * The helper reports physical state only; tap/hold product behavior remains in
 * the shared TypeScript controller.
 */
export class NativeVoiceShortcutListener {
  readonly #platform: NodeJS.Platform;
  readonly #binaryPath: string | undefined;
  readonly #onCaptureKeys: ((keys: readonly string[]) => void) | undefined;
  readonly #onMouseUp: (() => void) | undefined;
  readonly #onRestartLimitReached: (() => void) | undefined;
  readonly #spawnProcess: (binary: string, args: readonly string[]) => ChildProcess;
  readonly #phaseController: ShortcutHoldController;
  #child: ChildProcess | undefined;
  #ready = false;
  #pendingStart: Promise<NativeVoiceShortcutStartResult> | undefined;
  #startGeneration = 0;
  #target: NativeTarget | undefined;
  #captureActive = false;
  #captureGeneration = 0;
  #sessionDragActive = false;
  #sessionDragGeneration = 0;
  #restartAttempts = 0;
  #restartLimitNotified = false;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #stableTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: NativeVoiceShortcutListenerOptions) {
    this.#platform = options.platform;
    this.#binaryPath = options.binaryPath;
    this.#onCaptureKeys = options.onCaptureKeys;
    this.#onMouseUp = options.onMouseUp;
    this.#onRestartLimitReached = options.onRestartLimitReached;
    this.#spawnProcess = options.spawnProcess ?? ((binary, args) => spawn(binary, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }));
    this.#phaseController = new ShortcutHoldController({
      ...(options.holdDelayMs === undefined ? {} : { holdDelayMs: options.holdDelayMs }),
      onTrigger: options.onPhase
    });
  }

  isReady(): boolean {
    return this.#ready && this.#child !== undefined && !this.#child.killed;
  }

  isStarting(): boolean {
    return this.#pendingStart !== undefined && !this.#ready;
  }

  async setShortcut(shortcut: DesktopGlobalVoiceShortcut): Promise<NativeVoiceShortcutStartResult> {
    const target = nativeVoiceShortcutTarget(shortcut, this.#platform);
    if (target === undefined) {
      this.clearShortcut();
      return { ok: false, reason: "unsupported" };
    }

    const sameTarget = this.#target !== undefined && shortcutsEqual(this.#target.shortcut, shortcut);
    if (!sameTarget) {
      this.#phaseController.releaseIfPressed();
      this.#phaseController.reset();
    }
    this.#target = target;
    this.#restartAttempts = 0;
    this.#restartLimitNotified = false;
    this.#clearRestartTimer();
    this.#clearStableTimer();

    if (this.#platform === "win32" && (!sameTarget || !this.isReady())) {
      this.#stopChild(false);
    }
    return this.#ensureStarted();
  }

  clearShortcut(): void {
    this.#target = undefined;
    this.#restartAttempts = 0;
    this.#restartLimitNotified = false;
    this.#clearRestartTimer();
    this.#clearStableTimer();
    this.#phaseController.releaseIfPressed();
    this.#phaseController.reset();
    if (!this.#captureActive && !this.#sessionDragActive) this.#stopChild(false);
  }

  async startCapture(): Promise<NativeVoiceShortcutStartResult> {
    if (this.#platform !== "darwin") return { ok: false, reason: "unsupported" };
    const generation = ++this.#captureGeneration;
    this.#captureActive = true;
    this.#restartLimitNotified = false;
    const result = await this.#ensureStarted();
    if (generation !== this.#captureGeneration) return supersededResult();
    if (!result.ok) {
      this.#captureActive = false;
      if (this.#target === undefined && !this.#sessionDragActive) this.#stopChild(false);
    }
    return result;
  }

  stopCapture(): void {
    this.#captureGeneration += 1;
    this.#captureActive = false;
    this.#onCaptureKeys?.(Object.freeze([]));
    if (this.#target === undefined && !this.#sessionDragActive) this.#stopChild(false);
  }

  async armSessionDragRelease(): Promise<NativeVoiceShortcutStartResult> {
    if (this.#platform !== "darwin") return { ok: false, reason: "unsupported" };
    const generation = ++this.#sessionDragGeneration;
    this.#sessionDragActive = true;
    this.#restartLimitNotified = false;
    const result = await this.#ensureStarted();
    if (generation !== this.#sessionDragGeneration) return supersededResult();
    if (!result.ok) {
      this.#sessionDragActive = false;
      if (this.#target === undefined && !this.#captureActive) this.#stopChild(false);
    }
    return result;
  }

  disarmSessionDragRelease(): void {
    this.#sessionDragGeneration += 1;
    this.#sessionDragActive = false;
    if (this.#target === undefined && !this.#captureActive) {
      this.#restartAttempts = 0;
      this.#clearRestartTimer();
      this.#clearStableTimer();
      this.#stopChild(false);
    }
  }

  /** Safely closes an activation if suspend or screen lock consumes key-up. */
  releaseActiveTrigger(): void {
    const shouldRestart = this.isReady() && this.#isRequested();
    this.#phaseController.releaseIfPressed();
    this.#phaseController.reset();
    if (!shouldRestart) return;
    this.#stopChild(false);
    void this.#ensureStarted().then((result) => {
      if (!result.ok && !result.superseded) this.#scheduleRestart();
    });
  }

  dispose(): void {
    this.#captureGeneration += 1;
    this.#captureActive = false;
    this.#sessionDragGeneration += 1;
    this.#sessionDragActive = false;
    this.#target = undefined;
    this.#restartAttempts = 0;
    this.#clearRestartTimer();
    this.#clearStableTimer();
    this.#stopChild(true);
  }

  async inputMonitoringStatus(request = false): Promise<NativeVoiceInputMonitoringStatus> {
    if (this.#platform !== "darwin") return "not-required";
    const binary = this.#binaryPath;
    if (binary === undefined || !existsSync(binary)) return "unknown";
    return new Promise((resolve) => {
      execFile(binary, [request ? "--request-listen-access" : "--preflight-listen-access"], {
        encoding: "utf8",
        timeout: START_TIMEOUT_MS,
        windowsHide: true
      }, (error, stdout) => {
        if (error !== null) {
          resolve("unknown");
          return;
        }
        const payload = stdout.split(/\r?\n/u)
          .map((line) => parsePayload(line))
          .find((value) => value?.type === "permission");
        resolve(payload?.code === "granted" ? "granted" : payload?.code === "denied" ? "denied" : "unknown");
      });
    });
  }

  #isRequested(): boolean {
    return this.#target !== undefined || this.#captureActive || this.#sessionDragActive;
  }

  #ensureStarted(): Promise<NativeVoiceShortcutStartResult> {
    if (!this.#isRequested()) return Promise.resolve({ ok: false, reason: "unsupported" });
    if (this.isReady()) return Promise.resolve({ ok: true });
    if (this.#pendingStart !== undefined) return this.#pendingStart;
    const starting = this.#startProcess();
    this.#pendingStart = starting;
    void starting.finally(() => {
      if (this.#pendingStart === starting) this.#pendingStart = undefined;
    });
    return starting;
  }

  #startProcess(): Promise<NativeVoiceShortcutStartResult> {
    const binary = this.#binaryPath;
    if (binary === undefined || !existsSync(binary)) {
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }
    const target = this.#target;
    if (this.#platform === "win32" && target === undefined) {
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }
    const generation = ++this.#startGeneration;
    let child: ChildProcess;
    try {
      child = this.#spawnProcess(binary, this.#platform === "win32" ? [target?.code ?? ""] : []);
    } catch {
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      if (!child.killed) child.kill();
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }
    this.#child = child;
    this.#ready = false;

    return new Promise((resolve) => {
      let buffer = "";
      let settled = false;
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: NativeVoiceShortcutStartResult): void => {
        if (settled) return;
        settled = true;
        if (startTimer !== undefined) clearTimeout(startTimer);
        const stale = generation !== this.#startGeneration || this.#child !== child;
        const outcome: NativeVoiceShortcutStartResult = stale
          ? { ok: false, reason: "unsupported", superseded: true }
          : result;
        if (result.ok && !stale) {
          this.#ready = true;
          this.#armStableTimer();
        } else if (this.#child === child) {
          this.#child = undefined;
          this.#ready = false;
          this.#phaseController.releaseIfPressed();
          this.#phaseController.reset();
          if (!child.killed) child.kill();
        }
        resolve(outcome);
      };
      const fail = (reason: "unsupported" | "permission" = "unsupported"): void => {
        if (!settled) {
          settle({ ok: false, reason });
          return;
        }
        this.#failRunningChild(child);
      };

      startTimer = setTimeout(() => settle({ ok: false, reason: "unsupported" }), START_TIMEOUT_MS);
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string | Buffer) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const rawLine = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(rawLine, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
            buffer = "";
            fail();
            return;
          }
          const line = rawLine.trim();
          if (line !== "") {
            const payload = parsePayload(line);
            if (payload === undefined) {
              buffer = "";
              fail();
              return;
            }
            this.#handlePayload(payload, child, settle, fail);
          }
          if (this.#child !== child) {
            buffer = "";
            return;
          }
          newline = buffer.indexOf("\n");
        }
        if (Buffer.byteLength(buffer, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
          buffer = "";
          fail();
        }
      });
      stderr.resume();
      child.once("error", () => fail());
      child.once("exit", () => {
        const wasCurrent = this.#child === child;
        const wasReady = wasCurrent && this.#ready;
        if (!settled) settle({ ok: false, reason: "unsupported" });
        if (this.#child === child) {
          this.#child = undefined;
          this.#ready = false;
          this.#clearStableTimer();
          this.#phaseController.releaseIfPressed();
          this.#phaseController.reset();
        }
        if (wasReady && this.#isRequested()) this.#scheduleRestart();
      });
    });
  }

  #handlePayload(
    payload: ListenerPayload,
    child: ChildProcess,
    settle: (result: NativeVoiceShortcutStartResult) => void,
    fail: (reason?: "unsupported" | "permission") => void
  ): void {
    if (this.#child !== child) return;
    if (payload.type === "ready") {
      settle({ ok: true });
      return;
    }
    if (payload.type === "error") {
      fail(payload.code === "permission" ? "permission" : "unsupported");
      return;
    }
    if (!this.#ready) {
      fail();
      return;
    }
    if (this.#platform === "darwin" && payload.type === "keys") {
      const keys = normalizeMacHelperKeys(payload.keys);
      if (keys === undefined) {
        fail();
        return;
      }
      if (this.#captureActive) this.#onCaptureKeys?.(keys);
      const target = this.#target;
      if (target !== undefined) {
        const targetDown = keys.includes(target.helperKey);
        this.#phaseController.setPressed(matchesMacShortcut(keys, target.shortcut), targetDown);
      }
      return;
    }
    if (this.#platform === "darwin" && payload.type === "mouse-up" && exactPayloadKeys(payload, ["type"])) {
      if (!this.#sessionDragActive) return;
      this.#sessionDragGeneration += 1;
      this.#sessionDragActive = false;
      try {
        this.#onMouseUp?.();
      } catch {
        // The native gesture remains consumed even if its observer is unavailable.
      }
      if (this.#target === undefined && !this.#captureActive) this.#stopChild(false);
      return;
    }
    if (this.#platform === "win32" && payload.type === "canceled") {
      this.#phaseController.setPressed(false, true);
      return;
    }
    if (this.#platform === "win32" && payload.type === "pressed" && typeof payload.pressed === "boolean") {
      this.#phaseController.setPressed(payload.pressed);
      return;
    }
    fail();
  }

  #failRunningChild(child: ChildProcess): void {
    if (this.#child !== child) return;
    const shouldRestart = this.#ready && this.#isRequested();
    this.#child = undefined;
    this.#ready = false;
    this.#clearStableTimer();
    this.#phaseController.releaseIfPressed();
    this.#phaseController.reset();
    if (!child.killed) child.kill();
    if (shouldRestart) this.#scheduleRestart();
  }

  #stopChild(emitEnd: boolean): void {
    this.#startGeneration += 1;
    this.#pendingStart = undefined;
    const child = this.#child;
    this.#child = undefined;
    this.#ready = false;
    this.#clearStableTimer();
    if (emitEnd) this.#phaseController.releaseIfPressed();
    this.#phaseController.reset();
    if (child !== undefined && !child.killed) child.kill();
  }

  #scheduleRestart(): void {
    if (!this.#isRequested() || this.#restartTimer !== undefined) return;
    if (this.#restartAttempts >= RESTART_LIMIT) {
      this.#handleRestartLimitReached();
      return;
    }
    const delayMs = 1_000 * 2 ** this.#restartAttempts;
    this.#restartAttempts += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      if (!this.#isRequested() || this.#child !== undefined) return;
      void this.#ensureStarted().then((result) => {
        if (!result.ok && !result.superseded) this.#scheduleRestart();
      });
    }, delayMs);
  }

  #clearRestartTimer(): void {
    if (this.#restartTimer === undefined) return;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
  }

  #armStableTimer(): void {
    this.#clearStableTimer();
    this.#stableTimer = setTimeout(() => {
      this.#stableTimer = undefined;
      this.#restartAttempts = 0;
      this.#restartLimitNotified = false;
    }, 10_000);
  }

  #clearStableTimer(): void {
    if (this.#stableTimer === undefined) return;
    clearTimeout(this.#stableTimer);
    this.#stableTimer = undefined;
  }

  #handleRestartLimitReached(): void {
    if (this.#restartLimitNotified) return;
    this.#restartLimitNotified = true;
    this.#captureGeneration += 1;
    this.#captureActive = false;
    this.#sessionDragGeneration += 1;
    this.#sessionDragActive = false;
    this.#target = undefined;
    this.#onCaptureKeys?.(Object.freeze([]));
    this.#phaseController.releaseIfPressed();
    this.#phaseController.reset();
    try {
      this.#onRestartLimitReached?.();
    } catch {
      // The listener remains failed closed even if its observer is unavailable.
    }
  }
}

/**
 * Keeps the last accepted native binding committed until a replacement has
 * started, and restores it before reporting a failed replacement.
 */
export class NativeVoiceShortcutRegistration {
  readonly #backend: NativeVoiceShortcutBackend;
  #generation = 0;
  #shortcut: DesktopGlobalVoiceShortcut | undefined;

  constructor(backend: NativeVoiceShortcutBackend) {
    this.#backend = backend;
  }

  current(): DesktopGlobalVoiceShortcut | undefined {
    return this.#shortcut;
  }

  async replace(shortcut: DesktopGlobalVoiceShortcut): Promise<NativeVoiceShortcutStartResult> {
    const generation = ++this.#generation;
    const previous = this.#shortcut;
    const result = await this.#backend.setShortcut(shortcut);
    if (generation !== this.#generation) return supersededResult();
    if (result.ok) {
      this.#shortcut = shortcut;
      return result;
    }

    if (previous === undefined) {
      this.#backend.clearShortcut();
      return result;
    }
    const restored = await this.#backend.setShortcut(previous);
    if (generation !== this.#generation) return supersededResult();
    if (!restored.ok) {
      this.#shortcut = undefined;
      this.#backend.clearShortcut();
      return { ...result, restorationFailed: true };
    }
    return result;
  }

  clear(): void {
    this.#generation += 1;
    this.#shortcut = undefined;
    this.#backend.clearShortcut();
  }

  /** Clear an accepted binding after its listener exhausts bounded recovery. */
  invalidate(): void {
    this.clear();
  }
}

export interface NativeVoiceShortcutCaptureSubscriptionLifecycle {
  readonly beforeStart: () => Promise<void>;
  readonly afterStop: () => void;
}

/** Shares one native capture process across independently-lived trusted renderers. */
export class NativeVoiceShortcutCaptureSubscriptions<Owner> {
  readonly #backend: NativeVoiceShortcutCaptureBackend;
  readonly #lifecycle: NativeVoiceShortcutCaptureSubscriptionLifecycle;
  readonly #owners = new Set<Owner>();
  #generation = 0;
  #running = false;
  #pendingStart: Promise<boolean> | undefined;

  constructor(
    backend: NativeVoiceShortcutCaptureBackend,
    lifecycle: NativeVoiceShortcutCaptureSubscriptionLifecycle
  ) {
    this.#backend = backend;
    this.#lifecycle = lifecycle;
  }

  subscribers(): readonly Owner[] {
    return [...this.#owners];
  }

  recording(): boolean {
    return this.#owners.size > 0;
  }

  async start(owner: Owner): Promise<boolean> {
    this.#owners.add(owner);
    if (this.#running) return true;
    const pending = this.#pendingStart ?? this.#startSharedCapture();
    const started = await pending;
    return started && this.#owners.has(owner);
  }

  /** Returns true only when this release stopped the shared capture lifetime. */
  stop(owner?: Owner): boolean {
    if (owner === undefined) this.#owners.clear();
    else if (!this.#owners.delete(owner)) return false;
    if (this.#owners.size > 0) return false;
    this.#generation += 1;
    this.#running = false;
    this.#pendingStart = undefined;
    this.#backend.stopCapture();
    this.#lifecycle.afterStop();
    return true;
  }

  #startSharedCapture(): Promise<boolean> {
    const generation = ++this.#generation;
    const operation = (async (): Promise<boolean> => {
      try {
        await this.#lifecycle.beforeStart();
        if (generation !== this.#generation || this.#owners.size === 0) return false;
        const result = await this.#backend.startCapture();
        if (generation !== this.#generation || this.#owners.size === 0) return false;
        if (!result.ok) {
          this.#failSharedCapture(generation);
          return false;
        }
        this.#running = true;
        return true;
      } catch {
        if (generation === this.#generation) this.#failSharedCapture(generation);
        return false;
      }
    })();
    this.#pendingStart = operation;
    void operation.finally(() => {
      if (this.#pendingStart === operation) this.#pendingStart = undefined;
    });
    return operation;
  }

  #failSharedCapture(generation: number): void {
    if (generation !== this.#generation) return;
    this.#generation += 1;
    this.#owners.clear();
    this.#running = false;
    this.#pendingStart = undefined;
    this.#backend.stopCapture();
    this.#lifecycle.afterStop();
  }
}

export function isMacBareModifierShortcut(shortcut: DesktopGlobalVoiceShortcut): boolean {
  return MAC_BARE_MODIFIER_CODES.has(shortcut.code) && hasNoModifiers(shortcut);
}

export function isBareFunctionKeyShortcut(shortcut: DesktopGlobalVoiceShortcut): boolean {
  return FUNCTION_KEY.test(shortcut.code) && hasNoModifiers(shortcut);
}

export function nativeVoiceShortcutReservationAccelerator(
  shortcut: DesktopGlobalVoiceShortcut,
  platform: NodeJS.Platform
): string | undefined {
  return platform === "darwin" && isBareFunctionKeyShortcut(shortcut) ? shortcut.code : undefined;
}

export function nativeVoiceShortcutTarget(
  shortcut: DesktopGlobalVoiceShortcut,
  platform: NodeJS.Platform
): NativeTarget | undefined {
  if (platform === "darwin") {
    if (isMacBareModifierShortcut(shortcut)) return { code: shortcut.code, helperKey: shortcut.code, shortcut };
    if (isBareFunctionKeyShortcut(shortcut) || (shortcut.fn && MAC_NATIVE_KEY_CODES.has(shortcut.code))) {
      return { code: shortcut.code, helperKey: shortcut.code, shortcut };
    }
  }
  if (platform === "win32" && isBareFunctionKeyShortcut(shortcut)) {
    return { code: shortcut.code, helperKey: shortcut.code, shortcut };
  }
  return undefined;
}

export function resolveNativeVoiceShortcutBinaryPath(options: {
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly resourcesPath: string;
  readonly sourceDirectory: string;
}): string | undefined {
  const executable = options.platform === "darwin"
    ? "joko-macos-key-listener"
    : options.platform === "win32"
      ? "joko-windows-function-key-listener.exe"
      : undefined;
  if (executable === undefined) return undefined;
  const root = options.packaged ? options.resourcesPath : options.sourceDirectory;
  return join(root, "native-voice-shortcut", executable);
}

function hasNoModifiers(shortcut: DesktopGlobalVoiceShortcut): boolean {
  return !shortcut.meta && !shortcut.ctrl && !shortcut.alt && !shortcut.shift && !shortcut.fn;
}

function matchesMacShortcut(keys: readonly string[], shortcut: DesktopGlobalVoiceShortcut): boolean {
  if (keys.includes("Other")) return false;
  if (isMacBareModifierShortcut(shortcut)) return keys.length === 1 && keys[0] === shortcut.code;
  const nonModifiers = keys.filter((key) => !MAC_MODIFIER_CODES.has(key));
  if (nonModifiers.length !== 1 || nonModifiers[0] !== shortcut.code) return false;
  const keySet = new Set(keys);
  if (isBareFunctionKeyShortcut(shortcut)) {
    return !hasModifierGroup(keySet, "MetaLeft", "MetaRight")
      && !hasModifierGroup(keySet, "ControlLeft", "ControlRight")
      && !hasModifierGroup(keySet, "AltLeft", "AltRight")
      && !hasModifierGroup(keySet, "ShiftLeft", "ShiftRight");
  }
  return keySet.has("Fn") === shortcut.fn
    && hasModifierGroup(keySet, "MetaLeft", "MetaRight") === shortcut.meta
    && hasModifierGroup(keySet, "ControlLeft", "ControlRight") === shortcut.ctrl
    && hasModifierGroup(keySet, "AltLeft", "AltRight") === shortcut.alt
    && hasModifierGroup(keySet, "ShiftLeft", "ShiftRight") === shortcut.shift;
}

function hasModifierGroup(keys: ReadonlySet<string>, left: string, right: string): boolean {
  return keys.has(left) || keys.has(right);
}

function shortcutsEqual(left: DesktopGlobalVoiceShortcut, right: DesktopGlobalVoiceShortcut): boolean {
  return left.code === right.code
    && left.meta === right.meta
    && left.ctrl === right.ctrl
    && left.alt === right.alt
    && left.shift === right.shift
    && left.fn === right.fn;
}

function supersededResult(): NativeVoiceShortcutStartResult {
  return { ok: false, reason: "unsupported", superseded: true };
}

function parsePayload(line: string): ListenerPayload | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as ListenerPayload
      : undefined;
  } catch {
    return undefined;
  }
}

function exactPayloadKeys(payload: ListenerPayload, keys: readonly string[]): boolean {
  const actual = Object.keys(payload);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(payload, key));
}

function normalizeMacHelperKeys(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 16) return undefined;
  if (!value.every((entry): entry is string => typeof entry === "string" && MAC_HELPER_KEYS.has(entry))) {
    return undefined;
  }
  const keys = new Set(value);
  if (keys.size !== value.length) return undefined;
  return Object.freeze([...keys].sort());
}
