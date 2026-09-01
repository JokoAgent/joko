import type { VisionBridgeUiEffect } from "./gateway.js";

export const VISION_BRIDGE_WARNING_DEDUP_MS = 2_000;
export const VISION_BRIDGE_FALLBACK_DURATION_MS = 5_000;
export const VISION_BRIDGE_UNAVAILABLE_DURATION_MS = 6_000;
export const VISION_BRIDGE_EXIT_DURATION_MS = 300;
export const VISION_BRIDGE_MAX_ACTIVE = 3;
const VISION_BRIDGE_MIN_RESUME_MS = 1_000;

export interface VisionBridgeToast {
  readonly eventId: string;
  readonly sessionId: string;
  readonly kind: "recognizing" | "fallback" | "unavailable";
  readonly imageCount?: number;
  readonly exiting?: boolean;
}

/** Renderer-only, per-Session Vision Bridge feedback. The store deliberately
 * contains no image, focus text, Provider identity, or persisted state. */
export class VisionBridgeToastStore {
  readonly #items = new Map<string, VisionBridgeToast>();
  readonly #recognizingBySession = new Map<string, string>();
  readonly #durations = new Map<string, number>();
  #activeIds: string[] = [];
  readonly #queueIds: string[] = [];
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #expiresAt = new Map<string, number>();
  readonly #remainingMs = new Map<string, number>();
  readonly #lastWarningAt = new Map<string, number>();
  readonly #listeners = new Set<() => void>();
  #snapshot: readonly VisionBridgeToast[] = [];

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): readonly VisionBridgeToast[] => this.#snapshot;

  apply(effect: VisionBridgeUiEffect, now = Date.now()): void {
    if (effect.sessionId.length === 0) return;
    if (effect.kind === "clear") {
      this.#deleteRecognizing(effect.sessionId);
      return;
    }

    if (effect.kind === "recognizing") {
      for (const key of [...this.#lastWarningAt.keys()]) {
        if (key.startsWith(`${effect.sessionId}\0`)) this.#lastWarningAt.delete(key);
      }
      this.#deleteRecognizing(effect.sessionId);
      const toast: VisionBridgeToast = {
        eventId: effect.eventId,
        sessionId: effect.sessionId,
        kind: "recognizing",
        imageCount: Math.max(1, Math.trunc(effect.imageCount ?? 1))
      };
      this.#recognizingBySession.set(effect.sessionId, effect.eventId);
      this.#enqueue(toast, 0, now);
      return;
    }

    // A terminal warning always replaces the indefinite recognizing toast,
    // even when a duplicate warning itself is suppressed.
    this.#deleteRecognizing(effect.sessionId);
    const dedupKey = `${effect.sessionId}\0${effect.kind}`;
    const lastAt = this.#lastWarningAt.get(dedupKey);
    if (lastAt !== undefined && now - lastAt < VISION_BRIDGE_WARNING_DEDUP_MS) return;
    this.#lastWarningAt.set(dedupKey, now);
    const duration = effect.kind === "fallback"
      ? VISION_BRIDGE_FALLBACK_DURATION_MS
      : VISION_BRIDGE_UNAVAILABLE_DURATION_MS;
    this.#enqueue({ eventId: effect.eventId, sessionId: effect.sessionId, kind: effect.kind }, duration, now);
  }

  pause(eventId: string, now = Date.now()): void {
    const warning = this.#items.get(eventId);
    const expiresAt = this.#expiresAt.get(eventId);
    if (warning === undefined || warning.exiting === true || expiresAt === undefined) return;
    const timer = this.#timers.get(eventId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(eventId);
    this.#expiresAt.delete(eventId);
    this.#remainingMs.set(eventId, Math.max(expiresAt - now, VISION_BRIDGE_MIN_RESUME_MS));
  }

  resume(eventId: string, now = Date.now()): void {
    const remaining = this.#remainingMs.get(eventId);
    if (remaining === undefined || this.#items.get(eventId)?.exiting === true) return;
    this.#remainingMs.delete(eventId);
    this.#scheduleWarning(eventId, remaining, now);
  }

  reset(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    const changed = this.#items.size > 0;
    this.#timers.clear();
    this.#expiresAt.clear();
    this.#remainingMs.clear();
    this.#items.clear();
    this.#recognizingBySession.clear();
    this.#durations.clear();
    this.#activeIds = [];
    this.#queueIds.splice(0);
    this.#lastWarningAt.clear();
    if (changed) this.#publish();
  }

  #deleteRecognizing(sessionId: string): void {
    const eventId = this.#recognizingBySession.get(sessionId);
    if (eventId === undefined) return;
    this.#recognizingBySession.delete(sessionId);
    if (this.#activeIds.includes(eventId)) this.#beginExit(eventId);
    else this.#removeImmediate(eventId);
  }

  #removeImmediate(eventId: string): void {
    const timer = this.#timers.get(eventId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(eventId);
    this.#expiresAt.delete(eventId);
    this.#remainingMs.delete(eventId);
    this.#durations.delete(eventId);
    const activeIndex = this.#activeIds.indexOf(eventId);
    if (activeIndex >= 0) this.#activeIds.splice(activeIndex, 1);
    const queueIndex = this.#queueIds.indexOf(eventId);
    if (queueIndex >= 0) this.#queueIds.splice(queueIndex, 1);
    const item = this.#items.get(eventId);
    if (item !== undefined && this.#recognizingBySession.get(item.sessionId) === eventId) {
      this.#recognizingBySession.delete(item.sessionId);
    }
    if (!this.#items.delete(eventId)) return;
    this.#admitFromQueue();
    this.#publish();
  }

  #enqueue(toast: VisionBridgeToast, duration: number, now: number): void {
    this.#items.set(toast.eventId, toast);
    this.#durations.set(toast.eventId, duration);
    if (this.#activeIds.length < VISION_BRIDGE_MAX_ACTIVE) {
      this.#activeIds.unshift(toast.eventId);
      if (duration > 0) this.#scheduleWarning(toast.eventId, duration, now);
    } else {
      this.#queueIds.push(toast.eventId);
    }
    this.#publish();
  }

  #scheduleWarning(eventId: string, duration: number, now = Date.now()): void {
    const timer = setTimeout(() => this.#beginExit(eventId), duration);
    this.#timers.set(eventId, timer);
    this.#expiresAt.set(eventId, now + duration);
  }

  #beginExit(eventId: string): void {
    const toast = this.#items.get(eventId);
    if (toast === undefined || toast.exiting === true) return;
    this.#expiresAt.delete(eventId);
    this.#remainingMs.delete(eventId);
    this.#items.set(eventId, { ...toast, exiting: true });
    this.#publish();
    this.#timers.set(eventId, setTimeout(() => this.#removeImmediate(eventId), VISION_BRIDGE_EXIT_DURATION_MS));
  }

  #admitFromQueue(): void {
    while (this.#activeIds.length < VISION_BRIDGE_MAX_ACTIVE) {
      const eventId = this.#queueIds.shift();
      if (eventId === undefined) return;
      if (!this.#items.has(eventId)) continue;
      this.#activeIds.unshift(eventId);
      const duration = this.#durations.get(eventId) ?? 0;
      if (duration > 0) this.#scheduleWarning(eventId, duration);
    }
  }

  #publish(): void {
    this.#snapshot = this.#activeIds.flatMap((eventId) => {
      const toast = this.#items.get(eventId);
      return toast === undefined ? [] : [toast];
    });
    for (const listener of this.#listeners) listener();
  }
}

export const visionBridgeToastStore = new VisionBridgeToastStore();
