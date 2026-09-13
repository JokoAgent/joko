import { Check, Clipboard, FileText, ListChecks, Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { writeClipboardText } from "../clipboard-action.js";
import { useClipboardAction } from "./use-clipboard-action.js";
import { toolPayloadDiffFiles, type ToolPayloadSection } from "./tool-payload.js";
import { IconButton, SelectControl, modalOwnsKeyboardEvent, selectControlOwnsEscape } from "./ui.js";
import "./tool-payload-lightbox.css";

const FOCUSABLE = "button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

export interface ToolPayloadLightboxLabels {
  readonly close: string;
  readonly copy: string;
  readonly copyTitle: string;
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

export function ToolPayloadLightbox({ ownerKey, title, sections, initialSectionId, labels, returnFocus, onClose }: {
  readonly ownerKey: string;
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
  const ownerDocument = returnFocus?.ownerDocument ?? document;
  const ownerWindow = ownerDocument.defaultView;
  const closingRef = useRef(false);
  const closeTimerRef = useRef<{ readonly ownerWindow: Window; readonly timer: number } | undefined>(undefined);
  const closeTargetRef = useRef({ onClose, returnFocus });
  closeTargetRef.current = { onClose, returnFocus };
  const scopeRef = useRef<object | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const [sectionId, setSectionId] = useState(initialSectionId);
  const [fileId, setFileId] = useState("");

  const activeSection = sections.find((section) => section.id === sectionId) ?? sections[0];
  const files = useMemo(() => toolPayloadDiffFiles(activeSection?.text ?? ""), [activeSection?.text]);
  const activeFile = files.find((file) => file.id === fileId);
  const displayedText = activeFile?.text ?? activeSection?.text ?? "";
  const sourceKey = JSON.stringify([title, sections.map((section) => [section.id, section.text])]);
  const copy = useClipboardAction({ ownerKey, sourceKey: JSON.stringify([title, activeSection?.id, fileId, displayedText]), ownerDocument, connectionOwner: returnFocus });
  const cancelClose = useCallback((): void => {
    const pending = closeTimerRef.current;
    closeTimerRef.current = undefined;
    if (pending !== undefined) pending.ownerWindow.clearTimeout(pending.timer);
  }, []);

  const close = useCallback((): void => {
    const scope = scopeRef.current;
    if (scope === undefined || closingRef.current || ownerWindow === null) return;
    closingRef.current = true;
    copy.cancel();
    setVisible(false);
    const target = closeTargetRef.current;
    closeTimerRef.current = { ownerWindow, timer: ownerWindow.setTimeout(() => {
      if (scopeRef.current !== scope) return;
      closeTimerRef.current = undefined;
      if (target.returnFocus?.isConnected === true) target.returnFocus.focus({ preventScroll: true });
      target.onClose();
    }, 200) };
  }, [ownerWindow, copy.cancel]);

  useLayoutEffect(() => {
    const scope = {};
    scopeRef.current = scope;
    closingRef.current = false;
    const frame = ownerWindow?.requestAnimationFrame(() => { if (scopeRef.current === scope) setVisible(true); });
    const onPageHide = (): void => { cancelClose(); closingRef.current = false; setVisible(true); };
    ownerWindow?.addEventListener("pagehide", onPageHide);
    return () => {
      if (scopeRef.current === scope) scopeRef.current = undefined;
      if (frame !== undefined) ownerWindow?.cancelAnimationFrame(frame);
      ownerWindow?.removeEventListener("pagehide", onPageHide);
      cancelClose();
    };
  }, [ownerKey, sourceKey, ownerWindow, returnFocus, cancelClose]);

  useLayoutEffect(() => { setSectionId(initialSectionId); setFileId(""); }, [ownerKey, initialSectionId]);

  useEffect(() => {
    setFileId("");
  }, [sectionId]);

  useEffect(() => {
    textRef.current?.focus({ preventScroll: true });
    textRef.current?.setSelectionRange(0, 0);
  }, [fileId, sectionId, ownerDocument, ownerKey]);

  useEffect(() => {
    const body = ownerDocument.body;
    const ownsModalLock = !body.classList.contains("modal-open");
    body.classList.add("tool-payload-lightbox-open", "modal-open");
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.defaultPrevented || dialogRef.current === null || !modalOwnsKeyboardEvent(event, dialogRef.current) || selectControlOwnsEscape(event, ownerDocument)) return;
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
    ownerDocument.addEventListener("keydown", onKeyDown, true);
    return () => {
      ownerDocument.removeEventListener("keydown", onKeyDown, true);
      body.classList.remove("tool-payload-lightbox-open");
      if (ownsModalLock && ownerDocument.querySelector(".image-lightbox, .workspace-image-lightbox, .text-attachment-lightbox, .tool-payload-lightbox") === null) body.classList.remove("modal-open");
    };
  }, [close, ownerDocument]);

  const selectAll = (): void => {
    const text = textRef.current;
    if (text === null) return;
    text.focus({ preventScroll: true });
    text.select();
  };

  const copyText = (value: string, initiatingDocument: Document): void => {
    if (!closingRef.current) copy.run(initiatingDocument, (context) => writeClipboardText(value, context));
  };

  return createPortal(<div className={`tool-payload-lightbox${visible ? " is-visible" : ""}`} role="presentation">
    <button className="tool-payload-lightbox__backdrop" type="button" aria-label={labels.close} onClick={close} />
    <div ref={dialogRef} className="tool-payload-lightbox__card" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="tool-payload-lightbox__header">
        <button type="button" className="tool-payload-lightbox__title" aria-label={labels.copyTitle} title={title} aria-disabled={copy.pending} aria-busy={copy.pending} onClick={(event) => copyText(title, event.currentTarget.ownerDocument)}><FileText aria-hidden="true" /><span><strong id={titleId}>{title}</strong><small>{activeSection?.label}</small></span></button>
        <div className="tool-payload-lightbox__actions">
          <IconButton label={labels.selectAll} onClick={selectAll}><ListChecks aria-hidden="true" /></IconButton>
          <IconButton label={labels.copy} aria-disabled={copy.pending} aria-busy={copy.pending} onClick={(event) => copyText(displayedText, event.currentTarget.ownerDocument)}>{copy.state === "copied" ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}</IconButton>
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
      {(copy.state === "copied" || copy.state === "failed") && <div className="tool-payload-lightbox__feedback" role={copy.state === "failed" ? "alert" : "status"}><Check aria-hidden="true" />{copy.state === "failed" ? labels.copyFailed : labels.copied}</div>}
    </div>
  </div>, ownerDocument.body);
}
