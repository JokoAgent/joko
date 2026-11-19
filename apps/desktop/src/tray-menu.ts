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

export interface WindowsTrayQuitOptions<Runtime extends object> {
  readonly getRuntime: () => Runtime | undefined;
  readonly isQuitting: () => boolean;
  readonly probeActivity: () => Promise<{ readonly blocksShutdown: boolean }>;
  readonly confirmQuit: () => Promise<boolean>;
  readonly quit: () => void;
}

export function createWindowsTrayQuitAction<Runtime extends object>(options: WindowsTrayQuitOptions<Runtime>) {
  let pending = false;
  return async (): Promise<void> => {
    if (pending || options.isQuitting()) return;
    const runtime = options.getRuntime();
    if (runtime === undefined) {
      options.quit();
      return;
    }

    const isCurrent = (): boolean => !options.isQuitting() && options.getRuntime() === runtime;
    pending = true;
    try {
      const activity = await options.probeActivity().catch(() => undefined);
      if (!isCurrent()) return;
      if (activity?.blocksShutdown !== false && !await options.confirmQuit()) return;
      if (isCurrent()) options.quit();
    } finally {
      pending = false;
    }
  };
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
