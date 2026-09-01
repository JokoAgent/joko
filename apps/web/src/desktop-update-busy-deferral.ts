import { useEffect, useRef } from "react";

import {
  currentDesktopUpdateBannerDismiss,
  deferDesktopUpdateBannerBecauseBusy,
  desktopUpdateBannerDecidedFor,
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
 * authoritative activity answer used by relaunch. Probe failures fail closed.
 */
export function useDesktopUpdateBusyDeferral(
  status: JokoDesktopUpdateStatus | undefined,
  probeRuntimeActivity: () => Promise<boolean>
): boolean {
  const dismiss = useDesktopUpdateBannerDismiss();
  const probeRef = useRef(probeRuntimeActivity);
  probeRef.current = probeRuntimeActivity;
  const statusKey = status === undefined ? undefined : desktopUpdateDismissKey(status);
  const hideUntilDecided = status !== undefined
    && desktopUpdateIsPending(status)
    && !dismiss.dismissed
    && dismiss.decisionKey !== statusKey;

  useEffect(() => {
    if (status === undefined || !desktopUpdateIsPending(status)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pendingStatus = status;

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
      if (latest.reason === "user") return;
      if (!latest.dismissed && desktopUpdateBannerDecidedFor(pendingStatus)) {
        // The user explicitly reopened a busy-deferred banner while this probe
        // was in flight. That visible choice must not be reversed.
        return;
      }

      if (!busy) {
        markDesktopUpdateBannerAutoShown(pendingStatus);
        return;
      }

      const changed = deferDesktopUpdateBannerBecauseBusy(pendingStatus);
      if (!changed) schedulePoll();
    };

    const beforePrepare = currentDesktopUpdateBannerDismiss();
    const prepared = prepareDesktopUpdateBannerStatus(pendingStatus);
    if (prepared !== beforePrepare) return;
    if (prepared.reason === "user") return;
    if (!prepared.dismissed && desktopUpdateBannerDecidedFor(pendingStatus)) return;
    if (
      prepared.dismissed
      && prepared.reason === "busy"
      && desktopUpdateBannerDecidedFor(pendingStatus)
    ) schedulePoll();
    else void runProbe();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [dismiss.decisionKey, dismiss.dismissed, dismiss.reason, dismiss.updateKey, status, statusKey]);

  return hideUntilDecided;
}
