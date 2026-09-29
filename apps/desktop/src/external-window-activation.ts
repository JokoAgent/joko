export interface ExternalWindowActivationTarget {
  moveTop(): void;
  focus(): void;
  setAlwaysOnTop(flag: boolean, level?: "floating" | "pop-up-menu"): void;
}

export interface ExternalWindowActivationApplication {
  focus(options?: { readonly steal?: boolean }): void;
}

/** Promote a window only after an explicit OS handoff, tray click, or notification click. */
export function promoteExternalWindowActivation(
  platform: NodeJS.Platform,
  application: ExternalWindowActivationApplication,
  window: ExternalWindowActivationTarget
): void {
  if (platform === "win32") {
    try { application.focus(); } catch { /* The window fallback still runs. */ }
    try { window.moveTop(); } catch { /* Some window managers do not expose z-order promotion. */ }
    try { window.focus(); } catch { /* The OS may deny foreground transfer. */ }
    return;
  }

  try {
    window.setAlwaysOnTop(true, platform === "darwin" ? "floating" : "pop-up-menu");
    if (platform === "darwin") {
      try { application.focus({ steal: true }); } catch { /* Window focus remains the fallback. */ }
    }
    try { window.focus(); } catch { /* The OS may deny foreground transfer. */ }
  } finally {
    try { window.setAlwaysOnTop(false); } catch { /* Never leave activation failure on the quit path. */ }
  }
}
