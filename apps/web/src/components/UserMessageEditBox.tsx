import { AlertCircle, CornerDownLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { Translator } from "./types.js";
import { Button, Spinner } from "./ui.js";

export interface UserMessageEditDraft {
  readonly text: string;
  readonly submitting: boolean;
  readonly error?: string;
}

export interface ControlledUserMessageEditDraft {
  readonly value: UserMessageEditDraft;
  readonly update: (next: UserMessageEditDraft) => void;
}

export function UserMessageEditBox({ initialText, draft, t, onCancel, onSubmit, blockedReason }: {
  readonly initialText: string;
  readonly draft?: ControlledUserMessageEditDraft;
  readonly t: Translator;
  readonly onCancel: () => void;
  readonly onSubmit: (text: string) => Promise<void>;
  readonly blockedReason?: string;
}): JSX.Element {
  const [localDraft, setLocalDraft] = useState<UserMessageEditDraft>({ text: initialText, submitting: false });
  const { text, submitting, error } = draft?.value ?? localDraft;
  const update = draft?.update ?? setLocalDraft;
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
    if (value.length === 0 || submitting || submittingRef.current || blockedReason !== undefined) return;
    submittingRef.current = true;
    update({ text, submitting: true });
    try {
      await onSubmit(value);
      update({ text, submitting: false });
    } catch (cause) {
      update({ text, submitting: false, error: cause instanceof Error && cause.message.trim().length > 0 ? cause.message : t("timeline.editFailed") });
    } finally {
      submittingRef.current = false;
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
      <textarea ref={textareaRef} value={text} disabled={submitting} rows={1} onChange={(event) => update({ text: event.target.value, error, submitting })} onKeyDown={onKeyDown} aria-label={t("timeline.editMessage")} />
      {blockedReason === undefined
        ? <p className="message-user-edit__hint"><CornerDownLeft aria-hidden="true" />{t("timeline.editSendHint")}</p>
        : <p className="message-user-edit__hint" role="status">{blockedReason}</p>}
      {error !== undefined && <p className="message-user-edit__error" role="alert"><AlertCircle aria-hidden="true" />{error}</p>}
      <div className="message-user-edit__actions">
        <Button tone="ghost" disabled={submitting} onClick={onCancel}>{t("common.cancel")}</Button>
        <Button tone="primary" disabled={submitting || text.trim().length === 0 || blockedReason !== undefined} onClick={() => { void save(); }}>{submitting && <Spinner label={t("common.working")} />}{t("timeline.editSend")}</Button>
      </div>
    </div>
  );
}
