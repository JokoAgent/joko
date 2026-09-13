import { useArtifactDownload } from "./use-artifact-download.js";
import type { ArtifactDownloadContext } from "../model.js";
import { AlertTriangle, Check, Clipboard, Download, FileText, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { writeClipboardText } from "../clipboard-action.js";
import { useClipboardAction } from "./use-clipboard-action.js";

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
  readonly ownerKey: string;
  readonly artifact: ArtifactView;
  readonly labels: TimelineTextAttachmentLightboxLabels;
  readonly returnFocus?: HTMLElement | null;
  readonly loadUrl: (blobId: string) => Promise<string>;
  readonly onDownload: (blobId: string, fileName: string, context: ArtifactDownloadContext) => unknown | Promise<unknown>;
  readonly onClose: () => void;
}

type PreviewState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly text: string; readonly byteSize: number }
  | { readonly phase: "oversize"; readonly byteSize: number }
  | { readonly phase: "error" };

const FOCUSABLE = "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

export function TimelineTextAttachmentLightbox({
  ownerKey,
  artifact,
  labels,
  returnFocus,
  loadUrl,
  onDownload,
  onClose
}: TimelineTextAttachmentLightboxProps): JSX.Element {
  const ownerDocument = returnFocus?.ownerDocument ?? document;
  const ownerWindow = ownerDocument.defaultView;
  const downloadOwner = useMemo(() => ({ loadUrl, ownerDocument, returnFocus }), [loadUrl, ownerDocument, returnFocus]);
  const sourceOwner = useMemo(() => ({}), [ownerKey, artifact.blobId, artifact.fileName, artifact.byteSize, loadUrl, ownerDocument, returnFocus]);
  const sourceRef = useRef<object | undefined>(undefined);
  const previewRequestRef = useRef<AbortController | undefined>(undefined);
  const download = useArtifactDownload(JSON.stringify([ownerKey, artifact.blobId, artifact.fileName]), downloadOwner);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const closeTargetRef = useRef({ onClose, returnFocus });
  closeTargetRef.current = { onClose, returnFocus };
  const initialState: PreviewState = artifact.byteSize > TIMELINE_TEXT_PREVIEW_LIMIT_BYTES
    ? { phase: "oversize", byteSize: artifact.byteSize }
    : { phase: "loading" };
  const [preview, setPreview] = useState<{ readonly owner: object; readonly state: PreviewState }>();
  const state = preview?.owner === sourceOwner ? preview.state : initialState;
  const copy = useClipboardAction({
    ownerKey,
    sourceKey: JSON.stringify([artifact.blobId, artifact.fileName, artifact.byteSize]),
    ownerDocument,
    connectionOwner: downloadOwner
  });

  const close = useCallback((): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    download.cancel();
    copy.cancel();
    previewRequestRef.current?.abort();
    const target = closeTargetRef.current;
    if (target.returnFocus?.isConnected === true) target.returnFocus.focus({ preventScroll: true });
    target.onClose();
  }, [download.cancel, copy.cancel]);

  useLayoutEffect(() => {
    sourceRef.current = sourceOwner;
    closingRef.current = false;
    const request = new AbortController();
    previewRequestRef.current = request;
    let pending = artifact.byteSize <= TIMELINE_TEXT_PREVIEW_LIMIT_BYTES;
    const current = (): boolean => sourceRef.current === sourceOwner && !request.signal.aborted;
    const setState = (next: PreviewState): void => {
      if (!current()) return;
      pending = next.phase === "loading";
      setPreview({ owner: sourceOwner, state: next });
    };
    const onPageHide = (): void => { if (pending) setState({ phase: "error" }); request.abort(); };
    ownerWindow?.addEventListener("pagehide", onPageHide);
    if (artifact.byteSize <= TIMELINE_TEXT_PREVIEW_LIMIT_BYTES) {
      setState({ phase: "loading" });
      const fetchPreview = ownerWindow?.fetch?.bind(ownerWindow);
      void (async () => {
        try {
          const url = await loadUrl(artifact.blobId);
          if (!current()) return;
          if (fetchPreview === undefined) throw new Error("Artifact preview unavailable.");
          const response = await fetchPreview(url, { signal: request.signal });
          if (!current()) return;
          if (!response.ok) throw new Error("Artifact preview unavailable.");
          const blob = await response.blob();
          if (!current()) return;
          if (blob.size > TIMELINE_TEXT_PREVIEW_LIMIT_BYTES) {
            setState({ phase: "oversize", byteSize: blob.size });
            return;
          }
          const text = await blob.text();
          if (!current()) return;
          if (timelineTextPreviewLikelyBinary(text)) throw new Error("Artifact is not text.");
          setState({ phase: "ready", text, byteSize: blob.size });
        } catch { setState({ phase: "error" }); }
      })();
    }
    return () => {
      ownerWindow?.removeEventListener("pagehide", onPageHide);
      request.abort();
      if (previewRequestRef.current === request) previewRequestRef.current = undefined;
      if (sourceRef.current === sourceOwner) sourceRef.current = undefined;
    };
  }, [sourceOwner, artifact.blobId, artifact.byteSize, loadUrl, ownerWindow]);

  useEffect(() => {
    const body = ownerDocument.body;
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
    ownerDocument.addEventListener("keydown", onKeyDown, true);
    return () => {
      ownerDocument.removeEventListener("keydown", onKeyDown, true);
      body.classList.remove("text-attachment-lightbox-open");
      if (ownsModalLock && ownerDocument.querySelector(".image-lightbox, .workspace-image-lightbox, .text-attachment-lightbox") === null) body.classList.remove("modal-open");
    };
  }, [close, ownerDocument]);

  return createPortal(<div className="text-attachment-lightbox" role="presentation">
    <button className="text-attachment-lightbox__backdrop" type="button" aria-label={labels.close} onClick={close} />
    <div ref={dialogRef} className="text-attachment-lightbox__card" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="text-attachment-lightbox__header">
        <button type="button" className="text-attachment-lightbox__filename" aria-label={`${labels.preview}: ${artifact.fileName}`} title={artifact.fileName} aria-disabled={copy.pending} aria-busy={copy.pending} onClick={(event) => { if (!closingRef.current) copy.run(event.currentTarget.ownerDocument, (context) => writeClipboardText(artifact.fileName, context)); }}>
          <FileText aria-hidden="true" />
          <span><strong id={titleId}>{artifact.title || artifact.fileName}</strong><small>{artifact.fileName} · {formatBytes(state.phase === "ready" || state.phase === "oversize" ? state.byteSize : artifact.byteSize)}</small></span>
        </button>
        <div className="text-attachment-lightbox__actions">
          {state.phase === "ready" && <IconButton label={labels.copy} aria-disabled={copy.pending} aria-busy={copy.pending} onClick={(event) => { if (!closingRef.current) copy.run(event.currentTarget.ownerDocument, (context) => writeClipboardText(state.text, context)); }}><Clipboard aria-hidden="true" /></IconButton>}
          <IconButton label={labels.download} aria-disabled={download.pending} aria-busy={download.pending} onClick={(event) => download.run(event.currentTarget.ownerDocument, (context) => onDownload(artifact.blobId, artifact.fileName, context))}><Download aria-hidden="true" /></IconButton>
          <IconButton label={labels.close} onClick={close}><X aria-hidden="true" /></IconButton>
        </div>
      </header>
      <main className="text-attachment-lightbox__body">
        {state.phase === "loading" && <div className="text-attachment-lightbox__status" role="status"><span className="spinner" aria-hidden="true" /><strong>{labels.loading}</strong></div>}
        {state.phase === "error" && <div className="text-attachment-lightbox__status" role="alert"><AlertTriangle aria-hidden="true" /><strong>{labels.unavailable}</strong></div>}
        {state.phase === "oversize" && <div className="text-attachment-lightbox__status"><AlertTriangle aria-hidden="true" /><strong>{labels.tooLarge}</strong><span>{formatBytes(state.byteSize)} · {formatBytes(TIMELINE_TEXT_PREVIEW_LIMIT_BYTES)}</span><button type="button" aria-disabled={download.pending} aria-busy={download.pending} onClick={(event) => download.run(event.currentTarget.ownerDocument, (context) => onDownload(artifact.blobId, artifact.fileName, context))}><Download aria-hidden="true" />{labels.download}</button></div>}
        {state.phase === "ready" && <pre tabIndex={0}>{state.text}</pre>}
      </main>
      {download.failed && <div className="text-attachment-lightbox__feedback" role="alert">{labels.unavailable}</div>}
      {(copy.state === "copied" || copy.state === "failed") && <div className="text-attachment-lightbox__feedback" role={copy.state === "failed" ? "alert" : "status"}><Check aria-hidden="true" />{copy.state === "failed" ? labels.copyFailed : labels.copied}</div>}
    </div>
  </div>, ownerDocument.body);
}
