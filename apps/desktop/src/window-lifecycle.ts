export type TrayHideResult = "hidden" | "unavailable" | "destroyed";

export interface DesktopWindowLifecycleTarget {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  isMinimized(): boolean;
  hide(): void;
  restore(): void;
  show(): void;
  focus(): void;
  once(event: "leave-full-screen", listener: () => void): unknown;
  setFullScreen(fullScreen: boolean): void;
}

export interface DesktopWindowShowFence {
  readonly quitting: boolean;
  readonly channelQuitHandoffPending: boolean;
  readonly nativeInstallQuitHandoffPending: boolean;
  readonly completeExitQuitHandoffPending: boolean;
}

export interface DesktopWindowClosedSource<Contents> {
  readonly webContents: Contents;
  once(event: "closed", listener: () => void): unknown;
}

/**
 * Capture WebContents while its BrowserWindow is live. Electron throws when
 * the `webContents` getter is read from a BrowserWindow after `closed` fires.
 */
export function onDesktopWindowClosed<Contents>(
  window: DesktopWindowClosedSource<Contents>,
  cleanup: (contents: Contents) => void
): Contents {
  const contents = window.webContents;
  window.once("closed", () => cleanup(contents));
  return contents;
}

/** Never recreate a window after a validated quit preflight has closed it. */
export function canShowDesktopWindow(fence: DesktopWindowShowFence): boolean {
  return !fence.quitting && !fence.channelQuitHandoffPending &&
    !fence.nativeInstallQuitHandoffPending && !fence.completeExitQuitHandoffPending;
}

/** Hide only after a reachable tray entry exists; never strand the window. */
export async function hideWindowToAvailableTray(
  window: DesktopWindowLifecycleTarget,
  ensureTrayAvailable: () => Promise<boolean>
): Promise<TrayHideResult> {
  if (window.isDestroyed()) return "destroyed";
  if (!await ensureTrayAvailable()) return "unavailable";
  if (window.isDestroyed()) return "destroyed";
  if (!window.isFullScreen()) {
    window.hide();
    return "hidden";
  }
  window.once("leave-full-screen", () => {
    if (!window.isDestroyed()) window.hide();
  });
  window.setFullScreen(false);
  return "hidden";
}

export function showWindowFromTray(window: DesktopWindowLifecycleTarget): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
