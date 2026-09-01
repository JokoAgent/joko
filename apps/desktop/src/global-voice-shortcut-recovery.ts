import type { DesktopGlobalVoiceShortcut } from "./channels.js";

export type GlobalVoiceShortcutRecoveryTarget =
  | { readonly kind: "none" }
  | { readonly kind: "wait" }
  | {
    readonly kind: "register";
    readonly revision: number;
    readonly shortcut: DesktopGlobalVoiceShortcut;
  };

export type GlobalVoiceShortcutRecoveryAttemptResult =
  | "registered"
  | "permission"
  | "failed"
  | "superseded";

export interface GlobalVoiceShortcutRecoveryOptions {
  readonly platform: NodeJS.Platform;
  readonly minimumIntervalMs?: number;
  readonly getTarget: () => GlobalVoiceShortcutRecoveryTarget;
  readonly preflight: () => Promise<"granted" | "denied" | "unknown">;
  readonly register: (
    shortcut: DesktopGlobalVoiceShortcut,
    revision: number
  ) => Promise<GlobalVoiceShortcutRecoveryAttemptResult>;
  readonly onFailure: () => void;
  readonly onRecovered: () => void;
  readonly now?: () => number;
}

const DEFAULT_MINIMUM_INTERVAL_MS = 5_000;

/** Coordinates focus-driven recovery without prompting for permission. */
export class GlobalVoiceShortcutRecovery {
  readonly #platform: NodeJS.Platform;
  readonly #minimumIntervalMs: number;
  readonly #getTarget: () => GlobalVoiceShortcutRecoveryTarget;
  readonly #preflight: () => Promise<"granted" | "denied" | "unknown">;
  readonly #register: GlobalVoiceShortcutRecoveryOptions["register"];
  readonly #onFailure: () => void;
  readonly #onRecovered: () => void;
  readonly #now: () => number;
  #lastAttemptAt = Number.NEGATIVE_INFINITY;
  #running = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(options: GlobalVoiceShortcutRecoveryOptions) {
    this.#platform = options.platform;
    this.#minimumIntervalMs = options.minimumIntervalMs ?? DEFAULT_MINIMUM_INTERVAL_MS;
    this.#getTarget = options.getTarget;
    this.#preflight = options.preflight;
    this.#register = options.register;
    this.#onFailure = options.onFailure;
    this.#onRecovered = options.onRecovered;
    this.#now = options.now ?? Date.now;
  }

  async request(): Promise<void> {
    if (this.#disposed || this.#platform !== "darwin") return;
    if (this.#running) {
      this.#scheduleRetry(this.#minimumIntervalMs);
      return;
    }

    const target = this.#getTarget();
    if (target.kind === "none") return;
    if (target.kind === "wait") {
      this.#scheduleRetry(this.#minimumIntervalMs);
      return;
    }

    const now = this.#now();
    const remaining = this.#minimumIntervalMs - (now - this.#lastAttemptAt);
    if (remaining > 0) {
      this.#scheduleRetry(remaining);
      return;
    }

    this.#lastAttemptAt = now;
    this.#running = true;
    try {
      const permission = await this.#preflight();
      if (this.#disposed) return;
      const revalidated = this.#getTarget();
      if (revalidated.kind === "none") return;
      if (revalidated.kind === "wait") {
        this.#scheduleRetry(this.#minimumIntervalMs);
        return;
      }
      if (permission === "denied") return;
      if (permission !== "granted") {
        this.#onFailure();
        return;
      }

      const result = await this.#register(revalidated.shortcut, revalidated.revision);
      if (this.#disposed || result === "superseded" || result === "permission") return;
      if (result === "registered") {
        this.#onRecovered();
        return;
      }
      const failedTarget = this.#getTarget();
      if (failedTarget.kind === "register" && failedTarget.revision === revalidated.revision) {
        this.#onFailure();
      } else if (failedTarget.kind === "wait") {
        this.#scheduleRetry(this.#minimumIntervalMs);
      }
    } catch {
      if (this.#disposed) return;
      const failedTarget = this.#getTarget();
      if (failedTarget.kind === "register") this.#onFailure();
      else if (failedTarget.kind === "wait") this.#scheduleRetry(this.#minimumIntervalMs);
    } finally {
      this.#running = false;
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  #scheduleRetry(delayMs: number): void {
    if (this.#disposed || this.#retryTimer !== undefined) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.request();
    }, Math.max(0, delayMs));
    this.#retryTimer.unref?.();
  }
}
