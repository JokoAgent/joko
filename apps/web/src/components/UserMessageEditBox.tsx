import { AlertCircle, CornerDownLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { Translator } from "./types.js";
import { Button, Spinner } from "./ui.js";

export function UserMessageEditBox({ initialText, t, onCancel, onMoveToComposer }: {
  readonly initialText: string;
  readonly t: Translator;
  readonly onCancel: () => void;
  readonly onMoveToComposer: (text: string) => Promise<void>;
}): JSX.Element {
  const [text, setText] = useState(initialText);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * .4)}px`;
  }, [text]);

  const save = async (): Promise<void> => {
    const value = text.trim();
    if (value.length === 0 || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onMoveToComposer(value);
    } catch (cause) {
      setError(cause instanceof Error && cause.message.trim().length > 0 ? cause.message : t("timeline.editFailed"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && !submitting) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <div className="message-user-edit" aria-label={t("timeline.editMessage")} aria-busy={submitting || undefined}>
      <textarea ref={textareaRef} value={text} disabled={submitting} rows={1} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} aria-label={t("timeline.editMessage")} />
      <p className="message-user-edit__hint"><CornerDownLeft aria-hidden="true" />{t("timeline.editComposerHint")}</p>
      {error !== undefined && <p className="message-user-edit__error" role="alert"><AlertCircle aria-hidden="true" />{error}</p>}
      <div className="message-user-edit__actions">
        <Button tone="ghost" disabled={submitting} onClick={onCancel}>{t("common.cancel")}</Button>
        <Button tone="primary" disabled={submitting || text.trim().length === 0} onClick={() => { void save(); }}>{submitting && <Spinner label={t("common.working")} />}{t("timeline.editMoveToComposer")}</Button>
      </div>
    </div>
  );
}
