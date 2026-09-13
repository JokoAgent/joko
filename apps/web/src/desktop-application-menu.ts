import { clampWindowZoom } from "./appearance-settings.js";
import {
  comboToElectronAccelerator,
  effectiveAppShortcutCombos,
  isAppShortcutComboBindable,
  type AppShortcutOverrides
} from "./app-shortcuts.js";

export type DesktopApplicationMenuCommand =
  | "open-about"
  | "new-session"
  | "open-settings"
  | "open-task-status-settings"
  | "check-for-updates"
  | "toggle-sidebar"
  | "zoom-reset"
  | "zoom-in"
  | "zoom-out";

export interface DesktopApplicationMenuPreferenceView {
  readonly navigationOpen: boolean;
  readonly windowZoom: number;
}

export interface DesktopApplicationMenuCommandActions {
  readonly getPreferences: () => DesktopApplicationMenuPreferenceView;
  readonly openAbout: () => void | Promise<void>;
  readonly openNewSession: () => void | Promise<void>;
  readonly openSettings: () => void | Promise<void>;
  readonly openTaskStatusSettings: () => void | Promise<void>;
  readonly checkForUpdates: () => void | Promise<void>;
  readonly setNavigationOpen: (open: boolean) => void | Promise<void>;
  readonly setWindowZoom: (zoom: number) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export interface DesktopApplicationMenuCommandQueue {
  readonly handle: (command: DesktopApplicationMenuCommand) => void;
  readonly sync: (preferences: DesktopApplicationMenuPreferenceView) => void;
  /** Deterministic test and shutdown fence; normal UI callers need not await. */
  readonly whenIdle: () => Promise<void>;
}

export type DesktopUpdateCheckResultView =
  | { readonly status: "available"; readonly version: string }
  | { readonly status: "up-to-date" }
  | { readonly status: "failed"; readonly errorKind: "configuration" | "check" | "download" | "orchestrator-shutdown" | "apply" }
  | {
    readonly status: "unavailable";
    readonly reason: "development" | "feed-unconfigured" | "versionless-build" | "updater-disabled";
  }
  | {
    readonly status: "manual-download";
    readonly reason: "linux-manual-only" | "unsupported-platform";
  };

export interface DesktopUpdateCheckNotice {
  readonly key:
    | "desktop.updateAvailableVersion"
    | "desktop.updateCurrent"
    | "desktop.updateFailed"
    | "desktop.updateUnavailable"
    | "desktop.updateUnavailableVersionless"
    | "desktop.updateManualLinux"
    | "desktop.updateManualUnsupported";
  readonly values?: Readonly<Record<string, string>>;
}

/** The menu command always reports the manual update-check outcome as a toast. */
export function desktopUpdateCheckNotice(result: DesktopUpdateCheckResultView): DesktopUpdateCheckNotice {
  if (result.status === "available") return { key: "desktop.updateAvailableVersion", values: { version: result.version } };
  if (result.status === "up-to-date") return { key: "desktop.updateCurrent" };
  if (result.status === "failed") return { key: "desktop.updateFailed" };
  if (result.status === "unavailable" && result.reason === "versionless-build") {
    return { key: "desktop.updateUnavailableVersionless" };
  }
  if (result.status === "manual-download") return {
    key: result.reason === "linux-manual-only"
      ? "desktop.updateManualLinux"
      : "desktop.updateManualUnsupported"
  };
  return { key: "desktop.updateUnavailable" };
}

/**
 * Native menu messages can arrive more quickly than React commits. Keep a
 * serialized optimistic preference view so two clicks always mean two steps.
 */
export function createDesktopApplicationMenuCommandQueue(
  actions: DesktopApplicationMenuCommandActions
): DesktopApplicationMenuCommandQueue {
  let preferences: DesktopApplicationMenuPreferenceView | undefined;
  let pending = 0;
  let tail = Promise.resolve();

  const run = async (command: DesktopApplicationMenuCommand): Promise<void> => {
    if (command === "open-about") {
      await actions.openAbout();
      return;
    }
    if (command === "new-session") {
      await actions.openNewSession();
      return;
    }
    if (command === "open-settings") {
      await actions.openSettings();
      return;
    }
    if (command === "open-task-status-settings") {
      await actions.openTaskStatusSettings();
      return;
    }
    if (command === "check-for-updates") {
      await actions.checkForUpdates();
      return;
    }
    if (command === "toggle-sidebar") {
      const current = preferences ?? actions.getPreferences();
      const navigationOpen = !current.navigationOpen;
      preferences = { ...current, navigationOpen };
      await actions.setNavigationOpen(navigationOpen);
      return;
    }
    const current = preferences ?? actions.getPreferences();
    const windowZoom = command === "zoom-reset"
      ? 1
      : clampWindowZoom(current.windowZoom + (command === "zoom-in" ? 0.1 : -0.1));
    preferences = { ...current, windowZoom };
    await actions.setWindowZoom(windowZoom);
  };

  return {
    handle: (command) => {
      pending += 1;
      tail = tail
        .then(() => run(command))
        .catch((error: unknown) => { actions.onError?.(error); })
        .finally(() => {
          pending -= 1;
          if (pending === 0) preferences = actions.getPreferences();
        });
    },
    sync: (next) => {
      if (pending === 0) preferences = next;
    },
    whenIdle: () => tail
  };
}

export function desktopApplicationMenuAccelerators(
  overrides: AppShortcutOverrides
): {
  readonly newSessionAccelerator: string | null;
  readonly openSettingsAccelerator: string | null;
  readonly toggleSidebarAccelerator: string | null;
} {
  return {
    newSessionAccelerator: acceleratorFor("new-maker", overrides),
    openSettingsAccelerator: acceleratorFor("open-settings", overrides),
    toggleSidebarAccelerator: acceleratorFor("toggle-sidebar", overrides)
  };
}

function acceleratorFor(
  id: "new-maker" | "open-settings" | "toggle-sidebar",
  overrides: AppShortcutOverrides
): string | null {
  const combo = effectiveAppShortcutCombos(id, overrides, "darwin")[0];
  return combo === undefined || !isAppShortcutComboBindable(combo)
    ? null
    : comboToElectronAccelerator(combo, "darwin");
}
