import { useSyncExternalStore } from "react";

const DESKTOP_UPDATE_CAPABILITY = "app.update" satisfies JokoDesktopCapability;

let bridgeApi: JokoDesktopApi | undefined;
let bridgeStatus: JokoDesktopUpdateStatus | undefined;
let bridgeUnsubscribe: (() => void) | undefined;
let bridgeHydrationEpoch = 0;
let bridgeEventEpoch = 0;
const bridgeListeners = new Set<() => void>();

export type DesktopUpdateDismissReason = "user" | "busy";

export interface DesktopUpdateDismissSnapshot {
  readonly dismissed: boolean;
  readonly reason?: DesktopUpdateDismissReason;
  readonly updateKey?: string;
  readonly decisionKey?: string;
}

let dismissSnapshot: DesktopUpdateDismissSnapshot = Object.freeze({ dismissed: false });
const dismissListeners = new Set<() => void>();

export function useDesktopUpdateStatus(): JokoDesktopUpdateStatus | undefined {
  return useSyncExternalStore(subscribeDesktopUpdateStatus, currentDesktopUpdateStatus, noDesktopUpdateStatus);
}

export function useDesktopUpdateBannerDismiss(): DesktopUpdateDismissSnapshot {
  return useSyncExternalStore(subscribeDesktopUpdateDismiss, currentDesktopUpdateDismiss, currentDesktopUpdateDismiss);
}

export function dismissDesktopUpdateBanner(status: JokoDesktopUpdateStatus): void {
  const updateKey = desktopUpdateDismissKey(status);
  if (
    updateKey === undefined
    || dismissSnapshot.dismissed
      && dismissSnapshot.reason === "user"
      && dismissSnapshot.updateKey === updateKey
  ) return;
  dismissSnapshot = Object.freeze({
    dismissed: true,
    reason: "user",
    updateKey,
    decisionKey: updateKey
  });
  emitDismissChange();
}

export function restoreDesktopUpdateBanner(): void {
  if (!dismissSnapshot.dismissed) return;
  dismissSnapshot = Object.freeze({
    dismissed: false,
    decisionKey: dismissSnapshot.decisionKey ?? dismissSnapshot.updateKey
  });
  emitDismissChange();
}

/**
 * Defers the full banner while preserving a minimal, user-invokable update
 * entry. A user dismissal always wins over an automatic busy decision.
 *
 * @returns true when the store changed.
 */
export function deferDesktopUpdateBannerBecauseBusy(status: JokoDesktopUpdateStatus): boolean {
  const updateKey = desktopUpdateDismissKey(status);
  if (updateKey === undefined || dismissSnapshot.reason === "user") return false;
  if (
    dismissSnapshot.dismissed
    && dismissSnapshot.reason === "busy"
    && dismissSnapshot.updateKey === updateKey
    && dismissSnapshot.decisionKey === updateKey
  ) return false;
  dismissSnapshot = Object.freeze({
    dismissed: true,
    reason: "busy",
    updateKey,
    decisionKey: updateKey
  });
  emitDismissChange();
  return true;
}

/** Records that the automatic busy gate allowed this exact update to appear. */
export function markDesktopUpdateBannerAutoShown(status: JokoDesktopUpdateStatus): boolean {
  const updateKey = desktopUpdateDismissKey(status);
  if (updateKey === undefined || dismissSnapshot.reason === "user") return false;
  if (
    !dismissSnapshot.dismissed
    && dismissSnapshot.reason === undefined
    && dismissSnapshot.decisionKey === updateKey
  ) return false;
  dismissSnapshot = Object.freeze({ dismissed: false, decisionKey: updateKey });
  emitDismissChange();
  return true;
}

/**
 * Re-arms the automatic gate for a genuinely different pending update. The
 * previous reason remains visible until the new probe settles, so the full
 * banner cannot flash while activity is still unknown.
 */
export function prepareDesktopUpdateBannerStatus(
  status: JokoDesktopUpdateStatus
): DesktopUpdateDismissSnapshot {
  const updateKey = desktopUpdateDismissKey(status);
  if (
    updateKey === undefined
    || !dismissSnapshot.dismissed
    || dismissSnapshot.updateKey === updateKey
  ) return dismissSnapshot;

  dismissSnapshot = dismissSnapshot.reason === "busy"
    ? Object.freeze({ dismissed: true, reason: "busy", updateKey })
    : Object.freeze({ dismissed: false });
  emitDismissChange();
  return dismissSnapshot;
}

export function currentDesktopUpdateBannerDismiss(): DesktopUpdateDismissSnapshot {
  return dismissSnapshot;
}

