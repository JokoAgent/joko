import { AlertCircle, LoaderCircle, Mic, RotateCcw, X } from "lucide-react";
import { useEffect, useState, type JSX } from "react";

import { translate, type MessageKey } from "../i18n.js";
import type { Locale } from "../model.js";
import { IconButton } from "./ui.js";

const ERROR_KEYS: Readonly<Record<Extract<JokoDesktopGlobalVoiceStatus, { readonly state: "error" }>["errorKind"], MessageKey>> = Object.freeze({
  unsupported: "voice.global.errors.unsupported",
  permission: "voice.global.errors.permission",
  microphone: "voice.global.errors.microphone",
  service: "voice.global.errors.service",
  empty: "voice.global.errors.empty",
  insertion: "voice.global.errors.insertion"
});

export function GlobalVoiceOverlay({ initialStatus = { state: "starting" } }: { readonly initialStatus?: JokoDesktopGlobalVoiceStatus }): JSX.Element {
  const api = window.jokoVoiceOverlay;
  const [status, setStatus] = useState<JokoDesktopGlobalVoiceStatus>(initialStatus);
  const locale = overlayLocale();
  const t = (key: MessageKey): string => translate(locale, key);
  useEffect(() => {
    document.body.classList.add("global-voice-overlay-host");
    return () => document.body.classList.remove("global-voice-overlay-host");
  }, []);
  useEffect(() => {
    if (api === undefined) return;
    let active = true;
    const unsubscribe = api.onStatus((value) => { if (active) setStatus(value); });
    void api.getStatus().then((value) => { if (active) setStatus(value); }).catch(() => {
      if (active) setStatus({ state: "error", errorKind: "service" });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);
  const transcript = status.state === "listening" || status.state === "submitting" ? status.transcript : "";
  const label = status.state === "starting"
    ? t("voice.starting")
    : status.state === "listening"
      ? t("voice.listening")
      : status.state === "submitting"
        ? t("voice.submitting")
        : status.state === "error"
          ? t(ERROR_KEYS[status.errorKind])
          : t("voice.global.title");
  return <main className="global-voice-overlay" aria-label={t("voice.global.title")}>
    <section className={`global-voice-overlay__card is-${status.state}`} aria-live="polite">
      <div className="global-voice-overlay__icon" aria-hidden="true">
        {status.state === "error" ? <AlertCircle /> : status.state === "starting" || status.state === "submitting" ? <LoaderCircle className="is-spinning" /> : <Mic />}
      </div>
      <div className="global-voice-overlay__copy">
        <strong>{label}</strong>
        {status.state === "error"
          ? <span>{t("voice.global.retry")}</span>
          : <span className={transcript === "" ? "is-placeholder" : undefined}>{transcript || t("voice.global.toggleHint")}</span>}
      </div>
      <div className="global-voice-overlay__actions">
        {status.state === "error" && <IconButton label={t("voice.global.retry")} onClick={() => { void api?.retry(); }}><RotateCcw aria-hidden="true" /></IconButton>}
        <IconButton label={t("voice.global.cancel")} onClick={() => { void api?.cancel(); }}><X aria-hidden="true" /></IconButton>
      </div>
      {status.state === "listening" && <div className="global-voice-overlay__meter" aria-hidden="true"><i /><i /><i /><i /><i /></div>}
    </section>
  </main>;
}

function overlayLocale(): Locale {
  if (typeof navigator !== "undefined" && navigator.language.toLocaleLowerCase().startsWith("zh")) return "zh-CN";
  return "en";
}
