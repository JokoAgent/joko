export const DEDICATED_HARDWARE_SCROLL_ACTIVATION_DISTANCE = 0.5;
export const DEDICATED_HARDWARE_MIN_SCROLL_SPEED = 90;
export const DEDICATED_HARDWARE_MAX_SCROLL_SPEED = 2_600;
export const DEDICATED_HARDWARE_MAX_SCROLL_ELAPSED_MS = 100;
export const DEDICATED_HARDWARE_SCROLL_WATCHDOG_MS = 10_000;

const DEFAULT_TICK_MS = 16;

export type ContinuousScrollStopReason =
  | "release"
  | "cancel"
  | "dead-zone"
  | "watchdog"
  | "invalid-input"
  | "output-failed";

export interface ContinuousScrollControllerOptions {
  readonly onDelta: (deltaY: number) => void;
  readonly onStop?: (reason: ContinuousScrollStopReason) => void;
  readonly now?: () => number;
  readonly tickMs?: number;
  readonly watchdogMs?: number;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

/** Raw stick distance to a precise-scroll speed with a squared response curve. */
export function dedicatedHardwareScrollSpeed(distance: number): number {
  if (!Number.isFinite(distance) || distance <= DEDICATED_HARDWARE_SCROLL_ACTIVATION_DISTANCE) return 0;
  const normalized = Math.min(1, Math.max(0,
    (distance - DEDICATED_HARDWARE_SCROLL_ACTIVATION_DISTANCE)
      / (1 - DEDICATED_HARDWARE_SCROLL_ACTIVATION_DISTANCE)));
  return DEDICATED_HARDWARE_MIN_SCROLL_SPEED
    + (DEDICATED_HARDWARE_MAX_SCROLL_SPEED - DEDICATED_HARDWARE_MIN_SCROLL_SPEED)
      * normalized * normalized;
}

export function dedicatedHardwareScrollDelta(distance: number, elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return dedicatedHardwareScrollSpeed(distance)
    * Math.min(elapsedMs, DEDICATED_HARDWARE_MAX_SCROLL_ELAPSED_MS)
    / 1_000;
}

/**
 * Timer-driven scroll owner for the system-frontmost adapter. Every physical
 * sample refreshes a bounded watchdog; silence, invalid data, or callback
 * failure stops rather than leaving a synthetic input stream running.
 */
export class ContinuousScrollController {
  readonly #onDelta: (deltaY: number) => void;
  readonly #onStop: ((reason: ContinuousScrollStopReason) => void) | undefined;
  readonly #now: () => number;
  readonly #tickMs: number;
  readonly #watchdogMs: number;
  readonly #setInterval: typeof globalThis.setInterval;
  readonly #clearInterval: typeof globalThis.clearInterval;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #clearTimeout: typeof globalThis.clearTimeout;
  #interval: ReturnType<typeof globalThis.setInterval> | undefined;
  #watchdog: ReturnType<typeof globalThis.setTimeout> | undefined;
  #direction: "up" | "down" = "down";
  #distance = 0;
  #lastTickAt = 0;
  #active = false;

  constructor(options: ContinuousScrollControllerOptions) {
    const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    const watchdogMs = options.watchdogMs ?? DEDICATED_HARDWARE_SCROLL_WATCHDOG_MS;
    if (!Number.isFinite(tickMs) || tickMs <= 0 || !Number.isFinite(watchdogMs) || watchdogMs <= 0) {
      throw new TypeError("Continuous scroll timing is invalid.");
    }
    this.#onDelta = options.onDelta;
    this.#onStop = options.onStop;
    this.#now = options.now ?? Date.now;
    this.#tickMs = tickMs;
    this.#watchdogMs = watchdogMs;
    this.#setInterval = options.setInterval ?? globalThis.setInterval;
    this.#clearInterval = options.clearInterval ?? globalThis.clearInterval;
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  }

  update(direction: "up" | "down", distance: number): boolean {
    if ((direction !== "up" && direction !== "down")
      || !Number.isFinite(distance)
      || distance < 0
      || distance > 1) {
      this.stop("invalid-input");
      return false;
    }
    if (dedicatedHardwareScrollSpeed(distance) === 0) {
      this.stop("dead-zone");
      return false;
    }
    this.#direction = direction;
    this.#distance = distance;
    this.#armWatchdog();
    if (this.#active) return true;
    this.#active = true;
    this.#lastTickAt = this.#safeNow();
    this.#interval = this.#setInterval(() => this.tick(), this.#tickMs);
    const timer = this.#interval as ReturnType<typeof globalThis.setInterval> & { unref?: () => void };
    timer.unref?.();
    return true;
  }

  tick(): void {
    if (!this.#active) return;
    const now = this.#safeNow();
    const elapsedMs = Math.max(0, now - this.#lastTickAt);
    this.#lastTickAt = now;
    const magnitude = dedicatedHardwareScrollDelta(this.#distance, elapsedMs);
    if (magnitude === 0) return;
    try {
      this.#onDelta(this.#direction === "up" ? -magnitude : magnitude);
    } catch {
      this.stop("output-failed");
    }
  }

  stop(reason: ContinuousScrollStopReason = "release"): boolean {
    const wasActive = this.#active;
    this.#active = false;
    this.#distance = 0;
    this.#lastTickAt = 0;
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
        // An observer cannot keep the input owner active.
      }
    }
    return wasActive;
  }

  active(): boolean {
    return this.#active;
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
}
