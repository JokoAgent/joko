import { join } from "node:path";
import { release as osRelease } from "node:os";

import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
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
import { DesktopRemoteDesktopClipboard } from "./remote-desktop-clipboard.js";
import { DesktopRemoteDesktopClipboardCounter } from "./remote-desktop-clipboard-counter.js";
import { desktopRemoteDesktopLinuxClipboard, supportsDesktopRemoteDesktopLinuxClipboard } from "./remote-desktop-linux-clipboard.js";
import { DesktopRemoteDesktopPrivacyScreen } from "./remote-desktop-privacy-screen.js";
import { DesktopRemoteCredentialsNative, type DesktopRemoteCredentialsNativeOwner } from "./remote-desktop-credentials-native.js";
import { readDesktopRemoteDesktopLinuxCredentialLockState } from "./remote-desktop-linux-credentials.js";
import {
  DesktopRemoteDesktopInput,
  lockDesktopRemoteDesktopScreen,
  readDesktopRemoteDesktopDisplayModes,
  readDesktopRemoteDesktopInputPermission,
  readDesktopRemoteDesktopSessionState,
  restoreDesktopRemoteDesktopDisplayMode,
  setDesktopRemoteDesktopDisplayMode,
  type DesktopRemoteDesktopSessionState
} from "./remote-desktop-input.js";
import { DesktopRemoteDesktopMedia } from "./remote-desktop-media.js";
import { DesktopRemoteDesktopWindowsInput } from "./remote-desktop-windows-input.js";
import { desktopRemoteDesktopWindowsHost } from "./remote-desktop-windows-host.js";
import { readDesktopSystemAudioSupport } from "./remote-desktop-media-settings.js";
import type { DesktopRemoteDesktopSettingsStore } from "./remote-desktop-settings.js";
import type { SystemAudioMuteGuard } from "./system-audio-mute.js";
import type { DesktopInputHandoffHost } from "./input-handoff-native-host.js";
import { DesktopRemoteDesktopControlledOverlay } from "./remote-desktop-controlled-overlay.js";
import type { DesktopRemoteDesktopControllerDirectory } from "./remote-desktop-controller-directory.js";
import type { DesktopLocale } from "./channels.js";
import { DesktopRemoteDesktopLinuxMute, supportsDesktopRemoteDesktopLinuxMute
} from "./remote-desktop-linux-mute.js";
import { DesktopRemoteDesktopLinuxWorkspace, readDesktopRemoteDesktopLinuxWorkspaceSupport
} from "./remote-desktop-linux-workspace.js";
import { DesktopRemoteDesktopLinuxPrivacyScreen, supportsDesktopRemoteDesktopLinuxPrivacy,
  prepareDesktopRemoteDesktopLinuxPrivacy } from "./remote-desktop-linux-privacy.js";
import {
  WAYLAND_REMOTE_DESKTOP_DISPLAY_ID,
  isDesktopRemoteDesktopWayland,
  supportsDesktopRemoteDesktopLinuxCapture,
  readDesktopRemoteDesktopLinuxSessionState,
  readDesktopRemoteDesktopLinuxLockSessionState,
  readDesktopRemoteDesktopLinuxMonitors,
  readDesktopRemoteDesktopLinuxInputSupport,
  readDesktopRemoteDesktopLinuxCursorSupport,
  linuxRemoteDesktopDisplay
} from "./remote-desktop-linux.js";
import { lockDesktopRemoteDesktopLinuxScreen, supportsDesktopRemoteDesktopLinuxLock
} from "./remote-desktop-linux-lock.js";
import { createDesktopRemoteDesktopLinuxViewerDisplay, supportsDesktopRemoteDesktopLinuxViewerDisplay
} from "./remote-desktop-linux-viewer-display.js";
import { createDesktopRemoteDesktopMacViewerDisplay, supportsDesktopRemoteDesktopMacViewerDisplay
} from "./remote-desktop-macos-viewer-display.js";
import {
  readDesktopRemoteDesktopLinuxDisplayModes,
  setDesktopRemoteDesktopLinuxDisplayMode,
  restoreDesktopRemoteDesktopLinuxDisplayMode,
  supportsDesktopRemoteDesktopLinuxDisplayModes
} from "./remote-desktop-linux-display.js";

