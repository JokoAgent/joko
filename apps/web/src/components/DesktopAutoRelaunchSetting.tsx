import { useEffect, useRef, type JSX } from "react";
import { RotateCcw } from "lucide-react";

import {
  useDesktopAutoRelaunchSettings,
  type DesktopAutoRelaunchSettingsError
} from "../desktop-auto-relaunch-settings.js";
import type { Translator } from "./types.js";
import { Button, IconButton, Pill, SwitchControl } from "./ui.js";

export function DesktopAutoRelaunchSetting({ t }: { readonly t: Translator }): JSX.Element | null {
  const { state, reload, setAutoRelaunchOnIdle, reset } = useDesktopAutoRelaunchSettings();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const resetFocusPendingRef = useRef(false);

  useEffect(() => {
    if (!resetFocusPendingRef.current || state.saving) return;
    resetFocusPendingRef.current = false;
    if (state.isCustomized) return;
    const frame = window.requestAnimationFrame(() => toggleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [state.isCustomized, state.saving]);

  if (!state.available) return null;

  const disabled = state.loading || state.saving || state.error === "load";
  return (
    <div className="setting-row desktop-auto-relaunch-setting">
      <div>
        <strong>{t("settings.aboutAutoUpdateLabel")}</strong>
        <span>{t("settings.aboutAutoUpdateDescription")}</span>
        {state.error !== undefined && (
          <span className="desktop-auto-relaunch-setting__error" role="alert">
            {autoRelaunchErrorMessage(state.error, t)}
          </span>
        )}
      </div>
      <div className="desktop-auto-relaunch-setting__actions">
        {state.error === "load" && (
          <Button tone="ghost" onClick={() => { void reload(); }}>{t("common.retry")}</Button>
        )}
        {state.isCustomized && (
          <>
            <Pill tone="neutral">{t("settings.customized")}</Pill>
            <IconButton
              className="desktop-auto-relaunch-setting__reset"
              label={t("settings.restoreDefault")}
              disabled={disabled}
              onClick={() => {
                resetFocusPendingRef.current = true;
                void reset();
              }}
            >
              <RotateCcw aria-hidden="true" />
            </IconButton>
          </>
        )}
        <SwitchControl
            controlRef={toggleRef}
            checked={state.autoRelaunchOnIdle}
            disabled={disabled}
            aria-label={t("settings.aboutAutoUpdateLabel")}
            onChange={(event) => { void setAutoRelaunchOnIdle(event.currentTarget.checked); }}
          />
      </div>
    </div>
  );
}

function autoRelaunchErrorMessage(error: DesktopAutoRelaunchSettingsError, t: Translator): string {
  if (error === "load") return t("settings.aboutAutoUpdateLoadFailed");
  if (error === "reset") return t("settings.aboutAutoUpdateResetFailed");
  return t("settings.aboutAutoUpdateSaveFailed");
}
