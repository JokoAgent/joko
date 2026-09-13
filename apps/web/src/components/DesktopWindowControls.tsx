import { useLayoutEffect } from "react";
import type { JSX } from "react";
import { Minus, Square, X } from "lucide-react";
import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";

export function shouldRenderDesktopWindowControls(platform: string | undefined): boolean {
  return platform !== undefined && platform !== "darwin";
}

/**
 * Window close is deliberately a shell-only hide-to-tray action. It does not
 * navigate away from the document, ask the renderer to choose a lifetime, or
 * disable the other window controls while Electron performs the hide.
 */
export function requestDesktopWindowClose(api: JokoDesktopApi): void {
  void api.window.close().catch(() => undefined);
}

export function DesktopWindowControls({ t }: {
  readonly t: Translator;
}): JSX.Element | null {
  const desktop = window.jokoDesktop;
  const platform = desktop?.platform;

  useLayoutEffect(() => {
    if (platform === undefined) return;
    document.documentElement.dataset.desktopPlatform = platform;
    return () => {
      if (document.documentElement.dataset.desktopPlatform === platform) {
        delete document.documentElement.dataset.desktopPlatform;
      }
    };
  }, [platform]);

  if (!shouldRenderDesktopWindowControls(platform) || desktop === undefined) return null;

  return (
    <div className="desktop-window-controls" role="group" aria-label={t("desktop.windowControls")}>
      <IconButton label={t("desktop.minimize")} onClick={() => { void desktop.window.minimize().catch(() => undefined); }}>
        <Minus aria-hidden="true" />
      </IconButton>
      <IconButton label={t("desktop.maximizeOrRestore")} onClick={() => { void desktop.window.toggleMaximize().catch(() => undefined); }}>
        <Square aria-hidden="true" />
      </IconButton>
      <IconButton className="desktop-window-controls__close" label={t("desktop.close")} onClick={() => requestDesktopWindowClose(desktop)}>
        <X aria-hidden="true" />
      </IconButton>
    </div>
  );
}
