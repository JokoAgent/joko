export const PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS = 15 * 60_000;

export type ProviderModelRefreshLifecycleHint =
  | "system-resume"
  | "screen-unlock"
  | "meaningful-foreground";

export interface ProviderModelRefreshHostLifecycle {
  syncApplicationFocused(focused: boolean): void;
  systemResumed(): void;
  screenUnlocked(): void;
}

/**
 * Owns operating-system lifecycle interpretation in the trusted Desktop host.
 * The first focus observation establishes state; only a real long-background
 * false-to-true transition publishes a foreground hint.
 */
export function createProviderModelRefreshHostLifecycle(options: {
  readonly now?: () => number;
  readonly backgroundThresholdMs?: number;
  readonly publish: (hint: ProviderModelRefreshLifecycleHint) => void;
}): ProviderModelRefreshHostLifecycle {
  const now = options.now ?? Date.now;
  const backgroundThresholdMs = options.backgroundThresholdMs ??
    PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS;
  if (!Number.isSafeInteger(backgroundThresholdMs) || backgroundThresholdMs < 0) {
    throw new RangeError("Provider model foreground refresh threshold must be a non-negative integer.");
  }
  let focused: boolean | undefined;
  let backgroundedAt: number | undefined;

  return {
    syncApplicationFocused(nextFocused): void {
      if (focused === nextFocused) return;
      const previous = focused;
      focused = nextFocused;
      const observedAt = now();
      if (!nextFocused) {
        backgroundedAt = observedAt;
        return;
      }
      const startedAt = backgroundedAt;
      backgroundedAt = undefined;
      if (previous === false && startedAt !== undefined &&
        observedAt - startedAt >= backgroundThresholdMs) {
        options.publish("meaningful-foreground");
      }
    },
    systemResumed(): void {
      options.publish("system-resume");
    },
    screenUnlocked(): void {
      options.publish("screen-unlock");
    }
  };
}
