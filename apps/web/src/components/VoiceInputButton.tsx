import { useEffect, useState } from "react";
import { LoaderCircle, Mic } from "lucide-react";
import { IconButton } from "./ui.js";
import type { Translator } from "./types.js";
import type { useHeldVoiceInput } from "./use-held-voice-input.js";
import "./voice-input-button.css";

export function VoiceInputButton({ phase, held, sendTargetActive, startedAt, ownerWindow, enabled, buttonProps, t }: {
  readonly phase: string | undefined;
  readonly held: boolean;
  readonly sendTargetActive: boolean;
  readonly startedAt: number | undefined;
  readonly ownerWindow: (Window & typeof globalThis) | null | undefined;
  readonly enabled: boolean;
  readonly buttonProps: ReturnType<typeof useHeldVoiceInput>["buttonProps"];
  readonly t: Translator;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (ownerWindow == null || phase !== "listening" || startedAt === undefined) { setSeconds(0); return; }
    const update = () => setSeconds(Math.max(0, Math.floor((ownerWindow.Date.now() - startedAt) / 1000)));
    update(); const timer = ownerWindow.setInterval(update, 1000);
    return () => ownerWindow.clearInterval(timer);
  }, [phase, startedAt, ownerWindow]);
  const busy = phase === "starting" || phase === "submitting" || phase === "refining";
  const label = held ? t("voice.releaseToStop") : phase === "refining" ? t("voice.refining") : phase === "starting" ? t("voice.starting") : phase === "listening" ? t("voice.stop") : phase === "submitting" ? t("voice.submitting") : t("voice.start");
  return <span className="voice-input-button">
    <IconButton {...buttonProps} label={label} aria-pressed={phase === "listening" || held} aria-busy={busy}
      disabled={!enabled} aria-disabled={!enabled || phase === "submitting" || phase === "refining"}
      tooltipOpen={held ? !sendTargetActive : phase === "refining" ? true : busy || phase === "listening" ? false : undefined}
    >{busy ? <LoaderCircle className="voice-input-overlay__spinner" aria-hidden="true" /> : <Mic aria-hidden="true" />}</IconButton>
    {phase === "listening" && <span className="voice-input-button__time" aria-hidden="true">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>}
  </span>;
}
