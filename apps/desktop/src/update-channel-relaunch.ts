export const DESKTOP_UPDATE_CHANNEL_RELAUNCH_HANDOFF_TIMEOUT_MS = 30_000;

export interface DesktopUpdateChannelQuitEvent {
  readonly preventDefault: () => void;
}

export interface DesktopQuitHandoffApp {
  readonly once: (
    event: "will-quit",
    listener: (event: DesktopUpdateChannelQuitEvent) => void
  ) => unknown;
  readonly removeListener: (
    event: "will-quit",
    listener: (event: DesktopUpdateChannelQuitEvent) => void
  ) => unknown;
  readonly quit: () => void;
}

export interface DesktopUpdateChannelRelaunchApp extends DesktopQuitHandoffApp {
  readonly relaunch: () => void;
}

export interface DesktopQuitHandoffOptions {
  readonly app: DesktopQuitHandoffApp;
  readonly handoffTimeoutMs?: number;
  readonly onQuitBlocked?: (listener: () => void) => () => void;
  readonly onWillQuit?: () => void;
}

/**
 * Requests a normal Electron quit and settles only once Electron proves that
 * every window allowed the quit to reach will-quit.
 */
export function requestDesktopQuitHandoff(
  options: DesktopQuitHandoffOptions
): Promise<boolean> {
  const handoffTimeoutMs = options.handoffTimeoutMs ?? DESKTOP_UPDATE_CHANNEL_RELAUNCH_HANDOFF_TIMEOUT_MS;
  if (!Number.isSafeInteger(handoffTimeoutMs) || handoffTimeoutMs <= 0) {
    throw new TypeError("Desktop update channel relaunch handoff timeout must be a positive integer.");
  }

  return new Promise((resolvePromise) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopQuitBlocked: (() => void) | undefined;
    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
      options.app.removeListener("will-quit", accepted);
      stopQuitBlocked?.();
      stopQuitBlocked = undefined;
    };
    const settle = (acceptedHandoff: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(acceptedHandoff);
    };
    const accepted = (event: DesktopUpdateChannelQuitEvent): void => {
      if (settled) return;
      try {
        options.onWillQuit?.();
      } catch {
        // The global will-quit disposer is held back while this handoff is
        // pending, so cancelling here leaves the main process recoverable.
        event.preventDefault();
        settle(false);
        return;
      }
      settle(true);
    };

    try {
      options.app.once("will-quit", accepted);
      stopQuitBlocked = options.onQuitBlocked?.(() => settle(false));
      timeout = setTimeout(() => settle(false), handoffTimeoutMs);
      timeout.unref();
      options.app.quit();
    } catch {
      settle(false);
    }
  });
}

/** Schedules the replacement process only after a proven normal-quit handoff. */
export function requestDesktopUpdateChannelRelaunchHandoff(options: {
  readonly app: DesktopUpdateChannelRelaunchApp;
  readonly handoffTimeoutMs?: number;
  readonly onQuitBlocked?: (listener: () => void) => () => void;
}): Promise<boolean> {
  return requestDesktopQuitHandoff({
    app: options.app,
    ...(options.handoffTimeoutMs === undefined ? {} : { handoffTimeoutMs: options.handoffTimeoutMs }),
    ...(options.onQuitBlocked === undefined ? {} : { onQuitBlocked: options.onQuitBlocked }),
    onWillQuit: () => options.app.relaunch()
  });
}
