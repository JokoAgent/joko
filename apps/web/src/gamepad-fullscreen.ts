interface DesktopFullscreenBridge {
  readonly window?: { readonly toggleFullscreen?: () => Promise<boolean> };
}

/** Recheck the originating Document before crossing the browser or native window boundary. */
export async function toggleGamepadFullscreen(doc: Document, desktop: DesktopFullscreenBridge | undefined, unavailable: string): Promise<void> {
  if (doc.defaultView === null || doc.defaultView.closed || doc.visibilityState !== "visible" || !doc.hasFocus()
    || doc.body.classList.contains("modal-open") || doc.body.dataset.appShortcutRecording === "1"
    || doc.querySelector("[data-gamepad-preview]") !== null) return;
  if (desktop !== undefined) {
    if (typeof desktop.window?.toggleFullscreen !== "function") throw new Error(unavailable);
    await desktop.window.toggleFullscreen();
    return;
  }
  if (doc.fullscreenElement != null) {
    if (typeof doc.exitFullscreen !== "function") throw new Error(unavailable);
    await doc.exitFullscreen();
    return;
  }
  if (typeof doc.documentElement.requestFullscreen !== "function") throw new Error(unavailable);
  await doc.documentElement.requestFullscreen();
}
