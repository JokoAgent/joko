import { Check, Copy, Download, Images, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { TimelineItemView } from "../model.js";
import { assertBrowserActionCurrent, type BrowserActionContext } from "../browser-action.js";
import { orderedSelectedShareMessages } from "./share-selection-behavior.js";
import { buildShareSelectionImagePng, copyShareSelectionImagePng, downloadShareSelectionImagePng, shareSelectionImageMessages } from "./share-selection-image.js";
import { ShareMessageImageEmptyError, ShareMessageImageTooLargeError } from "./share-message-image.js";
import type { Translator } from "./types.js";
import { Button, Spinner, cx, formatDateTime } from "./ui.js";

type BusyKind = "copy" | "download";

export function ShareSelectionBar({ ownerKey, sessionName, messages, selectedIds, locale, t, onToggleAll, onCancel }: {
  readonly ownerKey: string;
  readonly sessionName: string;
  readonly messages: readonly TimelineItemView[];
  readonly selectedIds: ReadonlySet<string>;
  readonly locale: string;
  readonly t: Translator;
  readonly onToggleAll: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState<BusyKind>();
  const [feedback, setFeedback] = useState<{ readonly kind: "success" | "error"; readonly text: string }>();
  const barRef = useRef<HTMLElement>(null);
  const scopeRef = useRef<{ readonly ownerKey: string; readonly sourceKey: string; readonly document: Document; readonly release: () => void } | undefined>(undefined);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const closeTimerRef = useRef<{ readonly window: Window; readonly id: number } | undefined>(undefined);
  const selectAllRef = useRef<HTMLButtonElement>(null);
  const selectedMessages = orderedSelectedShareMessages(messages, selectedIds);
  const allSelected = messages.length > 0 && selectedMessages.length === messages.length;

  const content = {
    sessionName,
    messages: shareSelectionImageMessages(messages, selectedMessages, {
      user: t("timeline.you"),
      assistant: t("timeline.agent"),
      attachments: t("timeline.attachments")
    }, (createdAt) => formatDateTime(createdAt, locale))
  };
  const sourceKey = JSON.stringify([content, selectedMessages.map((message) => [message.id, message.sourceEventId, message.createdAt])]);
  const retire = useCallback((): void => {
    const request = requestRef.current;
    requestRef.current = undefined;
    request?.abort();
    const timer = closeTimerRef.current;
    closeTimerRef.current = undefined;
    if (timer !== undefined) timer.window.clearTimeout(timer.id);
    setBusy(undefined);
  }, []);

  useLayoutEffect(() => {
    const document = barRef.current?.ownerDocument;
    if (document === undefined) return;
    const current = scopeRef.current;
    if (current?.ownerKey === ownerKey && current.sourceKey === sourceKey && current.document === document) return;
    retire();
    current?.release();
    const onPageHide = (): void => { if (scopeRef.current === scope) { retire(); setFeedback(undefined); } };
    const ownerWindow = document.defaultView;
    const scope = { ownerKey, sourceKey, document, release: () => ownerWindow?.removeEventListener("pagehide", onPageHide) };
    scopeRef.current = scope;
    ownerWindow?.addEventListener("pagehide", onPageHide);
    setFeedback(undefined);
  });
  useLayoutEffect(() => () => { scopeRef.current?.release(); scopeRef.current = undefined; retire(); }, [retire]);

  useEffect(() => {
    selectAllRef.current?.focus();
  }, []);

  const run = async (kind: BusyKind, ownerDocument: Document): Promise<void> => {
    const scope = scopeRef.current;
    if (scope === undefined || scope.document !== ownerDocument || requestRef.current !== undefined || selectedMessages.length === 0) return;
    retire();
    const abort = new AbortController();
    const ownerWindow = ownerDocument.defaultView;
    const request = abort;
    const current = (): boolean => scopeRef.current === scope && requestRef.current === request && !abort.signal.aborted
      && barRef.current?.isConnected === true && barRef.current.ownerDocument === ownerDocument
      && ownerWindow?.document === ownerDocument && !ownerWindow.closed;
    const action: BrowserActionContext = { ownerDocument, signal: abort.signal };
    requestRef.current = request;
    setBusy(kind);
    setFeedback(undefined);
    try {
      assertBrowserActionCurrent(action);
      const blob = await buildShareSelectionImagePng(content, action);
      if (!current()) return;
      assertBrowserActionCurrent(action);
      if (kind === "copy") await copyShareSelectionImagePng(blob, action);
      else await downloadShareSelectionImagePng(blob, sessionName, selectedMessages[0]?.createdAt ?? Date.now(), action);
      if (!current()) return;
      setFeedback({ kind: "success", text: kind === "copy" ? t("timeline.shareSelectionCopied") : t("timeline.shareDownloaded") });
      if (ownerWindow !== null) {
        const timer = { window: ownerWindow, id: ownerWindow.setTimeout(() => {
          if (closeTimerRef.current !== timer || scopeRef.current !== scope || barRef.current?.ownerDocument !== ownerDocument || !barRef.current.isConnected || ownerWindow.document !== ownerDocument || ownerWindow.closed) return;
          closeTimerRef.current = undefined;
          onCancel();
        }, 900) };
        closeTimerRef.current = timer;
      }
    } catch (error) {
      if (!current()) return;
      setFeedback({
        kind: "error",
        text: error instanceof ShareMessageImageTooLargeError
          ? t("timeline.shareSelectionTooLarge")
          : error instanceof ShareMessageImageEmptyError
            ? t("timeline.shareEmpty")
            : kind === "copy"
              ? t("timeline.shareSelectionClipboardFailed")
              : t("timeline.shareFailed")
      });
    } finally {
      if (requestRef.current === request) { requestRef.current = undefined; setBusy(undefined); }
    }
  };

  return (
    <section ref={barRef} className="share-selection-bar" aria-label={t("timeline.shareSelectionTitle")} aria-busy={busy !== undefined || undefined}>
      <button
        ref={selectAllRef}
        type="button"
        className={cx("share-selection-bar__select-all", allSelected && "is-selected")}
        role="checkbox"
        aria-checked={allSelected}
        aria-label={t("timeline.shareSelectionSelectAll")}
        disabled={busy !== undefined || messages.length === 0}
        onClick={onToggleAll}
      >
        <span aria-hidden="true">{allSelected && <Check />}</span>
        {t("timeline.shareSelectionSelectAll")}
      </button>
      <div className="share-selection-bar__copy">
        <strong><Images aria-hidden="true" />{t("timeline.shareSelectionTitle")}</strong>
        <span>{t("timeline.shareSelectionCount", { count: selectedMessages.length })}</span>
      </div>
      <div className="share-selection-bar__actions">
        <Button tone="ghost" onClick={() => { retire(); onCancel(); }}><X aria-hidden="true" />{t("common.cancel")}</Button>
        <Button tone="secondary" disabled={busy !== undefined || selectedMessages.length === 0} onClick={(event) => { void run("download", event.currentTarget.ownerDocument); }}>
          {busy === "download" ? <Spinner label={t("timeline.shareGenerating")} /> : <Download aria-hidden="true" />}{t("timeline.shareSelectionDownload")}
        </Button>
        <Button tone="primary" disabled={busy !== undefined || selectedMessages.length === 0} onClick={(event) => { void run("copy", event.currentTarget.ownerDocument); }}>
          {busy === "copy" ? <Spinner label={t("timeline.shareGenerating")} /> : <Copy aria-hidden="true" />}{t("timeline.shareSelectionCopy")}
        </Button>
      </div>
      {feedback !== undefined && <p className={cx("share-selection-bar__feedback", feedback.kind === "error" && "is-error")} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
    </section>
  );
}
