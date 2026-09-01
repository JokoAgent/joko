import { Check, Copy, Download, Images, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { TimelineItemView } from "../model.js";
import { orderedSelectedShareMessages } from "./share-selection-behavior.js";
import { buildShareSelectionImagePng, copyShareSelectionImagePng, downloadShareSelectionImagePng, shareSelectionImageMessages } from "./share-selection-image.js";
import { ShareMessageImageEmptyError, ShareMessageImageTooLargeError } from "./share-message-image.js";
import type { Translator } from "./types.js";
import { Button, Spinner, cx, formatDateTime } from "./ui.js";

type BusyKind = "copy" | "download";

export function ShareSelectionBar({ sessionName, messages, selectedIds, locale, t, onToggleAll, onCancel }: {
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
  const closeTimerRef = useRef<number | undefined>(undefined);
  const selectAllRef = useRef<HTMLButtonElement>(null);
  const selectedMessages = orderedSelectedShareMessages(messages, selectedIds);
  const allSelected = messages.length > 0 && selectedMessages.length === messages.length;

  useEffect(() => () => {
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    selectAllRef.current?.focus();
  }, []);

  const build = async (): Promise<Blob> => buildShareSelectionImagePng({
    sessionName,
    messages: shareSelectionImageMessages(messages, selectedMessages, {
      user: t("timeline.you"),
      assistant: t("timeline.agent"),
      attachments: t("timeline.attachments")
    }, (createdAt) => formatDateTime(createdAt, locale))
  });

  const run = async (kind: BusyKind): Promise<void> => {
    if (busy !== undefined || selectedMessages.length === 0) return;
    setBusy(kind);
    setFeedback(undefined);
    try {
      const blob = await build();
      if (kind === "copy") await copyShareSelectionImagePng(blob);
      else await downloadShareSelectionImagePng(blob, sessionName, selectedMessages[0]?.createdAt ?? Date.now());
      setFeedback({ kind: "success", text: kind === "copy" ? t("timeline.shareSelectionCopied") : t("timeline.shareDownloaded") });
      closeTimerRef.current = window.setTimeout(onCancel, 900);
    } catch (error) {
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
      setBusy(undefined);
    }
  };

  return (
    <section className="share-selection-bar" aria-label={t("timeline.shareSelectionTitle")} aria-busy={busy !== undefined || undefined}>
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
        <Button tone="ghost" disabled={busy !== undefined} onClick={onCancel}><X aria-hidden="true" />{t("common.cancel")}</Button>
        <Button tone="secondary" disabled={busy !== undefined || selectedMessages.length === 0} onClick={() => { void run("download"); }}>
          {busy === "download" ? <Spinner label={t("timeline.shareGenerating")} /> : <Download aria-hidden="true" />}{t("timeline.shareSelectionDownload")}
        </Button>
        <Button tone="primary" disabled={busy !== undefined || selectedMessages.length === 0} onClick={() => { void run("copy"); }}>
          {busy === "copy" ? <Spinner label={t("timeline.shareGenerating")} /> : <Copy aria-hidden="true" />}{t("timeline.shareSelectionCopy")}
        </Button>
      </div>
      {feedback !== undefined && <p className={cx("share-selection-bar__feedback", feedback.kind === "error" && "is-error")} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
    </section>
  );
}
