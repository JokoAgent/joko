export type MobilePreviewRecoveryDecision = "remount" | "wait" | "failed";

export interface MobilePreviewResourceLifecycle {
  onNotForeground(): void;
  onForeground(): MobilePreviewRecoveryDecision | undefined;
  onResourcePressure(foreground: boolean): MobilePreviewRecoveryDecision;
  onProcessLost(foreground: boolean): MobilePreviewRecoveryDecision;
  onRendererReady(): void;
  onUnavailable(): void;
  reset(foreground: boolean): void;
}

/**
 * Owns the common recovery budget for the three expensive mobile preview
 * renderers. Ordinary foreground restoration is not a renderer failure, while
 * process loss and memory pressure share one consecutive-recovery budget. A
 * renderer that reaches ready resets that budget.
 */
export function createMobilePreviewResourceLifecycle(
  foreground: boolean,
  maximumConsecutiveRecoveries = 1
): MobilePreviewResourceLifecycle {
  if (!Number.isSafeInteger(maximumConsecutiveRecoveries)
    || maximumConsecutiveRecoveries < 0 || maximumConsecutiveRecoveries > 3) {
    throw new Error("The mobile preview recovery budget is invalid.");
  }
  let failed = false;
  let pendingForegroundMount = !foreground;
  let recoveries = 0;

  const recover = (active: boolean): MobilePreviewRecoveryDecision => {
    pendingForegroundMount = true;
    if (failed) return "failed";
    if (!active) return "wait";
    pendingForegroundMount = false;
    if (recoveries >= maximumConsecutiveRecoveries) {
      failed = true;
      return "failed";
    }
    recoveries += 1;
    return "remount";
  };

  return {
    onNotForeground() {
      if (!failed) pendingForegroundMount = true;
    },
    onForeground() {
      if (failed) return "failed";
      if (!pendingForegroundMount) return undefined;
      pendingForegroundMount = false;
      return "remount";
    },
    onResourcePressure: recover,
    onProcessLost: recover,
    onRendererReady() {
      if (failed) return;
      pendingForegroundMount = false;
      recoveries = 0;
    },
    onUnavailable() {
      failed = true;
      pendingForegroundMount = false;
    },
    reset(active: boolean) {
      failed = false;
      pendingForegroundMount = !active;
      recoveries = 0;
    }
  };
}
