import type { BrowserWindow, Screen } from "electron";

const displaySettleMs = 300;
const displayTransitionMs = 2_000;
const restoreGestureMs = 500;
const WM_SYSCOMMAND = 0x0112;
const SC_RESTORE = 0xf120;
const WM_NCLBUTTONDBLCLK = 0x00a3;
const HTCAPTION = 2;

/** Correlate an actual Windows restore with a nearby display reconfiguration. */
export function installWindowsMainWindowMaximizeRecovery(window: BrowserWindow, screen: Screen): () => void {
  let displayChangedAt = -Infinity;
  let unmaximizedAt = -Infinity;
  let userRestoreAt = -Infinity;
  let reapplyTimer: ReturnType<typeof setTimeout> | undefined;

  const available = (): boolean => !window.isDestroyed() && window.isVisible() && !window.isMinimized() && !window.isFullScreen();

  const cancelTimer = (): void => {
    clearTimeout(reapplyTimer);
    reapplyTimer = undefined;
  };

  const clearTransition = (): void => {
    cancelTimer();
    displayChangedAt = unmaximizedAt = userRestoreAt = -Infinity;
  };

  const scheduleRecovery = (): void => {
    cancelTimer();
    reapplyTimer = setTimeout(() => {
      reapplyTimer = undefined;
      if (available() && !window.isMaximized()) window.maximize();
    }, displaySettleMs);
  };

  const onDisplayChange = (): void => {
    if (!available()) return;
    const at = performance.now();
    if (window.isMaximized()) displayChangedAt = at;
    else if (reapplyTimer !== undefined || at - unmaximizedAt <= displayTransitionMs) {
      displayChangedAt = at;
      scheduleRecovery();
    }
  };

  const onUnmaximize = (): void => {
    const at = performance.now();
    if (!available() || at - userRestoreAt <= restoreGestureMs) {
      clearTransition();
      return;
    }
    unmaximizedAt = at;
    userRestoreAt = -Infinity;
    if (at - displayChangedAt <= displayTransitionMs) scheduleRecovery();
  };

  const noteUserRestore = (): void => {
    if (available() && window.isMaximized()) userRestoreAt = performance.now();
  };

  const onManualBoundsChange = (): void => {
    if (window.isMaximized()) noteUserRestore();
    // Windows can report the start of a manual drag after the unmaximize event.
    else if (performance.now() - unmaximizedAt <= restoreGestureMs) clearTransition();
  };

  screen.on("display-added", onDisplayChange);
  screen.on("display-removed", onDisplayChange);
  screen.on("display-metrics-changed", onDisplayChange);
  window.on("unmaximize", onUnmaximize);
  window.on("maximize", () => {
    cancelTimer();
    unmaximizedAt = userRestoreAt = -Infinity;
  });
  window.on("hide", clearTransition);
  window.on("minimize", clearTransition);
  window.on("enter-full-screen", clearTransition);
  window.on("will-move", onManualBoundsChange);
  window.on("will-resize", onManualBoundsChange);
  window.hookWindowMessage(WM_SYSCOMMAND, (command) => {
    if (command.length >= 4 && (command.readUInt32LE() & 0xfff0) === SC_RESTORE) noteUserRestore();
  });
  window.hookWindowMessage(WM_NCLBUTTONDBLCLK, (hit) => {
    if (hit.length >= 4 && hit.readUInt32LE() === HTCAPTION) noteUserRestore();
  });
  window.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && !input.isAutoRepeat && input.key === "ArrowDown" &&
      (input.meta || input.modifiers.includes("meta") || input.modifiers.includes("command"))) noteUserRestore();
  });
  window.once("closed", () => {
    clearTransition();
    screen.removeListener("display-added", onDisplayChange);
    screen.removeListener("display-removed", onDisplayChange);
    screen.removeListener("display-metrics-changed", onDisplayChange);
  });
  return noteUserRestore;
}
