import { AlertTriangle, Check, Clipboard, Download, FileText, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";

import type { ArtifactView } from "../model.js";
import { IconButton, formatBytes } from "./ui.js";
import { TIMELINE_TEXT_PREVIEW_LIMIT_BYTES, timelineTextPreviewLikelyBinary } from "./timeline-text-attachment.js";
import "./timeline-text-attachment.css";

export interface TimelineTextAttachmentLightboxLabels {
  readonly preview: string;
  readonly loading: string;
  readonly unavailable: string;
  readonly tooLarge: string;
  readonly copy: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly download: string;
  readonly close: string;
}

export interface TimelineTextAttachmentLightboxProps {
  readonly artifact: ArtifactView;
  readonly labels: TimelineTextAttachmentLightboxLabels;
  readonly returnFocus?: HTMLElement | null;
  readonly loadUrl: (blobId: string) => Promise<string>;
  readonly onDownload: (blobId: string, fileName: string) => void | Promise<void>;
  readonly onClose: () => void;
}

type PreviewState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly text: string; readonly byteSize: number }
  | { readonly phase: "oversize"; readonly byteSize: number }
  | { readonly phase: "error" };

const FOCUSABLE = "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

export function TimelineTextAttachmentLightbox({
  artifact,
  labels,
  returnFocus,
  loadUrl,
  onDownload,
  onClose
}: TimelineTextAttachmentLightboxProps): JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [state, setState] = useState<PreviewState>(() => artifact.byteSize > TIMELINE_TEXT_PREVIEW_LIMIT_BYTES
    ? { phase: "oversize", byteSize: artifact.byteSize }
    : { phase: "loading" });
  const [feedback, setFeedback] = useState<string>();
  const feedbackTimerRef = useRef<number | undefined>(undefined);

  const close = useCallback((): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    onCloseRef.current();
  }, []);

  useEffect(() => {
    if (artifact.byteSize > TIMELINE_TEXT_PREVIEW_LIMIT_BYTES) return;
    const request = new AbortController();
    setState({ phase: "loading" });
    void loadUrl(artifact.blobId).then(async (url) => {
      const response = await fetch(url, { signal: request.signal });
      if (!response.ok) throw new Error(`Artifact preview failed (${response.status}).`);
      const blob = await response.blob();
      if (blob.size > TIMELINE_TEXT_PREVIEW_LIMIT_BYTES) {
        setState({ phase: "oversize", byteSize: blob.size });
        return;
      }
      const text = await blob.text();
      if (timelineTextPreviewLikelyBinary(text)) throw new Error("Artifact is not text.");
      setState({ phase: "ready", text, byteSize: blob.size });
    }).catch((error: unknown) => {
      if (!request.signal.aborted && (error as { readonly name?: string }).name !== "AbortError") setState({ phase: "error" });
    });
    return () => request.abort();
  }, [artifact.blobId, artifact.byteSize, loadUrl]);

  useEffect(() => {
    const body = document.body;
    const ownsModalLock = !body.classList.contains("modal-open");
    body.classList.add("text-attachment-lightbox-open", "modal-open");
    dialogRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const active = dialog.ownerDocument.activeElement;
      const index = focusable.indexOf(active as HTMLElement);
      if (index < 0 || (!event.shiftKey && index === focusable.length - 1) || (event.shiftKey && index === 0)) {
        event.preventDefault();
        (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      body.classList.remove("text-attachment-lightbox-open");
      if (ownsModalLock && document.querySelector(".image-lightbox, .workspace-image-lightbox, .text-attachment-lightbox") === null) body.classList.remove("modal-open");
      if (feedbackTimerRef.current !== undefined) window.clearTimeout(feedbackTimerRef.current);
      if (returnFocus?.isConnected === true) returnFocus.focus({ preventScroll: true });
    };
  }, [close, returnFocus]);

  const report = (message: string): void => {
    if (feedbackTimerRef.current !== undefined) window.clearTimeout(feedbackTimerRef.current);
    setFeedback(message);
    feedbackTimerRef.current = window.setTimeout(() => setFeedback(undefined), 1_600);
  };
  const copy = (value: string): void => {
    void navigator.clipboard.writeText(value).then(() => report(labels.copied), () => report(labels.copyFailed));
  };

  return createPortal(<div className="text-attachment-lightbox" role="presentation">
    <button className="text-attachment-lightbox__backdrop" type="button" aria-label={labels.close} onClick={close} />
    <div ref={dialogRef} className="text-attachment-lightbox__card" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="text-attachment-lightbox__header">
        <button type="button" className="text-attachment-lightbox__filename" aria-label={`${labels.preview}: ${artifact.fileName}`} title={artifact.fileName} onClick={() => copy(artifact.fileName)}>
          <FileText aria-hidden="true" />
          <span><strong id={titleId}>{artifact.title || artifact.fileName}</strong><small>{artifact.fileName} · {formatBytes(state.phase === "ready" || state.phase === "oversize" ? state.byteSize : artifact.byteSize)}</small></span>
        </button>
        <div className="text-attachment-lightbox__actions">
          {state.phase === "ready" && <IconButton label={labels.copy} onClick={() => copy(state.text)}><Clipboard aria-hidden="true" /></IconButton>}
          <IconButton label={labels.download} onClick={() => void onDownload(artifact.blobId, artifact.fileName)}><Download aria-hidden="true" /></IconButton>
          <IconButton label={labels.close} onClick={close}><X aria-hidden="true" /></IconButton>
        </div>
      </header>
      <main className="text-attachment-lightbox__body">
        {state.phase === "loading" && <div className="text-attachment-lightbox__status" role="status"><span className="spinner" aria-hidden="true" /><strong>{labels.loading}</strong></div>}
        {state.phase === "error" && <div className="text-attachment-lightbox__status" role="alert"><AlertTriangle aria-hidden="true" /><strong>{labels.unavailable}</strong></div>}
        {state.phase === "oversize" && <div className="text-attachment-lightbox__status"><AlertTriangle aria-hidden="true" /><strong>{labels.tooLarge}</strong><span>{formatBytes(state.byteSize)} · {formatBytes(TIMELINE_TEXT_PREVIEW_LIMIT_BYTES)}</span><button type="button" onClick={() => void onDownload(artifact.blobId, artifact.fileName)}><Download aria-hidden="true" />{labels.download}</button></div>}
        {state.phase === "ready" && <pre tabIndex={0}>{state.text}</pre>}
      </main>
      {feedback !== undefined && <div className="text-attachment-lightbox__feedback" role="status"><Check aria-hidden="true" />{feedback}</div>}
    </div>
  </div>, document.body);
}
