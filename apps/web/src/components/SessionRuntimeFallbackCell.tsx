import { useEffect, useState, type JSX } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import type { AppController } from "../controller.js";
import type { AppSnapshot } from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { IconButton, SwitchControl } from "./ui.js";

export function SessionRuntimeFallbackCell({ controller, snapshot, runAction, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element | null {
  const supported = snapshot.backends.some((backend) =>
    backend.capabilities.get("model.switch")?.supported === true);
  const authoritative = snapshot.settings.personalization;
  const [enabled, setEnabled] = useState(authoritative.sessionRuntimeFallbackEnabled);
  const [customized, setCustomized] = useState(authoritative.sessionRuntimeFallbackCustomized);
  const [pending, setPending] = useState(false);

  useEffect(() => setEnabled(authoritative.sessionRuntimeFallbackEnabled), [authoritative.sessionRuntimeFallbackEnabled]);
  useEffect(() => setCustomized(authoritative.sessionRuntimeFallbackCustomized), [authoritative.sessionRuntimeFallbackCustomized]);

  if (!supported) return null;

  const toggle = (next: boolean): void => {
    if (pending) return;
    const previousEnabled = enabled;
    const previousCustomized = customized;
    setEnabled(next);
    setCustomized(true);
    setPending(true);
    runAction(`session-runtime-fallback:${next ? "enabled" : "disabled"}`, async () => {
      try {
        await controller.setSessionRuntimeFallbackEnabled(next);
      } catch (error) {
        setEnabled(previousEnabled);
        setCustomized(previousCustomized);
        throw error;
      } finally {
        setPending(false);
      }
    });
  };

  const reset = (): void => {
    if (pending) return;
    const previousEnabled = enabled;
    const previousCustomized = customized;
    setEnabled(false);
    setCustomized(false);
    setPending(true);
    runAction("session-runtime-fallback-reset", async () => {
      try {
        await controller.resetSessionRuntimeFallback();
      } catch (error) {
        setEnabled(previousEnabled);
        setCustomized(previousCustomized);
        throw error;
      } finally {
        setPending(false);
      }
    });
  };

  return <div className="personalization-tip-row" data-capability="model.switch">
    <div className="personalization-tip-row__content">
      <span className="personalization-tip-row__icon"><RefreshCw aria-hidden="true" /></span>
      <span className="personalization-tip-row__copy">
        <strong>{t("settings.sessionRuntimeFallback.label")}</strong>
        <span>{t("settings.sessionRuntimeFallback.description")}</span>
      </span>
    </div>
    <div className="personalization-row-actions">
      {customized && <div className="personalization-default-controls">
        <span>{t("settings.defaults.customized")}</span>
        <IconButton label={t("settings.defaults.restore")} disabled={pending} onClick={reset}>
          <RotateCcw aria-hidden="true" />
        </IconButton>
      </div>}
      <SwitchControl
        checked={enabled}
        disabled={pending}
        aria-label={t("settings.sessionRuntimeFallback.toggleAria")}
        onChange={(event) => toggle(event.target.checked)}
      />
    </div>
  </div>;
}
