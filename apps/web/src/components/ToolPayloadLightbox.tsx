import { Check, Clipboard, FileText, ListChecks, Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { toolPayloadDiffFiles, type ToolPayloadSection } from "./tool-payload.js";
import { IconButton, SelectControl } from "./ui.js";
import "./tool-payload-lightbox.css";

const FOCUSABLE = "button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

export interface ToolPayloadLightboxLabels {
  readonly close: string;
  readonly copy: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly selectAll: string;
  readonly allFiles: string;
  readonly chooseFile: string;
}

export function ToolPayloadOpenButton({ label, onClick }: {
  readonly label: string;
  readonly onClick: (trigger: HTMLButtonElement) => void;
}): JSX.Element {
  return <IconButton
    className="tool-payload-open-button"
    label={label}
    onClick={(event) => onClick(event.currentTarget)}
  ><Maximize2 aria-hidden="true" /></IconButton>;
}

export function ToolPayloadLightbox({ title, sections, initialSectionId, labels, returnFocus, onClose }: {
  readonly title: string;
  readonly sections: readonly ToolPayloadSection[];
  readonly initialSectionId: ToolPayloadSection["id"];
  readonly labels: ToolPayloadLightboxLabels;
  readonly returnFocus?: HTMLElement | null;
  readonly onClose: () => void;
}): JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const feedbackTimerRef = useRef<number | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [visible, setVisible] = useState(false);
  const [sectionId, setSectionId] = useState(initialSectionId);
  const [fileId, setFileId] = useState("");
  const [feedback, setFeedback] = useState<"copied" | "failed">();

  const activeSection = sections.find((section) => section.id === sectionId) ?? sections[0];
  const files = useMemo(() => toolPayloadDiffFiles(activeSection?.text ?? ""), [activeSection?.text]);
  const activeFile = files.find((file) => file.id === fileId);
  const displayedText = activeFile?.text ?? activeSection?.text ?? "";

  const close = useCallback((): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    setVisible(false);
    closeTimerRef.current = window.setTimeout(() => onCloseRef.current(), 200);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    setFileId("");
  }, [sectionId]);

  useEffect(() => {
    textRef.current?.focus({ preventScroll: true });
    textRef.current?.setSelectionRange(0, 0);
  }, [fileId, sectionId]);

  useEffect(() => {
    const body = document.body;
    const ownsModalLock = !body.classList.contains("modal-open");
    body.classList.add("tool-payload-lightbox-open", "modal-open");
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
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      body.classList.remove("tool-payload-lightbox-open");
      if (ownsModalLock && document.querySelector(".image-lightbox, .workspace-image-lightbox, .text-attachment-lightbox") === null) body.classList.remove("modal-open");
      if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
      if (feedbackTimerRef.current !== undefined) window.clearTimeout(feedbackTimerRef.current);
      if (returnFocus?.isConnected === true) returnFocus.focus({ preventScroll: true });
    };
  }, [close, returnFocus]);

  const selectAll = (): void => {
    const text = textRef.current;
    if (text === null) return;
    text.focus({ preventScroll: true });
    text.select();
  };

  const copy = (): void => {
    void navigator.clipboard.writeText(displayedText).then(() => {
      setFeedback("copied");
      if (feedbackTimerRef.current !== undefined) window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = window.setTimeout(() => setFeedback(undefined), 1_600);
    }, () => setFeedback("failed"));
  };

  return createPortal(<div className={`tool-payload-lightbox${visible ? " is-visible" : ""}`} role="presentation">
    <button className="tool-payload-lightbox__backdrop" type="button" aria-label={labels.close} onClick={close} />
    <div ref={dialogRef} className="tool-payload-lightbox__card" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="tool-payload-lightbox__header">
        <div className="tool-payload-lightbox__title"><FileText aria-hidden="true" /><span><strong id={titleId}>{title}</strong><small>{activeSection?.label}</small></span></div>
        <div className="tool-payload-lightbox__actions">
          <IconButton label={labels.selectAll} onClick={selectAll}><ListChecks aria-hidden="true" /></IconButton>
          <IconButton label={labels.copy} onClick={copy}>{feedback === "copied" ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}</IconButton>
          <IconButton label={labels.close} onClick={close}><X aria-hidden="true" /></IconButton>
        </div>
      </header>
      {sections.length > 1 && <nav className="tool-payload-lightbox__tabs" aria-label={title}>
        {sections.map((section) => <button type="button" className={section.id === activeSection?.id ? "is-active" : undefined} aria-pressed={section.id === activeSection?.id} onClick={() => setSectionId(section.id)} key={section.id}>{section.label}</button>)}
      </nav>}
      {files.length > 1 && <div className="tool-payload-lightbox__file-switcher">
        <label htmlFor={`${titleId}-file`}>{labels.chooseFile}</label>
        <SelectControl id={`${titleId}-file`} value={fileId} onChange={(event) => setFileId(event.target.value)} aria-label={labels.chooseFile}>
          <option value="">{labels.allFiles}</option>
          {files.map((file) => <option value={file.id} key={file.id}>{file.path}</option>)}
        </SelectControl>
      </div>}
      <main className="tool-payload-lightbox__body">
        <textarea ref={textRef} value={displayedText} readOnly spellCheck={false} wrap="off" aria-label={`${title} · ${activeSection?.label ?? ""}`} />
      </main>
      {feedback !== undefined && <div className="tool-payload-lightbox__feedback" role={feedback === "failed" ? "alert" : "status"}><Check aria-hidden="true" />{feedback === "failed" ? labels.copyFailed : labels.copied}</div>}
    </div>
  </div>, document.body);
}
