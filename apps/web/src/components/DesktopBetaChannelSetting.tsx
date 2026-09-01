import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { RotateCcw } from "lucide-react";

import {
  useDesktopBetaChannelSettings,
  type DesktopBetaChannelError
} from "../desktop-beta-channel-settings.js";
import type { Translator } from "./types.js";
import { Button, IconButton, Modal, ModalBackButton, Pill, SwitchControl } from "./ui.js";

export function DesktopBetaChannelSetting({ t }: { readonly t: Translator }): JSX.Element | null {
  const { state, reload, setEnableBeta, reset, dismissRestart, relaunch } = useDesktopBetaChannelSettings();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const restartRef = useRef<HTMLButtonElement>(null);
  const resetFocusPendingRef = useRef(false);

  useEffect(() => {
    if (!resetFocusPendingRef.current || state.saving) return;
    resetFocusPendingRef.current = false;
    if (state.isCustomized || state.restartPrompt !== undefined) return;
    const frame = window.requestAnimationFrame(() => toggleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [state.isCustomized, state.restartPrompt, state.saving]);

  if (!state.available) return null;

  const disabled = state.loading || state.saving || state.error === "load";
  const prompt = state.restartPrompt;
  return (
    <>
      <header className="settings-section-heading"><h3>{t("settings.experimental")}</h3></header>
      <section className="settings-card desktop-beta-channel-card">
        <div className="setting-row desktop-beta-channel-setting">
          <div className="desktop-beta-channel-setting__copy">
            <strong>{t("settings.betaChannel.title")}</strong>
            <span>{t("settings.betaChannel.description")}</span>
            {state.error !== undefined && state.error !== "relaunch" && (
              <span className="desktop-beta-channel-setting__error" role="alert">
                {betaChannelErrorMessage(state.error, t)}
              </span>
            )}
            {state.notice === "disabled" && (
              <span className="desktop-beta-channel-setting__notice" role="status">
                {t("settings.betaChannel.disabled")}
              </span>
            )}
          </div>
          <div className="desktop-beta-channel-setting__actions">
            {state.error === "load" && (
              <Button tone="ghost" onClick={() => { void reload(); }}>{t("common.retry")}</Button>
            )}
            {state.isCustomized && (
              <>
                <Pill tone="neutral">{t("settings.customized")}</Pill>
                <IconButton
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
                checked={state.enableBeta}
                disabled={disabled}
                aria-label={t("settings.betaChannel.toggleAria")}
                onChange={(event) => { void setEnableBeta(event.currentTarget.checked); }}
              />
          </div>
        </div>
      </section>
      {prompt !== undefined && (
        <Modal
          key={prompt}
          open
          title={t("settings.betaChannel.restartTitle")}
          description={prompt === "busy"
            ? t("settings.betaChannel.restartBusyDescription")
            : t("settings.betaChannel.restartDescription")}
          size="small"
          dismissOnBackdrop={!state.restarting}
          onClose={dismissRestart}
          initialFocus={() => prompt === "busy" ? backRef.current : restartRef.current}
          restoreFocusFallback={() => toggleRef.current}
          headerLeading={<ModalBackButton controlRef={backRef} label={t("common.back")} disabled={state.restarting} onClick={dismissRestart} />}
        >
          {state.error === "relaunch" && (
            <p className="desktop-beta-channel-dialog__error" role="alert">
              {t("settings.betaChannel.relaunchFailed")}
            </p>
          )}
          <div className="modal__actions">
            <button
              ref={restartRef}
              type="button"
              className="button button--primary"
              disabled={state.restarting}
              onClick={() => { void relaunch(prompt === "busy"); }}
            >
              {t("settings.betaChannel.restartNow")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function betaChannelErrorMessage(error: DesktopBetaChannelError, t: Translator): string {
  if (error === "unavailable") return t("settings.betaChannel.unavailable");
  if (error === "load") return t("settings.betaChannel.loadFailed");
  if (error === "reset") return t("settings.betaChannel.resetFailed");
  if (error === "relaunch") return t("settings.betaChannel.relaunchFailed");
  return t("settings.betaChannel.toggleFailed");
}
