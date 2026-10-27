import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import { Check, Mic, X } from "lucide-react";
import type { AppController } from "../controller.js";
import { useDraftVoiceInput } from "./use-draft-voice-input.js";
import { IconButton } from "./ui.js";
import type { Translator } from "./types.js";

/** Dictation only edits this answer. Submitting or choosing an option remains
 * an explicit action owned by the question wizard. */
export function QuestionTextInput({ controller, ownerKey, enabled, label, value, multiline = true, placeholder, autoFocus, otherFieldId, onChange, onKeyDown, onFocus, t, children }: {
  readonly controller: AppController;
  readonly ownerKey: string;
  readonly enabled: boolean;
  readonly label: string;
  readonly value: string;
  readonly multiline?: boolean;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  readonly otherFieldId?: string;
  readonly onChange: (value: string) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  readonly onFocus?: () => void;
  readonly t: Translator;
  readonly children?: ReactNode;
}) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const voice = useDraftVoiceInput({ controller, ownerKey, enabled, root: root ?? undefined, t,
    focus: () => input.current?.focus(),
    capture: () => {
      const text = latest.current.value;
      const start = input.current?.selectionStart ?? text.length;
      const end = input.current?.selectionEnd ?? start;
      return (transcript: string) => {
        if (latest.current.value !== text) return undefined;
        const next = text.slice(0, start) + transcript + text.slice(end);
        latest.current.onChange(next);
        return next;
      };
    }
  });
  useEffect(() => {
    const ownerWindow = root?.ownerDocument.defaultView;
    ownerWindow?.addEventListener("blur", voice.cancel);
    return () => ownerWindow?.removeEventListener("blur", voice.cancel);
  }, [root, voice.cancel]);
  const props = { "aria-label": label, value, placeholder, autoFocus, disabled: !enabled,
    "data-question-other-input": otherFieldId,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
    onFocus, onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (voice.active && (event.key === "Enter" || event.key === "Escape") && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === "Escape") voice.cancel();
        else void voice.finish();
      } else onKeyDown?.(event);
    } };
  return <div ref={setRoot} className="question-dictation" onBlur={event => {
    const next = event.relatedTarget;
    if (!(next instanceof event.currentTarget.ownerDocument.defaultView!.Node) || !event.currentTarget.contains(next)) voice.cancel();
  }}>
    {multiline ? <textarea {...props} rows={1} ref={element => { input.current = element; }} />
      : <input {...props} type="text" ref={element => { input.current = element; }} />}
    <span className="question-dictation__actions">
      {voice.supported && <IconButton label={voice.active ? t("voice.stop") : t("voice.start")} disabled={!enabled || voice.phase === "submitting" || voice.phase === "refining"}
        aria-pressed={voice.active} onClick={() => { if (voice.active) void voice.finish(); else voice.start(); }}>
        {voice.active ? <Check aria-hidden="true" /> : <Mic aria-hidden="true" />}
      </IconButton>}
      {voice.active && <IconButton label={t("voice.cancel")} onClick={voice.cancel}><X aria-hidden="true" /></IconButton>}
      {children}
    </span>
    {voice.active && <small role="status">{voice.update?.session?.draft?.text || t(voice.phase === "starting" ? "voice.starting" : voice.phase === "listening" ? "voice.listening" : "voice.submitting")}</small>}
    {(voice.error || voice.draftError) && <small role="alert">{voice.draftError ?? voice.error}</small>}
  </div>;
}
