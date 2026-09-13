import { DESKTOP_CHANNELS } from "./channels.js";

export interface WindowGeometryDefaults {
  readonly width: number;
  readonly height: number;
}

export interface ResettableWindowState {
  unmanage(): void;
  manage(window: ResettableWindow): void;
  saveState(window: ResettableWindow): void;
}

export interface ResettableWindow {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  isMaximized(): boolean;
  once(event: "leave-full-screen" | "unmaximize" | "closed", listener: () => void): unknown;
  removeListener(event: "leave-full-screen" | "unmaximize" | "closed", listener: () => void): unknown;
  setFullScreen(value: boolean): void;
  unmaximize(): void;
  setSize(width: number, height: number): void;
  center(): void;
}

export interface ManagedWindowGeometry {
  readonly window: ResettableWindow;
  readonly state: ResettableWindowState;
  readonly defaults: WindowGeometryDefaults;
}

interface WindowStateWithDefaultReset extends ResettableWindowState {
  resetStateToDefault(): void;
}

export interface LayoutResetWebContents {
  isDestroyed(): boolean;
  send(channel: string): unknown;
}

export interface LayoutResetBroadcastWindow {
  isDestroyed(): boolean;
  readonly webContents: LayoutResetWebContents;
}

/**
 * electron-window-state exposes geometry through getter-only properties. Its
 * runtime resetStateToDefault() method is missing from the published typings,
 * so validate that capability instead of assigning to those getters.
 */
export function resetDormantManagedWindowState(state: ResettableWindowState): void {
  const candidate = state as Partial<WindowStateWithDefaultReset>;
  if (typeof candidate.resetStateToDefault !== "function") {
    throw new TypeError("Managed window state does not support resetting to defaults.");
  }
  candidate.resetStateToDefault.call(state);
}

/** One transaction validates all targets before changing or persisting any of them. */
export async function resetManagedWindowGeometry(targets: readonly ManagedWindowGeometry[]): Promise<void> {
  const live = targets.filter((target) => !target.window.isDestroyed());
  for (const target of live) {
    if (!Number.isSafeInteger(target.defaults.width) || !Number.isSafeInteger(target.defaults.height) ||
      target.defaults.width < 320 || target.defaults.height < 240) {
      throw new RangeError("Window geometry defaults are invalid.");
    }
  }
  await Promise.all(live.map(async (target) => {
    target.state.unmanage();
    await leaveWindowState(target.window, "leave-full-screen", () => !target.window.isFullScreen(), () => target.window.setFullScreen(false));
    if (target.window.isDestroyed()) return;
    await leaveWindowState(target.window, "unmaximize", () => !target.window.isMaximized(), () => target.window.unmaximize());
    if (target.window.isDestroyed()) return;
    target.window.setSize(target.defaults.width, target.defaults.height);
    target.window.center();
    // electron-window-state's manage() immediately reapplies its cached
    // maximized/full-screen flags. Persist the reset geometry first so manage
    // cannot restore the state the user just asked us to clear.
    target.state.saveState(target.window);
    target.state.manage(target.window);
  }));
}

/** A renderer closing during reset is an observer loss, not a reset failure. */
export function broadcastWindowLayoutReset(
  windows: readonly LayoutResetBroadcastWindow[],
  initiatingContents?: LayoutResetWebContents
): void {
  const sent = new Set<LayoutResetWebContents>();
  for (const window of windows) {
    try {
      if (window.isDestroyed()) continue;
      const contents = window.webContents;
      if (contents === initiatingContents || sent.has(contents) || contents.isDestroyed()) continue;
      sent.add(contents);
      contents.send(DESKTOP_CHANNELS.layoutResetBroadcast);
    } catch {
      // BrowserWindow.webContents can throw after the native window closes,
      // and send can race a renderer teardown. Remaining observers still reset.
    }
  }
}

async function leaveWindowState(
  window: ResettableWindow,
  event: "leave-full-screen" | "unmaximize",
  complete: () => boolean,
  transition: () => void
): Promise<void> {
  if (window.isDestroyed() || complete()) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.removeListener(event, finish);
      window.removeListener("closed", finish);
      resolve();
    };
    window.once(event, finish);
    window.once("closed", finish);
    try {
      transition();
      if (window.isDestroyed() || complete()) queueMicrotask(finish);
    } catch (cause) {
      window.removeListener(event, finish);
      window.removeListener("closed", finish);
      reject(cause);
    }
  });
}
