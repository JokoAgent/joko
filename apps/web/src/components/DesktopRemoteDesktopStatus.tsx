import type { JSX } from "react";

import { useDesktopRemoteDesktop } from "../desktop-remote-desktop.js";
import type { Translator } from "./types.js";
import { Button, Pill } from "./ui.js";

export function DesktopRemoteDesktopStatus({ t }: { readonly t: Translator }): JSX.Element | null {
  const { state, disconnect } = useDesktopRemoteDesktop();
  if (!state.available || !state.active) return null;
  return <aside className="desktop-remote-desktop-status" aria-label={t("settings.remoteDesktop.statusAria")}>
    <div role="status" aria-live="polite">
      <Pill tone={state.controlling ? "warning" : "accent"}>
        {state.controlling ? t("settings.remoteDesktop.controlled") : t("settings.remoteDesktop.viewed")}
      </Pill>
      <span className="desktop-remote-desktop-status__summary">{t("settings.remoteDesktop.activeBody", {
        device: state.controllerDeviceId ?? t("common.unknown"),
        display: state.displayId ?? t("common.unknown")
      })}</span>
    </div>
    {state.error === "disconnect" && <span className="desktop-remote-desktop-status__error" role="alert">
      {t("settings.remoteDesktop.disconnectFailed")}
    </span>}
    <Button
      tone="danger"
      aria-label={t("settings.remoteDesktop.disconnect")}
      disabled={state.saving}
      onClick={() => { void disconnect(); }}
    >
      {t("connection.disconnect")}
    </Button>
  </aside>;
}
