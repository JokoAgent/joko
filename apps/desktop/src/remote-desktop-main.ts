import { join } from "node:path";

import {
  BrowserWindow,
  dialog,
  powerMonitor,
  powerSaveBlocker,
  screen,
  shell,
  systemPreferences
} from "electron";
import type { RemoteDesktopDisplay, RemoteDesktopPermissions } from "@joko/device-peer";

import {
  DesktopRemoteDesktopHost,
  type DesktopRemoteDesktopState
} from "./remote-desktop-host.js";
import { DesktopRemoteDesktopInput, readDesktopRemoteDesktopInputPermission } from "./remote-desktop-input.js";
import { DesktopRemoteDesktopMedia } from "./remote-desktop-media.js";
import type { DesktopRemoteDesktopSettingsStore } from "./remote-desktop-settings.js";

const MAC_SCREEN_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const MAC_ACCESSIBILITY_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

export interface DesktopRemoteDesktopMainOptions {
  readonly sourceDirectory: string;
  readonly settings: DesktopRemoteDesktopSettingsStore;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly changed: (state: DesktopRemoteDesktopState | undefined) => void;
  readonly retired?: () => void;
}

/** Compose the production Electron adapters without exposing any host value to preload. */
export function createDesktopRemoteDesktopMainHost(
  options: DesktopRemoteDesktopMainOptions
): DesktopRemoteDesktopHost {
  if (process.platform !== "darwin" && process.platform !== "win32" && process.platform !== "linux") {
    throw new Error("Remote Desktop is unavailable on this platform.");
  }
  let host: DesktopRemoteDesktopHost | undefined;
  let displayAwake: number | undefined;
  const media = new DesktopRemoteDesktopMedia(join(options.sourceDirectory, "remote-desktop-capture-preload.cjs"));
  const input = new DesktopRemoteDesktopInput(() => host?.releaseControl());
  const subscriptions = {
    display: (listener: (displayId: string, geometryChanged: boolean) => void): (() => void) => {
      const removed = (_event: Electron.Event, display: Electron.Display): void => {
        listener(String(display.id), true);
      };
      const changed = (
        _event: Electron.Event,
        display: Electron.Display,
        metrics: string[]
      ): void => {
        listener(String(display.id), metrics.some((metric) =>
          metric === "bounds" || metric === "scaleFactor" || metric === "rotation"));
      };
      screen.on("display-removed", removed);
      screen.on("display-metrics-changed", changed);
      return () => {
        screen.removeListener("display-removed", removed);
        screen.removeListener("display-metrics-changed", changed);
      };
    },
    session: (listener: (unlocked: boolean) => void): (() => void) => {
      const locked = (): void => { listener(false); };
      const unlocked = (): void => { listener(desktopSessionUnlocked()); };
      powerMonitor.on("lock-screen", locked);
      powerMonitor.on("unlock-screen", unlocked);
      return () => {
        powerMonitor.removeListener("lock-screen", locked);
        powerMonitor.removeListener("unlock-screen", unlocked);
      };
    }
  };
  host = new DesktopRemoteDesktopHost({
    platform: process.platform,
    enabled: () => options.settings.get().enabled,
    sessionUnlocked: desktopSessionUnlocked,
    displays: desktopDisplays,
    permissions: readDesktopRemoteDesktopPermissions,
    showPermissionGuide: (signal) => showDesktopRemoteDesktopPermissionGuide(options.getMainWindow(), signal),
    media,
    input,
    changed: (state) => {
      if (state !== undefined && displayAwake === undefined) {
        displayAwake = powerSaveBlocker.start("prevent-display-sleep");
      } else if (state === undefined && displayAwake !== undefined) {
        try { powerSaveBlocker.stop(displayAwake); } catch { /* The OS already retired the blocker. */ }
        displayAwake = undefined;
      }
      options.changed(state);
    },
    ...(options.retired === undefined ? {} : { retired: options.retired }),
    onDisplayChange: subscriptions.display,
    onSessionStateChange: subscriptions.session
  });
  return host;
}

function desktopSessionUnlocked(): boolean {
  try {
    const state = powerMonitor.getSystemIdleState(1);
    return state === "active" || state === "idle";
  } catch {
    // Unknown current session ownership is never allowed to expose pixels.
    return false;
  }
}

function desktopDisplays(): readonly RemoteDesktopDisplay[] {
  const displays = screen.getAllDisplays();
  if (displays.length > 32) throw new Error("Remote Desktop display catalog exceeds its bound.");
  return Object.freeze(displays.map((display, index) => {
    const name = (display.label || `Display ${index + 1}`).slice(0, 256);
    return Object.freeze({
      id: String(display.id),
      name,
      width: display.size.width,
      height: display.size.height
    });
  }));
}

export async function readDesktopRemoteDesktopPermissions(
  signal: AbortSignal = new AbortController().signal
): Promise<RemoteDesktopPermissions> {
  throwIfAborted(signal);
  if (process.platform !== "darwin") {
    return Object.freeze({ screenRecording: "notRequired", accessibility: "notRequired" });
  }
  let screenRecording: RemoteDesktopPermissions["screenRecording"] = "unknown";
  try {
    const status = systemPreferences.getMediaAccessStatus("screen");
    screenRecording = status === "granted" ? "granted" : status === "unknown" ? "unknown" : "missing";
  } catch {
    // Unknown is not granted.
  }
  const accessibility = await readDesktopRemoteDesktopInputPermission();
  throwIfAborted(signal);
  return Object.freeze({ screenRecording, accessibility });
}

export async function showDesktopRemoteDesktopPermissionGuide(
  owner: BrowserWindow | undefined,
  signal: AbortSignal = new AbortController().signal
): Promise<void> {
  throwIfAborted(signal);
  if (owner !== undefined && !owner.isDestroyed()) {
    if (owner.isMinimized()) owner.restore();
    owner.show();
    owner.focus();
  }
  const result = owner === undefined || owner.isDestroyed()
    ? await dialog.showMessageBox({
        type: "info",
        title: "Remote Desktop permissions",
        message: process.platform === "darwin"
          ? "Allow Screen Recording to share this desktop and Accessibility to control it."
          : "Remote Desktop permission guidance is available on the host computer.",
        buttons: process.platform === "darwin"
          ? ["Done", "Open Screen Recording", "Open Accessibility"]
          : ["Done"],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
    : await dialog.showMessageBox(owner, {
        type: "info",
        title: "Remote Desktop permissions",
        message: process.platform === "darwin"
          ? "Allow Screen Recording to share this desktop and Accessibility to control it."
          : "Remote Desktop permission guidance is available on the host computer.",
        buttons: process.platform === "darwin"
          ? ["Done", "Open Screen Recording", "Open Accessibility"]
          : ["Done"],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
  throwIfAborted(signal);
  if (process.platform === "darwin" && result.response === 1) {
    await shell.openExternal(MAC_SCREEN_SETTINGS);
  } else if (process.platform === "darwin" && result.response === 2) {
    await shell.openExternal(MAC_ACCESSIBILITY_SETTINGS);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Remote Desktop permission request was aborted.");
}
