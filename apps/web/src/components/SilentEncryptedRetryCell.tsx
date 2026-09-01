import { useEffect, useState, type JSX } from "react";
import { RotateCcw, ShieldAlert } from "lucide-react";
import type { AppController } from "../controller.js";
import type { AppSnapshot } from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { IconButton, CheckboxControl, SwitchControl } from "./ui.js";

/** Tips row rendered only for an advertised Backend capability. */
export function SilentEncryptedRetryCell({ controller, snapshot, runAction, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element | null {
  const supported = snapshot.backends.some((backend) =>
    backend.capabilities.get("context.silent_encrypted_retry")?.supported === true);
  const authoritative = snapshot.settings.personalization;
  const [enabled, setEnabled] = useState(authoritative.silentEncryptedRetryEnabled);
  const [customized, setCustomized] = useState(authoritative.silentEncryptedRetryCustomized);
  const [pending, setPending] = useState(false);

  useEffect(() => setEnabled(authoritative.silentEncryptedRetryEnabled), [authoritative.silentEncryptedRetryEnabled]);
  useEffect(() => setCustomized(authoritative.silentEncryptedRetryCustomized), [authoritative.silentEncryptedRetryCustomized]);

  if (!supported) return null;

  const toggle = (next: boolean): void => {
    if (pending) return;
    const previousEnabled = enabled;
    const previousCustomized = customized;
    setEnabled(next);
    setCustomized(true);
    setPending(true);
    runAction(`silent-encrypted-retry:${next ? "enabled" : "disabled"}`, async () => {
      try {
        await controller.setSilentEncryptedRetryEnabled(next);
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
    setEnabled(true);
    setCustomized(false);
    setPending(true);
    runAction("silent-encrypted-retry-reset", async () => {
      try {
        await controller.resetSilentEncryptedRetry();
      } catch (error) {
        setEnabled(previousEnabled);
        setCustomized(previousCustomized);
        throw error;
      } finally {
        setPending(false);
      }
    });
  };

  return (
    <div className="personalization-tip-row" data-capability="context.silent_encrypted_retry">
      <div className="personalization-tip-row__content">
        <span className="personalization-tip-row__icon"><ShieldAlert aria-hidden="true" /></span>
        <span className="personalization-tip-row__copy">
          <strong>{t("settings.silentEncryptedRetry.label")}</strong>
          <span>{t("settings.silentEncryptedRetry.description")}</span>
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
            aria-label={t("settings.silentEncryptedRetry.toggleAria")}
            onChange={(event) => toggle(event.target.checked)}
          />
      </div>
    </div>
  );
}
