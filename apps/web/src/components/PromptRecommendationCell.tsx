import { useEffect, useState, type JSX } from "react";
import { RotateCcw, Sparkles } from "lucide-react";

import type { AppController } from "../controller.js";
import type { AppSnapshot } from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { IconButton, CheckboxControl, SwitchControl } from "./ui.js";
import "./personalization-features.css";

export function PromptRecommendationCell({ controller, snapshot, runAction, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element {
  const authoritative = snapshot.settings.promptRecommendation;
  const [enabled, setEnabled] = useState(authoritative.enabled);
  const [pending, setPending] = useState(false);

  useEffect(() => setEnabled(authoritative.enabled), [authoritative.enabled]);

  const toggle = (next: boolean): void => {
    if (pending) return;
    const previous = enabled;
    setEnabled(next);
    setPending(true);
    runAction(`prompt-recommendation:${next ? "enabled" : "disabled"}`, async () => {
      try {
        await controller.updatePromptRecommendationSettings(next);
      } catch (error) {
        setEnabled(previous);
        throw error;
      } finally {
        setPending(false);
      }
    });
  };

  const reset = (): void => {
    if (pending || !authoritative.customized) return;
    const previous = enabled;
    setEnabled(true);
    setPending(true);
    runAction("prompt-recommendation:reset", async () => {
      try {
        await controller.resetPromptRecommendationSettings();
      } catch (error) {
        setEnabled(previous);
        throw error;
      } finally {
        setPending(false);
      }
    });
  };

  return <div className="personalization-tip-row prompt-recommendation" data-capability="prompt.recommendation">
    <div className="personalization-tip-row__content">
      <span className="personalization-tip-row__icon"><Sparkles aria-hidden="true" /></span>
      <span className="personalization-tip-row__copy">
        <strong>{t("settings.promptRecommendation.label")}</strong>
        <span>{t("settings.promptRecommendation.description")}</span>
        {!authoritative.available && <small>{authoritative.unavailableReason || t("settings.promptRecommendation.unavailable")}</small>}
      </span>
    </div>
    <div className="personalization-row-actions">
      {authoritative.customized && <div className="personalization-default-controls"><span>{t("settings.defaults.customized")}</span><IconButton label={t("settings.defaults.restore")} disabled={pending} onClick={reset}><RotateCcw aria-hidden="true" /></IconButton></div>}
      <SwitchControl
          checked={enabled}
          disabled={pending || !authoritative.available}
          aria-label={t("settings.promptRecommendation.toggleAria")}
          onChange={(event) => toggle(event.target.checked)}
        />
    </div>
  </div>;
}
