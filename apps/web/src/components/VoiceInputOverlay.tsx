import type { JSX } from "react";
import { Check, LoaderCircle, Mic, RotateCcw, X } from "lucide-react";
import type { VoiceMediaState } from "../voice-input-media.js";
import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";

export function VoiceInputOverlay({ state, transcript, error, stallWarning, canUseTranscript = false, t, onStop, onCancel, onRetry, onUseTranscript }: {
  readonly state: VoiceMediaState;
  readonly transcript: string;
  readonly error?: string;
  readonly stallWarning: boolean;
  readonly canUseTranscript?: boolean;
  readonly t: Translator;
  readonly onStop: () => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onUseTranscript?: () => void;
}): JSX.Element {
  const processing = state === "starting" || state === "submitting";
  const failed = state === "error";
  return <section className="voice-input-overlay" aria-live="polite" aria-busy={processing} data-state={state}>
    <header>
      <span className="voice-input-overlay__status-icon" aria-hidden="true">
        {processing ? <LoaderCircle className="voice-input-overlay__spinner" /> : <Mic />}
      </span>
      <strong>{voiceStatusLabel(state, t)}</strong>
      <span className="voice-input-overlay__actions">
        {state === "listening" && <IconButton label={t("voice.stop")} onClick={onStop}><Check aria-hidden="true" /></IconButton>}
        {failed && canUseTranscript && onUseTranscript !== undefined && <IconButton label={t("voice.stop")} onClick={onUseTranscript}><Check aria-hidden="true" /></IconButton>}
        {failed && <IconButton label={t("common.retry")} onClick={onRetry}><RotateCcw aria-hidden="true" /></IconButton>}
        <IconButton label={t("voice.cancel")} onClick={onCancel}><X aria-hidden="true" /></IconButton>
      </span>
    </header>
    <div className="voice-input-overlay__transcript">
      {failed
        ? <><span role="alert">{error ?? t("voice.errors.serviceUnavailable")}</span>{transcript.trim().length > 0 && <><br /><span>{transcript}</span></>}</>
        : transcript.trim().length > 0
          ? transcript
          : <span className="voice-input-overlay__placeholder">{t("voice.placeholder")}</span>}
    </div>
    {stallWarning && !failed && <p>{t("voice.stallWarning")}</p>}
  </section>;
}

function voiceStatusLabel(state: VoiceMediaState, t: Translator): string {
  if (state === "starting") return t("voice.starting");
  if (state === "listening") return t("voice.listening");
  if (state === "submitting") return t("voice.submitting");
  if (state === "error") return t("voice.error");
  return t("voice.listening");
}