export function desktopUpdateBannerDecidedFor(status: JokoDesktopUpdateStatus): boolean {
  const updateKey = desktopUpdateDismissKey(status);
  return updateKey !== undefined && dismissSnapshot.decisionKey === updateKey;
}

export function isNewDesktopUpdateAfterDismiss(status: JokoDesktopUpdateStatus): boolean {
  if (!dismissSnapshot.dismissed) return false;
  const updateKey = desktopUpdateDismissKey(status);
  return updateKey !== undefined && updateKey !== dismissSnapshot.updateKey;
}

export function desktopUpdateIsPending(status: JokoDesktopUpdateStatus | undefined): status is Extract<
  JokoDesktopUpdateStatus,
  { readonly status: "ready" | "superseding" }
> {
  return status?.status === "ready" || status?.status === "superseding";
}

export function desktopUpdateApi(): JokoDesktopApi["updates"] | undefined {
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  if (
    desktop === undefined
    || !Array.isArray(desktop.capabilities)
    || !desktop.capabilities.includes(DESKTOP_UPDATE_CAPABILITY)
  ) return undefined;
  const updates = desktop.updates;
  return typeof updates?.getStatus === "function"
    && typeof updates.check === "function"
    && typeof updates.relaunch === "function"
    && typeof updates.onStatus === "function"
    ? updates
    : undefined;
}

/** Test seam; production lifecycle resets naturally after the final subscriber unmounts. */
export function resetDesktopUpdateStateForTests(): void {
  stopDesktopUpdateBridge();
  bridgeListeners.clear();
  bridgeApi = undefined;
  bridgeStatus = undefined;
  dismissSnapshot = Object.freeze({ dismissed: false });
  dismissListeners.clear();
}

function subscribeDesktopUpdateStatus(listener: () => void): () => void {
  bridgeListeners.add(listener);
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  if (bridgeListeners.size === 1 || bridgeApi !== desktop) startDesktopUpdateBridge(desktop);
  return () => {
    bridgeListeners.delete(listener);
    if (bridgeListeners.size === 0) {
      stopDesktopUpdateBridge();
      bridgeApi = undefined;
      bridgeStatus = undefined;
    }
  };
}

function startDesktopUpdateBridge(desktop: JokoDesktopApi | undefined): void {
  stopDesktopUpdateBridge();
  bridgeApi = desktop;
  bridgeStatus = undefined;
  bridgeEventEpoch = 0;
  const updates = desktopUpdateApi();
  if (updates === undefined || desktop !== bridgeApi) return;

  const hydrationEpoch = ++bridgeHydrationEpoch;
  try {
    // Subscribe first. If a newer push wins the race, the initial snapshot is
    // ignored instead of overwriting it after hydration resolves.
    bridgeUnsubscribe = updates.onStatus((status) => {
      if (bridgeApi !== desktop || hydrationEpoch !== bridgeHydrationEpoch) return;
      bridgeEventEpoch += 1;
      publishDesktopUpdateStatus(status);
    });
  } catch {
    bridgeUnsubscribe = undefined;
    return;
  }
  const eventEpochAtRequest = bridgeEventEpoch;
  void updates.getStatus().then((status) => {
    if (
      bridgeApi === desktop
      && hydrationEpoch === bridgeHydrationEpoch
      && bridgeEventEpoch === eventEpochAtRequest
    ) publishDesktopUpdateStatus(status);
  }).catch(() => undefined);
}

function stopDesktopUpdateBridge(): void {
  bridgeHydrationEpoch += 1;
  try { bridgeUnsubscribe?.(); } catch { /* preload cleanup is best effort */ }
  bridgeUnsubscribe = undefined;
}

function publishDesktopUpdateStatus(status: JokoDesktopUpdateStatus): void {
  bridgeStatus = status;
  for (const listener of bridgeListeners) listener();
}

function currentDesktopUpdateStatus(): JokoDesktopUpdateStatus | undefined {
  return bridgeStatus;
}

function noDesktopUpdateStatus(): undefined {
  return undefined;
}

function subscribeDesktopUpdateDismiss(listener: () => void): () => void {
  dismissListeners.add(listener);
  return () => dismissListeners.delete(listener);
}

function currentDesktopUpdateDismiss(): DesktopUpdateDismissSnapshot {
  return dismissSnapshot;
}

function emitDismissChange(): void {
  for (const listener of dismissListeners) listener();
}

export function desktopUpdateDismissKey(status: JokoDesktopUpdateStatus): string | undefined {
  if (status.status === "ready") return `ready\0${status.version}`;
  if (status.status === "superseding") return `superseding\0${status.version}\0${status.nextVersion}`;
  return undefined;
}
