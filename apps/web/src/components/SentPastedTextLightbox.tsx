import { Check, Clipboard, FileText, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, type JSX } from "react";
import { createPortal } from "react-dom";
import { writeClipboardText } from "../clipboard-action.js";
import { useClipboardAction } from "./use-clipboard-action.js";
import { countComposerPasteLines } from "./composer-paste-pipeline.js";
import { IconButton } from "./ui.js";
import "./timeline-text-attachment.css";

export interface SentPastedTextLightboxLabels {
  readonly title: string;
  readonly lines: (count: number) => string;
  readonly copy: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly close: string;
}

export function SentPastedTextLightbox({ ownerKey, text, display, labels, returnFocus, onClose }: {
  readonly ownerKey: string;
  readonly text: string;
  readonly display: string;
  readonly labels: SentPastedTextLightboxLabels;
  readonly returnFocus?: HTMLElement | null;
  readonly onClose: () => void;
}): JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const ownerDocument = returnFocus?.ownerDocument ?? document;
  const closeTargetRef = useRef({ onClose, returnFocus });
  closeTargetRef.current = { onClose, returnFocus };
  const copy = useClipboardAction({ ownerKey, sourceKey: JSON.stringify([text, display]), ownerDocument, connectionOwner: returnFocus });
  useLayoutEffect(() => { closingRef.current = false; }, [ownerKey, text, display, ownerDocument, returnFocus]);
  const close = useCallback((): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    copy.cancel();
    const target = closeTargetRef.current;
    if (target.returnFocus?.isConnected === true) target.returnFocus.focus({ preventScroll: true });
    target.onClose();
  }, [copy.cancel]);

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
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")]
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      const active = dialog.ownerDocument.activeElement;
      const index = focusable.indexOf(active as HTMLElement);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
      } else if (index < 0 || (!event.shiftKey && index === focusable.length - 1) || (event.shiftKey && index === 0)) {
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

  return createPortal(<div className="text-attachment-lightbox sent-pasted-text-lightbox" role="presentation">
    <button className="text-attachment-lightbox__backdrop" type="button" aria-label={labels.close} onClick={close} />
    <div ref={dialogRef} className="text-attachment-lightbox__card" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="text-attachment-lightbox__header">
        <div className="text-attachment-lightbox__filename">
          <FileText aria-hidden="true" />
          <span><strong id={titleId}>{labels.title}</strong><small>{display} · {labels.lines(countComposerPasteLines(text))}</small></span>
        </div>
        <div className="text-attachment-lightbox__actions">
          <IconButton label={labels.copy} aria-disabled={copy.pending} aria-busy={copy.pending} onClick={(event) => { if (!closingRef.current) copy.run(event.currentTarget.ownerDocument, (context) => writeClipboardText(text, context)); }}><Clipboard aria-hidden="true" /></IconButton>
          <IconButton label={labels.close} onClick={close}><X aria-hidden="true" /></IconButton>
        </div>
      </header>
      <main className="text-attachment-lightbox__body"><pre tabIndex={0}>{text}</pre></main>
      {(copy.state === "copied" || copy.state === "failed") && <div className="text-attachment-lightbox__feedback" role={copy.state === "failed" ? "alert" : "status"}><Check aria-hidden="true" />{copy.state === "failed" ? labels.copyFailed : labels.copied}</div>}
    </div>
  </div>, ownerDocument.body);
}
