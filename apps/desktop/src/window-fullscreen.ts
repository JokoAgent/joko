interface FullscreenWindow {
  readonly webContents: object;
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(value: boolean): void;
}

/** The request may change only the exact live application window that sent it. */
export function toggleApplicationWindowFullscreen(
  sender: object,
  candidate: FullscreenWindow | null,
  mainWindow: FullscreenWindow | undefined,
  sessionWindow: FullscreenWindow | undefined
): boolean {
  if (candidate === null || candidate.isDestroyed()
    || !((candidate === mainWindow || candidate === sessionWindow) && candidate.webContents === sender)) {
    throw new Error("Fullscreen requires the current application window.");
  }
  const next = !candidate.isFullScreen();
  candidate.setFullScreen(next);
  return next;
}
