export interface DesktopTrayMenuHost<Menu> {
  isDestroyed(): boolean;
  popUpContextMenu(menu: Menu): void;
  focus(): void;
}

export interface DesktopTrayPopupMenu {
  once(event: "menu-will-close", listener: () => void): unknown;
  removeListener(event: "menu-will-close", listener: () => void): unknown;
}

export interface DesktopTrayMenuPopupOptions<Menu extends DesktopTrayPopupMenu> {
  readonly tray: DesktopTrayMenuHost<Menu> | undefined;
  readonly menu: Menu | undefined;
  readonly buildMenu: () => Menu;
  readonly retainMenu: (menu: Menu) => void;
  readonly retainActiveMenu: (menu: Menu) => void;
  readonly releaseActiveMenu: (menu: Menu) => void;
  readonly onUnavailable: (reason: "missing" | "destroyed") => void;
  readonly onError: (error: unknown) => void;
}

export interface DesktopTrayMenuLabels {
  readonly open: string;
  readonly quit: string;
}

export function resolveDesktopTrayMenuLabels(
  locale: string,
  managesLocalOrchestrator: boolean
): DesktopTrayMenuLabels {
  const normalized = locale.trim().toLowerCase();
  const labels = normalized === "zh" || normalized.startsWith("zh-cn") || normalized.startsWith("zh-hans")
    ? {
        open: "打开 Joko",
        quit: managesLocalOrchestrator ? "退出 Joko 和本地 Orchestrator" : "退出 Joko"
      }
    : {
        open: "Open Joko",
        quit: managesLocalOrchestrator ? "Quit Joko and local Orchestrator" : "Quit Joko"
      };
  return normalized === "en-xa"
    ? { open: pseudoLocalizeTrayLabel(labels.open), quit: pseudoLocalizeTrayLabel(labels.quit) }
    : labels;
}

/**
 * Windows uses an explicit right-click popup so the application owns the
 * diagnosable complete-exit path. Installing a context menu as well would
 * make Electron handle the native message before emitting `right-click`.
 */
export function usesJavaScriptTrayMenuPopup(platform: string): boolean {
  return platform === "win32";
}

/** Keep both the cached and currently open menu alive until native dismissal. */
export function popUpDesktopTrayMenu<Menu extends DesktopTrayPopupMenu>(
  options: DesktopTrayMenuPopupOptions<Menu>
): boolean {
  const tray = options.tray;
  if (tray === undefined) {
    options.onUnavailable("missing");
    return false;
  }
  if (tray.isDestroyed()) {
    options.onUnavailable("destroyed");
    return false;
  }

  try {
    const menu = options.menu ?? options.buildMenu();
    options.retainMenu(menu);
    let released = false;
    const releaseMenu = (): void => {
      if (released) return;
      released = true;
      options.releaseActiveMenu(menu);
    };
    const finishMenu = (): void => {
      releaseMenu();
      try {
        // Windows asks notification-area applications to return focus after
        // their shortcut menu closes, including the Escape dismissal path.
        tray.focus();
      } catch (error) {
        options.onError(error);
      }
    };
    options.retainActiveMenu(menu);
    try {
      menu.once("menu-will-close", finishMenu);
      // This tray-specific API owns the hidden notification-window foreground
      // handoff. Omitting the position makes Electron use the native cursor.
      tray.popUpContextMenu(menu);
    } catch (error) {
      menu.removeListener("menu-will-close", finishMenu);
      releaseMenu();
      throw error;
    }
    return true;
  } catch (error) {
    options.onError(error);
    return false;
  }
}

function pseudoLocalizeTrayLabel(value: string): string {
  const accents: Readonly<Record<string, string>> = {
    a: "à", e: "ë", i: "ï", o: "õ", u: "ü",
    A: "Â", E: "Ë", I: "Ï", O: "Ö", U: "Û"
  };
  return `［${[...value].map((character) => accents[character] ?? character).join("")}··］`;
}
