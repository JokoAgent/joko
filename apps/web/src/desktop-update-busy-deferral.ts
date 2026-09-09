import { useEffect, useRef } from "react";

import {
  currentDesktopUpdateBannerDismiss,
  deferDesktopUpdateBannerBecauseBusy,
  desktopUpdateBannerDecidedFor,
  desktopUpdateBannerPinnedFor,
  desktopUpdateDismissKey,
  desktopUpdateIsPending,
  markDesktopUpdateBannerAutoShown,
  prepareDesktopUpdateBannerStatus,
  useDesktopUpdateBannerDismiss
} from "./desktop-update.js";

/** The activity probe is intentionally not a hot renderer polling loop. */
export const DESKTOP_UPDATE_BUSY_POLL_MS = 15_000;

/**
 * Gates the automatic appearance of the full update banner on the same
 * authoritative activity answer used by relaunch. Continue observing automatically
 * shown banners, so later activity can defer them again. An explicit user restore
 * pins only the current update. Probe failures fail closed.
 */
export function useDesktopUpdateBusyDeferral(
  status: JokoDesktopUpdateStatus | undefined,
  probeRuntimeActivity: () => Promise<boolean>
): boolean {
  const dismiss = useDesktopUpdateBannerDismiss();
  const probeRef = useRef(probeRuntimeActivity);
  probeRef.current = probeRuntimeActivity;
  const statusRef = useRef(status);
  statusRef.current = status;
  const statusKey = status === undefined ? undefined : desktopUpdateDismissKey(status);
  const hideUntilDecided = status !== undefined
    && desktopUpdateIsPending(status)
    && !dismiss.dismissed
    && dismiss.decisionKey !== statusKey;

  useEffect(() => {
    const pendingStatus = statusRef.current;
    if (pendingStatus === undefined || !desktopUpdateIsPending(pendingStatus)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedulePoll = (): void => {
      timer = setTimeout(() => { void runProbe(); }, DESKTOP_UPDATE_BUSY_POLL_MS);
    };

    const runProbe = async (): Promise<void> => {
      let busy = true;
      try {
        busy = await probeRef.current();
      } catch {
        // Without a trustworthy owner answer, showing a disruptive relaunch
        // prompt automatically is unsafe.
      }
      if (cancelled) return;

      const latest = currentDesktopUpdateBannerDismiss();
      if (latest.reason === "user" || desktopUpdateBannerPinnedFor(pendingStatus)) return;

      const changed = busy
        ? deferDesktopUpdateBannerBecauseBusy(pendingStatus)
        : markDesktopUpdateBannerAutoShown(pendingStatus);
      if (!changed) schedulePoll();
    };

    const beforePrepare = currentDesktopUpdateBannerDismiss();
    const prepared = prepareDesktopUpdateBannerStatus(pendingStatus);
    if (prepared !== beforePrepare) return;
    if (prepared.reason === "user" || desktopUpdateBannerPinnedFor(pendingStatus)) return;
    if (desktopUpdateBannerDecidedFor(pendingStatus)) schedulePoll();
    else void runProbe();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [dismiss.decisionKey, dismiss.dismissed, dismiss.reason, dismiss.updateKey, dismiss.pinnedKey, statusKey]);

  return hideUntilDecided;
}