const MAC_SCREEN_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const MAC_ACCESSIBILITY_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const localNotices = new Set<DesktopRemoteDesktopControlledOverlay>();
export function refreshDesktopRemoteDesktopLocalNotices(): void { for (const notice of localNotices) notice.refresh(); }

export interface DesktopRemoteDesktopMainOptions {
  readonly sourceDirectory: string;
  readonly inputHandoff?: Pick<DesktopInputHandoffHost, "resolveLiveWindow" | "isLiveWindowCurrent" | "liveViewEnded" | "liveInputOwnership">;
  readonly settings: DesktopRemoteDesktopSettingsStore;
  readonly connectionsAllowed?: () => boolean;
  readonly credentialsOwner?: DesktopRemoteCredentialsNativeOwner;
  readonly systemAudioMute: SystemAudioMuteGuard<number | object>;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly changed: (state: DesktopRemoteDesktopState | undefined) => void;
  readonly retired?: () => void;
  readonly controllerDirectory?: DesktopRemoteDesktopControllerDirectory;
  readonly appearance?: () => { readonly dark: boolean; readonly locale: DesktopLocale };
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
  let controlledOverlay: DesktopRemoteDesktopControlledOverlay | undefined;
  let privacyRequested = false;
  const media = new DesktopRemoteDesktopMedia(join(options.sourceDirectory, "remote-desktop-capture-preload.cjs"),
    undefined, (leaseId) => { if (host?.state?.leaseId === leaseId) host.disconnect(); });
  const onPointer = (points: { x: number; y: number }[]) => controlledOverlay?.viewerPointer(points);
  const input = process.platform === "win32"
    ? new DesktopRemoteDesktopWindowsInput(() => host?.releaseControl(true), undefined, undefined, onPointer)
    : new DesktopRemoteDesktopInput(() => host?.releaseControl(true), undefined, onPointer);
  const linuxMute = process.platform === "linux" && isDesktopRemoteDesktopWayland() && supportsDesktopRemoteDesktopLinuxMute()
    ? new DesktopRemoteDesktopLinuxMute() : undefined;
  const linuxWorkspace = process.platform === "linux" && supportsDesktopRemoteDesktopLinuxCapture()
    ? new DesktopRemoteDesktopLinuxWorkspace() : undefined;
  const supportsPrivacy = (process.platform === "darwin" && typeof process.getSystemVersion === "function"
    && Number(process.getSystemVersion().split(".")[0]) >= 14)
    || (process.platform === "win32" && Number(osRelease().split(".")[2]) >= 19041);
  let namedLease: string | undefined;
  let controllerName: string | undefined;
  const syncOverlay = (): void => {
    const state = host?.state;
    if (!state || privacyRequested) { controlledOverlay?.update(null); return; }
    controlledOverlay?.update({ leaseId: state.leaseId, displayId: state.displayId,
      controlling: state.controlling, peer: state.controllerDeviceId,
      ...(namedLease === state.leaseId && controllerName ? { name: controllerName } : {}) });
    if (namedLease === state.leaseId) return;
    namedLease = state.leaseId; controllerName = undefined;
    void options.controllerDirectory?.name(state.controllerDeviceId).then(name => {
      if (host?.state?.leaseId !== state.leaseId || namedLease !== state.leaseId) return;
      controllerName = name; syncOverlay();
    }).catch(() => undefined);
  };
  if (supportsPrivacy) {
    controlledOverlay = new DesktopRemoteDesktopControlledOverlay(
      ids => media.setOverlayExclusions(ids),
      async peer => { if (!options.controllerDirectory) throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED"); await options.controllerDirectory.revoke(peer); },
      peer => { if (host?.state?.controllerDeviceId === peer) host.disconnect(); },
      { appearance: options.appearance ?? (() => ({ dark: nativeTheme?.shouldUseDarkColors === true, locale: "en" })),
        changed: () => options.changed(host?.state) }
    );
    localNotices.add(controlledOverlay);
  }
  const refreshAppearance = (): void => controlledOverlay?.refresh();
  nativeTheme?.on("updated", refreshAppearance);
  const privacy = process.platform === "linux" && isDesktopRemoteDesktopWayland() ? new DesktopRemoteDesktopLinuxPrivacyScreen({
    stopped: async (owner) => { await host!.stopPrivacyByUser(owner); },
    suspendInput: (current, signal) => input.pauseForPrivacy(current, signal)
  }) : supportsPrivacy ? new DesktopRemoteDesktopPrivacyScreen({
    excluded: (owner, ids) => { if (process.platform === "darwin") media.setPrivacyExclusions(owner, ids); },
    cleared: (owner) => { if (process.platform === "darwin") media.clearPrivacyExclusions(owner); },
    prepare: async (owner, displayId, current, signal) => {
      if (process.platform === "darwin") await media.preparePrivacy(owner, displayId, current, signal);
    },
    stopped: async (owner) => { await host!.stopPrivacyByUser(owner); },
    suspendInput: (current, signal) => input.pauseForPrivacy(current, signal)
  }) : undefined;
  const clipboard = process.platform === "darwin" || process.platform === "win32"
    || process.platform === "linux" && supportsDesktopRemoteDesktopLinuxCapture() && supportsDesktopRemoteDesktopLinuxClipboard()
    ? new DesktopRemoteDesktopClipboard((events) => input.send(events))
    : undefined;
  let linuxLayout: string | undefined;
  let linuxInputLayout: string | undefined;
  let linuxDisplays: readonly RemoteDesktopDisplay[] = Object.freeze([]);
  let linuxMonitors: Awaited<ReturnType<typeof readDesktopRemoteDesktopLinuxMonitors>> = Object.freeze([]);
  const linuxDisplayListeners = new Set<(displayId: string, geometryChanged: boolean,
    geometry?: { readonly width: number; readonly height: number; readonly metrics: readonly string[] }) => void>();
  const readLinuxDisplays = async (signal: AbortSignal): Promise<readonly RemoteDesktopDisplay[]> => {
    if (!supportsDesktopRemoteDesktopLinuxCapture()) {
      if (!isDesktopRemoteDesktopWayland()) {
        if (await readDesktopRemoteDesktopLinuxSessionState(signal) !== "unlocked") {
          throw new Error("REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED");
        }
        const displays = desktopDisplays();
        if (await readDesktopRemoteDesktopLinuxSessionState(signal) !== "unlocked") {
          throw new Error("REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED");
        }
        return displays;
      }
      return Object.freeze([{ id: WAYLAND_REMOTE_DESKTOP_DISPLAY_ID, name: "Shared screen",
        width: 1280, height: 720 }]);
    }
    const before = await readDesktopRemoteDesktopLinuxSessionState(signal);
    if (before !== "unlocked" && before !== "locked-logged-in") throw new Error("REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED");
    const monitors = await readDesktopRemoteDesktopLinuxMonitors(signal);
    const allMonitors = await readDesktopRemoteDesktopLinuxMonitors(signal, undefined, true);
    const after = await readDesktopRemoteDesktopLinuxSessionState(signal);
    if (after !== before) throw new Error("REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED");
    const layout = JSON.stringify(monitors);
    const inputLayout = JSON.stringify(monitors.map(({ name, x, y, scale, transform }) =>
      ({ name, x, y, scale, transform })));
    const displays = Object.freeze(monitors.map(linuxRemoteDesktopDisplay));
    const managed = host?.managedViewerDisplay;
    const sourcePresent = managed !== undefined && allMonitors.some(m => linuxRemoteDesktopDisplay(m).id === managed.sourceDisplayId);
    const ordinary = (items: typeof monitors) => items.filter(m => {
      const id = linuxRemoteDesktopDisplay(m).id;
      return id !== managed?.sourceDisplayId && id !== managed?.displayId;
    });
    const managedTransition = managed !== undefined && sourcePresent
      && JSON.stringify(ordinary(linuxMonitors)) === JSON.stringify(ordinary(monitors))
      && monitors.every(m => {
        const id = linuxRemoteDesktopDisplay(m).id;
        return id === managed.sourceDisplayId || id === managed.displayId || linuxMonitors.some(previous => previous.name === m.name);
      });
    if (managed !== undefined && !sourcePresent) host?.displayCoverageChanged();
    if (linuxLayout !== undefined && linuxLayout !== layout) {
      const old = linuxDisplays;
      const managedGeometry = linuxInputLayout === inputLayout && old.length === displays.length
        && old.every(display => {
          const next = displays.find(value => value.id === display.id);
          return next !== undefined && (next.width === display.width && next.height === display.height
            || host?.managesDisplayGeometry(display.id, next.width, next.height) === true);
        });
      if (!managedGeometry && !managedTransition) host?.releaseControl();
      if (readDesktopSystemAudioSupport()) media.setSessionState(after === "locked-logged-in", after);
      else media.setSessionState(after === "locked-logged-in");
      for (const display of old) {
        const next = displays.find(value => value.id === display.id);
        if (next === undefined || next.width !== display.width || next.height !== display.height) {
          if (managedTransition && (display.id === managed.sourceDisplayId || display.id === managed.displayId)) continue;
          for (const listener of linuxDisplayListeners) listener(display.id, true, { width: next?.width ?? display.width,
            height: next?.height ?? display.height, metrics: [next === undefined ? "removed" : "bounds"] });
        }
      }
    }
    linuxLayout = layout;
    linuxInputLayout = inputLayout;
    linuxDisplays = displays;
    linuxMonitors = monitors;
    return Object.freeze(allMonitors.map(linuxRemoteDesktopDisplay).filter(display => display.id !== managed?.displayId));
  };
  const subscriptions = {
    display: (listener: (displayId: string, geometryChanged: boolean, geometry?: {
      readonly width: number; readonly height: number; readonly metrics: readonly string[];
    }) => void): (() => void) => {
      if (process.platform === "linux" && isDesktopRemoteDesktopWayland()) {
        linuxDisplayListeners.add(listener);
        return () => { linuxDisplayListeners.delete(listener); };
      }
      const removed = (_event: Electron.Event, display: Electron.Display): void => {
        if (privacy?.active) host?.displayCoverageChanged();
        listener(String(display.id), true, {
          width: display.size.width, height: display.size.height, metrics: ["removed"]
        });
      };
      const added = (): void => { if (privacy?.active) host?.displayCoverageChanged(); };
      const changed = (
        _event: Electron.Event,
        display: Electron.Display,
        metrics: string[]
      ): void => {
        listener(String(display.id), metrics.some((metric) =>
          metric === "bounds" || metric === "workArea" || metric === "scaleFactor" || metric === "rotation"), {
            width: display.size.width, height: display.size.height, metrics: Object.freeze([...metrics])
          });
      };
      screen.on("display-removed", removed);
      screen.on("display-added", added);
      screen.on("display-metrics-changed", changed);
      return () => {
        screen.removeListener("display-removed", removed);
        screen.removeListener("display-added", added);
        screen.removeListener("display-metrics-changed", changed);
      };
    },
    session: (listener: () => void): (() => void) => {
      if (process.platform === "linux") {
        let previous: DesktopRemoteDesktopSessionState | undefined;
        let pending = false;
        let retired = false;
        const refresh = async (): Promise<void> => {
          if (pending || retired || !options.settings.get().enabled) return;
          pending = true;
          try {
            const current = await readDesktopRemoteDesktopLinuxSessionState(new AbortController().signal);
            if (retired) return;
            if (previous !== undefined && previous !== current) listener();
            previous = current;
            if (host?.state !== undefined && (current === "unlocked" || current === "locked-logged-in")) {
              try { await readLinuxDisplays(new AbortController().signal); } catch { if (!retired) listener(); }
            }
          } catch { if (!retired) listener(); }
          finally { pending = false; }
        };
        const timer = setInterval(() => { void refresh(); }, 1_000);
        timer.unref?.();
        void refresh();
        return () => { retired = true; clearInterval(timer); };
      }
      const locked = (): void => { listener(); };
      const unlocked = (): void => { listener(); };
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
    ...(process.platform === "darwin" && options.inputHandoff ? { handoff: {
      resolve: (requestId: string, controllerDeviceId: string, signal: AbortSignal) => options.inputHandoff!.resolveLiveWindow(requestId, controllerDeviceId, signal),
      current: (window, controllerDeviceId, signal) => options.inputHandoff!.isLiveWindowCurrent(window, controllerDeviceId, signal),
      ended: (window, controllerDeviceId) => options.inputHandoff!.liveViewEnded(window, controllerDeviceId),
      inputOwnership: (window, controllerDeviceId) => options.inputHandoff!.liveInputOwnership(window, controllerDeviceId)
    } } : {}),
    systemAudio: readDesktopSystemAudioSupport(),
    enabled: () => options.settings.get().enabled && (options.connectionsAllowed?.() ?? true),
    sessionState: desktopSessionState,
    displays: process.platform === "linux" ? readLinuxDisplays : desktopDisplays,
    ...(process.platform === "win32" ? { windowsCapabilities: async (signal: AbortSignal) => {
      const ready = await desktopRemoteDesktopWindowsHost.readSupport(signal) === "ready";
      return { canControl: ready, cursorOverlay: ready };
    } } : {}),
    ...(process.platform === "linux" ? { linuxCapabilities: async (signal: AbortSignal) => ({
      ...(linuxWorkspace === undefined ? { workspaceNavigation: false, systemMenu: false }
        : await readDesktopRemoteDesktopLinuxWorkspaceSupport(signal)),
      lockOnExit: isDesktopRemoteDesktopWayland() && await supportsDesktopRemoteDesktopLinuxLock(signal),
      canControl: supportsDesktopRemoteDesktopLinuxCapture() && await readDesktopRemoteDesktopLinuxInputSupport(signal),
      cursorOverlay: supportsDesktopRemoteDesktopLinuxCapture() && await readDesktopRemoteDesktopLinuxCursorSupport(signal),
      displayModes: supportsDesktopRemoteDesktopLinuxCapture() && await supportsDesktopRemoteDesktopLinuxDisplayModes(signal),
      viewerDisplay: supportsDesktopRemoteDesktopLinuxCapture() && await supportsDesktopRemoteDesktopLinuxViewerDisplay(signal),
      privacyScreen: supportsDesktopRemoteDesktopLinuxCapture() && await supportsDesktopRemoteDesktopLinuxPrivacy(signal)
    }), prepare: async (current: () => boolean, signal: AbortSignal) => {
      if (!supportsDesktopRemoteDesktopLinuxCapture() || !await supportsDesktopRemoteDesktopLinuxPrivacy(signal)) return;
      try { await prepareDesktopRemoteDesktopLinuxPrivacy(current, signal, true); }
      catch {
        // A plugin unavailable at preparation time preserves ordinary viewing.
        if (signal.aborted || !current()) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
      }
    } } : {}),
    permissions: readDesktopRemoteDesktopPermissions,
    showPermissionGuide: (signal) => showDesktopRemoteDesktopPermissionGuide(options.getMainWindow(), signal),
    media,
    input,
    ...(options.credentialsOwner !== undefined && (process.platform === "linux" && isDesktopRemoteDesktopWayland() || process.platform === "darwin"
      && typeof process.getSystemVersion === "function" && Number(process.getSystemVersion().split(".")[0]) >= 12)
      ? { credentials: { native: new DesktopRemoteCredentialsNative(), owner: options.credentialsOwner,
        ...(process.platform === "linux" ? { lockState: readDesktopRemoteDesktopLinuxCredentialLockState } : {}) } } : {}),
    ...(privacy === undefined ? {} : { privacyScreen: {
      set: async (owner: object, displayId: string, current: () => boolean, signal: AbortSignal) => {
        privacyRequested = true; controlledOverlay?.update(null);
        try { await privacy.set(owner, displayId, current, signal); }
        catch (error) { if (!privacy.active) privacyRequested = false; syncOverlay(); throw error; }
      },
      release: async (owner: object) => {
        try { await privacy.release(owner); }
        finally { if (!privacy.active) privacyRequested = false; queueMicrotask(syncOverlay); }
      }
    } }),
    ...(clipboard === undefined ? {} : { clipboard, clipboardCounter: new DesktopRemoteDesktopClipboardCounter() }),
    ...(linuxMute === undefined ? {} : { hostMute: linuxMute }),
    ...(linuxWorkspace === undefined ? {} : {
      workspaceAction: (action, displayId, current, signal) => linuxWorkspace.request(action, displayId, current, signal),
      stopWorkspaceActions: () => linuxWorkspace.stop()
    }),
    ...(process.platform === "darwin" || process.platform === "win32" ? {
      hostMute: {
        set: async (owner: object, enabled: boolean, current: () => boolean, signal: AbortSignal) => {
          const check = (): void => {
            if (signal.aborted || !current()) throw new Error("REMOTE_DESKTOP_HOST_MUTE_EXPIRED");
          };
          try {
            if (enabled) await options.systemAudioMute.acquire(owner, check);
            else await options.systemAudioMute.release(owner, check);
            check();
          } catch (error) {
            if (error instanceof Error && error.message === "REMOTE_DESKTOP_HOST_MUTE_EXPIRED") throw error;
            throw new Error("REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE");
          }
        },
        release: async (owner: object) => {
          try { await options.systemAudioMute.release(owner); }
          catch { throw new Error("REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE"); }
        }
      }
    } : {}),
    ...(process.platform === "darwin" ? {
      lockScreen: lockDesktopRemoteDesktopScreen,
      displayModes: readDesktopRemoteDesktopDisplayModes,
      setDisplayMode: setDesktopRemoteDesktopDisplayMode,
      restoreDisplayMode: restoreDesktopRemoteDesktopDisplayMode,
      displayPresent: (displayId: string) => screen.getAllDisplays().some((display) => String(display.id) === displayId)
    } : {}),
    ...(process.platform === "darwin" && !app.isPackaged ? {
      viewerDisplaySupported: supportsDesktopRemoteDesktopMacViewerDisplay,
      createViewerDisplay: createDesktopRemoteDesktopMacViewerDisplay
    } : {}),
    ...(process.platform === "linux" && isDesktopRemoteDesktopWayland() ? {
      lockScreen: lockDesktopRemoteDesktopLinuxScreen,
      lockSessionState: readDesktopRemoteDesktopLinuxLockSessionState
    } : {}),
    ...(process.platform === "linux" && supportsDesktopRemoteDesktopLinuxCapture() ? {
      displayModes: readDesktopRemoteDesktopLinuxDisplayModes,
      setDisplayMode: setDesktopRemoteDesktopLinuxDisplayMode,
      restoreDisplayMode: restoreDesktopRemoteDesktopLinuxDisplayMode,
      createViewerDisplay: createDesktopRemoteDesktopLinuxViewerDisplay,
      displayPresent: async (displayId: string) =>
        (await readDesktopRemoteDesktopLinuxMonitors(new AbortController().signal, undefined, true))
          .some(monitor => linuxRemoteDesktopDisplay(monitor).id === displayId)
    } : {}),
    changed: (state) => {
      if (state !== undefined && displayAwake === undefined) {
        displayAwake = powerSaveBlocker.start("prevent-display-sleep");
      } else if (state === undefined && displayAwake !== undefined) {
        try { powerSaveBlocker.stop(displayAwake); } catch { /* The OS already retired the blocker. */ }
        displayAwake = undefined;
      }
      syncOverlay();
      options.changed(state);
    },
    localNoticeVisible: () => controlledOverlay?.visible === true,
    retired: () => {
      nativeTheme?.removeListener("updated", refreshAppearance);
      controlledOverlay?.stop();
      if (controlledOverlay) localNotices.delete(controlledOverlay);
      options.retired?.();
    },
    onDisplayChange: subscriptions.display,
    onSessionStateChange: subscriptions.session
  });
  return host;
}

export async function closeDesktopRemoteDesktopClipboardWriter(): Promise<void> {
  await desktopRemoteDesktopLinuxClipboard.closePublishedWriter();
}

async function desktopSessionState(signal: AbortSignal): Promise<DesktopRemoteDesktopSessionState> {
  if (process.platform === "darwin") return readDesktopRemoteDesktopSessionState(signal);
  if (process.platform === "linux") {
    const state = await readDesktopRemoteDesktopLinuxSessionState(signal);
    return state === "locked-logged-in" && !supportsDesktopRemoteDesktopLinuxCapture() ? "unsupported" : state;
  }
  throwIfAborted(signal);
  try {
    const state = powerMonitor.getSystemIdleState(1);
    return state === "active" || state === "idle"
      ? "unlocked"
      : state === "locked"
        ? await desktopRemoteDesktopWindowsHost.readSupport(signal) === "ready" ? "locked-logged-in" : "unsupported"
        : "unknown";
  } catch {
    // Unknown current session ownership is never allowed to expose pixels.
    return "unknown";
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
