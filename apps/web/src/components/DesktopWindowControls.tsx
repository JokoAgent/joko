import { useLayoutEffect } from "react";
import type { JSX } from "react";
import { Minus, Square, X } from "lucide-react";
import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";
import { DesktopPerformanceControls } from "./DesktopPerformanceControls.js";

export function shouldRenderDesktopWindowControls(platform: string | undefined): boolean {
  return platform !== undefined && platform !== "darwin";
}

/** Window lifetime remains shell-owned; the renderer only requests close. */
interface DesktopWindowControlApi {
  readonly platform: string;
  readonly window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
  };
}

export function requestDesktopWindowClose(api: Pick<DesktopWindowControlApi, "window">): void {
  void api.window.close().catch(() => undefined);
}

export function DesktopWindowControls({ t, performanceOwner }: {
  readonly t: Translator;
  readonly performanceOwner?: { readonly id: string; readonly key: string };
}): JSX.Element | null {
  const desktop: DesktopWindowControlApi | undefined = window.jokoDesktop ?? window.jokoRuntimeProcessDiagnostics;
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

  const performance = performanceOwner && window.jokoDesktop?.performanceRecording
    ? <DesktopPerformanceControls key={performanceOwner.key} api={window.jokoDesktop.performanceRecording}
      profileId={performanceOwner.id} nativeMenu={platform === "darwin"} t={t} />
    : null;
  if (!shouldRenderDesktopWindowControls(platform) || desktop === undefined) return performance;

  return (
    <div className="desktop-window-controls" data-performance-recording={performance !== null || undefined}
      role="group" aria-label={t("desktop.windowControls")}>
      {performance}
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
