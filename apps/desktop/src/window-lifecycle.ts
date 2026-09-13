import type { DesktopMainWindowCloseBehavior, DesktopMainWindowCloseSettings } from "./channels.js";

export type TrayHideResult = "hidden" | "unavailable" | "destroyed" | "cancelled";

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

// Explicit Open retires asynchronous hide/minimize work for this exact window.
const windowHideIntents = new WeakMap<DesktopWindowLifecycleTarget, object>();

function captureWindowHideIntent(window: DesktopWindowLifecycleTarget, isCurrent: () => boolean): () => boolean {
  const intent = {};
  windowHideIntents.set(window, intent);
  return () => !window.isDestroyed() && windowHideIntents.get(window) === intent && isCurrent();
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
  ensureTrayAvailable: () => Promise<boolean>,
  isCurrent: () => boolean = () => true
): Promise<TrayHideResult> {
  if (window.isDestroyed()) return "destroyed";
  if (!isCurrent()) return "cancelled";
  const current = captureWindowHideIntent(window, isCurrent);
  const available = await ensureTrayAvailable();
  if (window.isDestroyed()) return "destroyed";
  if (!current()) return "cancelled";
  if (!available) return "unavailable";
  if (!window.isFullScreen()) {
    window.hide();
    return "hidden";
  }
  window.once("leave-full-screen", () => {
    if (current()) window.hide();
  });
  window.setFullScreen(false);
  return "hidden";
}

export interface DesktopMainWindowCloseController {
  request(): Promise<void>;
  cancelPending(): void;
}

export async function applyDesktopMainWindowCloseBehavior(
  window: DesktopWindowLifecycleTarget & { minimize(): void },
  behavior: DesktopMainWindowCloseBehavior,
  options: { isCurrent(): boolean; quit(): void; hideToTray(isCurrent: () => boolean): Promise<void> }
): Promise<void> {
  const current = (): boolean => !window.isDestroyed() && options.isCurrent();
  if (!current()) return;
  if (behavior === "quit") options.quit();
  else if (behavior === "tray") await options.hideToTray(current);
  else {
    const visibilityCurrent = captureWindowHideIntent(window, current);
    if (window.isFullScreen()) {
      window.once("leave-full-screen", () => { if (visibilityCurrent()) window.minimize(); });
      window.setFullScreen(false);
    } else window.minimize();
  }
}

/** One main-window-owned close decision; native dialogs remain usable without a renderer. */
export function createDesktopMainWindowCloseController(options: {
  isCurrent(): boolean;
  read(): Promise<DesktopMainWindowCloseSettings>;
  currentSettings(): DesktopMainWindowCloseSettings;
  prompt(signal: AbortSignal): Promise<DesktopMainWindowCloseBehavior | null>;
  save(behavior: DesktopMainWindowCloseBehavior, expectedRevision: number, isCurrent: () => boolean): Promise<DesktopMainWindowCloseSettings>;
  apply(behavior: DesktopMainWindowCloseBehavior, isCurrent: () => boolean): Promise<void>;
  onError(signal: AbortSignal): Promise<void>;
}): DesktopMainWindowCloseController {
  let request: object | undefined;
  let pending: Promise<void> | undefined;
  let abort: AbortController | undefined;
  return {
    request: () => {
      if (pending !== undefined) return pending;
      if (!options.isCurrent()) return Promise.resolve();
      const ownRequest = {};
      request = ownRequest;
      const ownAbort = new AbortController();
      abort = ownAbort;
      const current = (): boolean => request === ownRequest && !ownAbort.signal.aborted && options.isCurrent();
      const operation = async (): Promise<void> => {
        try {
          let settings = await options.read();
          if (!current()) return;
          if (settings.behavior === null) {
            const behavior = await options.prompt(ownAbort.signal);
            if (!current() || behavior === null || options.currentSettings().revision !== settings.revision) return;
            settings = await options.save(behavior, settings.revision, current);
          }
          if (!current() || settings.behavior === null || options.currentSettings().revision !== settings.revision) return;
          await options.apply(settings.behavior, current);
        } catch {
          if (current()) await options.onError(ownAbort.signal).catch(() => undefined);
        }
      };
      const result = operation().finally(() => {
        if (pending === result) pending = undefined;
        if (abort === ownAbort) abort = undefined;
      });
      pending = result;
      return result;
    },
    cancelPending: () => { request = undefined; abort?.abort(); }
  };
}


export function showWindowFromTray(window: DesktopWindowLifecycleTarget): void {
  if (window.isDestroyed()) return;
  windowHideIntents.delete(window);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
