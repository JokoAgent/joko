import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { LoaderCircle, Sparkles, Trash2 } from "lucide-react";
import type { SessionTitleSuggestionView, SessionView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, IconButton, Modal, CheckboxControl } from "./ui.js";

export function RenameSessionDialog({ session, t, onClose, onRename, onSuggest }: {
  readonly session?: SessionView;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onRename: (name: string) => void;
  readonly onSuggest?: (signal: AbortSignal) => Promise<SessionTitleSuggestionView>;
}): JSX.Element {
  const [name, setName] = useState("");
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const selectGeneratedRef = useRef(false);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    requestRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = undefined;
    setName(session?.name ?? "");
    setGenerating(false);
    setNotice(undefined);
  }, [session?.id, session?.name]);

  useEffect(() => {
    if (!selectGeneratedRef.current) return;
    selectGeneratedRef.current = false;
    inputRef.current?.select();
  }, [name]);

  const cancel = (): void => {
    requestRef.current += 1;
    abortRef.current?.abort();
    onClose();
  };
  const commit = (): void => {
    const normalized = name.trim();
    if (normalized === "" || normalized === session?.name) return;
    requestRef.current += 1;
    abortRef.current?.abort();
    onRename(normalized);
  };
  const suggest = async (): Promise<void> => {
    if (onSuggest === undefined || generating) return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    const request = ++requestRef.current;
    setGenerating(true);
    setNotice(undefined);
    try {
      const result = await onSuggest(abort.signal);
      if (abort.signal.aborted || requestRef.current !== request) return;
      if (result.status === "ok" && result.title.trim() !== "") {
        selectGeneratedRef.current = true;
        setName(result.title);
      } else {
        setNotice(t(result.status === "no_material"
          ? "session.generateTitleNoMaterial"
          : result.status === "provider_unavailable"
            ? "session.generateTitleUnavailable"
            : "session.generateTitleFailed"));
      }
    } catch (error) {
      if (!abort.signal.aborted && requestRef.current === request) {
        setNotice(t("session.generateTitleFailed"));
      }
    } finally {
      if (requestRef.current === request) setGenerating(false);
    }
  };

  return <Modal open={session !== undefined} title={t("session.rename")} closeLabel={t("common.close")} size="small" onClose={cancel}>
    <form className="rename-session" onSubmit={(event) => { event.preventDefault(); commit(); }}>
      <label className="field">
        <span>{t("session.taskName")}</span>
        <span className="rename-session__input-shell">
          <input
            ref={inputRef}
            autoFocus
            value={name}
            onChange={(event) => {
              requestRef.current += 1;
              abortRef.current?.abort();
              setGenerating(false);
              setNotice(undefined);
              setName(event.target.value);
            }}
            maxLength={120}
          />
          {onSuggest !== undefined && <IconButton
            className="rename-session__magic"
            label={generating ? t("session.generatingTitle") : t("session.generateTitle")}
            disabled={generating}
            disabledReason={generating ? t("session.generatingTitle") : undefined}
            onClick={() => void suggest()}
          >{generating ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}</IconButton>}
        </span>
      </label>
      {notice !== undefined && <p className="rename-session__toast" role="alert">{notice}</p>}
      <div className="modal__actions">
        <Button onClick={cancel}>{t("common.cancel")}</Button>
        <Button type="submit" tone="primary" disabled={name.trim() === "" || name.trim() === session?.name}>{t("common.save")}</Button>
      </div>
    </form>
  </Modal>;
}

export function DeleteSessionDialog({ session, t, onClose, onDelete }: { readonly session?: SessionView; readonly t: Translator; readonly onClose: () => void; readonly onDelete: (deleteNative: boolean) => void }): JSX.Element {
  const [deleteNative, setDeleteNative] = useState(false);
  useEffect(() => { if (session !== undefined) setDeleteNative(false); }, [session?.id]);
  return <Modal open={session !== undefined} title={t("session.delete")} description={session?.name} closeLabel={t("common.close")} size="small" onClose={onClose}><div className="delete-dialog"><div className="delete-dialog__warning"><Trash2 aria-hidden="true" /><p>{t("session.deleteWarning")}</p></div><label className="check-row"><CheckboxControl checked={deleteNative} onChange={(event) => setDeleteNative(event.target.checked)} /><span><strong>{t("session.deleteNative")}</strong><small>{t("session.deleteNativeBody")}</small></span></label><div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="danger" onClick={() => onDelete(deleteNative)}><Trash2 aria-hidden="true" />{t("common.delete")}</Button></div></div></Modal>;
}

export function BulkDeleteSessionDialog({ sessions, t, onClose, onDelete }: {
  readonly sessions: readonly SessionView[];
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onDelete: (deleteNative: boolean) => void;
}): JSX.Element {
  const [deleteNative, setDeleteNative] = useState(false);
  const sessionKey = sessions.map((session) => session.id).join("\u0000");
  useEffect(() => { if (sessions.length > 0) setDeleteNative(false); }, [sessionKey]);
  return <Modal open={sessions.length > 0} title={t("session.delete")} closeLabel={t("common.close")} size="small" onClose={onClose}>
    <div className="delete-dialog">
      <div className="delete-dialog__warning"><Trash2 aria-hidden="true" /><p>{t("session.deleteWarning")}</p></div>
      <ul className="delete-dialog__sessions">{sessions.map((session) => <li key={session.id}>{session.name}</li>)}</ul>
      <label className="check-row"><CheckboxControl checked={deleteNative} onChange={(event) => setDeleteNative(event.target.checked)} /><span><strong>{t("session.deleteNative")}</strong><small>{t("session.deleteNativeBody")}</small></span></label>
      <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="danger" onClick={() => onDelete(deleteNative)}><Trash2 aria-hidden="true" />{t("common.delete")}</Button></div>
    </div>
  </Modal>;
}
