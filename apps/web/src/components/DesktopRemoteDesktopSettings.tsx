import type { JSX } from "react";

import { useDesktopRemoteDesktop, type DesktopRemoteDesktopError } from "../desktop-remote-desktop.js";
import type { Translator } from "./types.js";
import { Button, Pill, Spinner, SwitchControl } from "./ui.js";

export function DesktopRemoteDesktopSettings({ t }: { readonly t: Translator }): JSX.Element | null {
  const { state, reload, setEnabled, disconnect, showPermissionGuide } = useDesktopRemoteDesktop();
  if (!state.available) return null;

  const disabled = state.loading || state.saving || state.error === "load";
  return <section className="settings-card desktop-remote-desktop-settings" aria-label={t("settings.remoteDesktop.title")}>
    <div className="setting-row">
      <div>
        <strong>{t("settings.remoteDesktop.allow")}</strong>
        <span>{t("settings.remoteDesktop.allowBody")}</span>
      </div>
      {state.loading
        ? <Spinner label={t("common.loading")} />
        : <SwitchControl
            checked={state.enabled}
            disabled={disabled}
            aria-label={t("settings.remoteDesktop.allow")}
            onChange={(event) => { void setEnabled(event.currentTarget.checked); }}
          />}
    </div>
    <div className="setting-row">
      <div>
        <strong>{t("settings.remoteDesktop.permissions")}</strong>
        <span>{t("settings.remoteDesktop.permissionsBody")}</span>
      </div>
      <div className="desktop-remote-desktop-settings__permissions">
        <PermissionPill label={t("settings.remoteDesktop.screenRecording")} status={state.permissions.screenRecording} t={t} />
        <PermissionPill label={t("settings.remoteDesktop.accessibility")} status={state.permissions.accessibility} t={t} />
        <Button tone="ghost" disabled={disabled} onClick={() => { void showPermissionGuide(); }}>
          {t("settings.remoteDesktop.openGuide")}
        </Button>
      </div>
    </div>
    {state.active && <div className="setting-row">
      <div>
        <strong>{state.controlling ? t("settings.remoteDesktop.controlled") : t("settings.remoteDesktop.viewed")}</strong>
        <span>{t("settings.remoteDesktop.activeBody", {
          device: state.controllerDeviceId ?? t("common.unknown"),
          display: state.displayId ?? t("common.unknown")
        })}</span>
      </div>
      <Button
        tone="danger"
        aria-label={t("settings.remoteDesktop.disconnect")}
        disabled={state.saving}
        onClick={() => { void disconnect(); }}
      >
        {t("connection.disconnect")}
      </Button>
    </div>}
    {state.error !== undefined && <div className="desktop-remote-desktop-settings__error" role="alert">
      <span>{errorMessage(state.error, t)}</span>
      {state.error === "load" && <Button tone="ghost" onClick={() => { void reload(); }}>{t("common.retry")}</Button>}
    </div>}
  </section>;
}

function PermissionPill({ label, status, t }: {
  readonly label: string;
  readonly status: JokoDesktopRemoteDesktopPermissionStatus;
  readonly t: Translator;
}): JSX.Element {
  const translated = status === "granted"
    ? t("settings.remoteDesktop.permissionGranted")
    : status === "missing"
      ? t("settings.remoteDesktop.permissionMissing")
      : status === "notRequired"
        ? t("settings.remoteDesktop.permissionNotRequired")
        : t("settings.remoteDesktop.permissionUnknown");
  return <Pill tone={status === "granted" || status === "notRequired" ? "success" : status === "missing" ? "warning" : "neutral"}>
    {label}: {translated}
  </Pill>;
}

function errorMessage(error: DesktopRemoteDesktopError, t: Translator): string {
  if (error === "load") return t("settings.remoteDesktop.loadFailed");
  if (error === "disconnect") return t("settings.remoteDesktop.disconnectFailed");
  if (error === "permissions") return t("settings.remoteDesktop.permissionsFailed");
  return t("settings.remoteDesktop.saveFailed");
}
