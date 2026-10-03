import { Check, Copy, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { WORKSPACE_MERMAID_EDIT_EVENT, WORKSPACE_MERMAID_OPEN_EVENT, type WorkspaceMermaidEditDetail, type WorkspaceMermaidOpenDetail, type WorkspaceMermaidLifetime } from "./workspace-markdown-mermaid.js";
import { copyMermaid, renderMermaidPng } from "./mermaid-image-export.js";
import { GeneratedImageAnnotationButton, type GeneratedImageAnnotationLabels } from "./GeneratedImageAnnotationButton.js";
import { useClipboardAction } from "./use-clipboard-action.js";
import { acquireModalLock, modalOwnsKeyboardEvent, Button, IconButton, Modal } from "./ui.js";
import "./workspace-mermaid-hosts.css";

export interface WorkspaceMermaidHostLabels {
  readonly editTitle: string;
  readonly source: string;
  readonly cancel: string;
  readonly apply: string;
  readonly targetMissing: string;
  readonly zoomOut: string;
  readonly zoomIn: string;
  readonly copy: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly close: string;
}

type WorkspaceMermaidEditShortcut = "apply" | "cancel" | undefined;

interface MermaidViewport {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

interface MermaidPointer {
  readonly x: number;
  readonly y: number;
  readonly type: string;
}

interface MermaidDragState {
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startX: number;
  readonly startY: number;
}

interface MermaidPinchState {
  readonly ids: readonly [number, number];
  readonly distance: number;
  readonly center: { readonly x: number; readonly y: number };
  readonly viewport: MermaidViewport;
}

/** The source editor treats an unchanged Cmd/Ctrl+Enter as cancel. */
export function workspaceMermaidEditShortcutAction(
  input: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">,
  dirty: boolean
): WorkspaceMermaidEditShortcut {
  if (input.key !== "Enter" || (!input.ctrlKey && !input.metaKey)) return undefined;
  return dirty ? "apply" : "cancel";
}


export function WorkspaceMermaidHosts({ ownerKey, rootRef, labels, annotationLabels, onSendToChat }: {
  readonly ownerKey: string;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly labels: WorkspaceMermaidHostLabels;
  readonly annotationLabels: GeneratedImageAnnotationLabels;
  readonly onSendToChat?: (file: File) => void | Promise<void>;
}): JSX.Element {
  const scope = useMemo(() => ({}), [ownerKey, rootRef]);
  const [open, setOpen] = useState<{ readonly scope: object; readonly detail: WorkspaceMermaidOpenDetail }>();
  const [edit, setEdit] = useState<{ readonly scope: object; readonly detail: WorkspaceMermaidEditDetail }>();
  useLayoutEffect(() => {
    const root = rootRef.current;
    const ownerDocument = root?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (root == null || ownerDocument === undefined || ownerWindow == null) return;
    let active = true;
    const accepts = (event: Event): boolean => {
      const detail = (event as CustomEvent<WorkspaceMermaidLifetime>).detail;
      return active && detail !== undefined && detail.returnFocus instanceof ownerWindow.HTMLElement
        && typeof detail.isCurrent === "function" && detail.signal !== undefined && !detail.signal.aborted && detail.isCurrent()
        && root.isConnected && root.ownerDocument === ownerDocument && detail.returnFocus.isConnected
        && detail.returnFocus.ownerDocument === ownerDocument && root.contains(detail.returnFocus) && event.target === detail.returnFocus;
    };
    const onOpen = (event: Event): void => {
      if (!accepts(event)) return;
      const detail = (event as CustomEvent<WorkspaceMermaidOpenDetail>).detail;
      if (typeof detail.svg !== "string" || typeof detail.source !== "string") return;
      event.stopPropagation(); setEdit(undefined); setOpen({ scope, detail });
    };
    const onEdit = (event: Event): void => {
      if (!accepts(event)) return;
      const detail = (event as CustomEvent<WorkspaceMermaidEditDetail>).detail;
      if (typeof detail.source !== "string" || typeof detail.apply !== "function" || typeof detail.restoreFocus !== "function") return;
      event.stopPropagation(); setOpen(undefined); setEdit({ scope, detail });
    };
    const retire = (): void => { active = false; setOpen(undefined); setEdit(undefined); };
    const resume = (): void => { if (root.isConnected && root.ownerDocument === ownerDocument) active = true; };
    root.addEventListener(WORKSPACE_MERMAID_OPEN_EVENT, onOpen);
    root.addEventListener(WORKSPACE_MERMAID_EDIT_EVENT, onEdit);
    ownerWindow.addEventListener("pagehide", retire);
    ownerWindow.addEventListener("pageshow", resume);
    return () => {
      active = false;
      root.removeEventListener(WORKSPACE_MERMAID_OPEN_EVENT, onOpen);
      root.removeEventListener(WORKSPACE_MERMAID_EDIT_EVENT, onEdit);
      ownerWindow.removeEventListener("pagehide", retire);
      ownerWindow.removeEventListener("pageshow", resume);
    };
  }, [rootRef, scope]);
  return <>
    {open?.scope === scope && <WorkspaceMermaidLightbox ownerKey={ownerKey} detail={open.detail} labels={labels} annotationLabels={annotationLabels} onSendToChat={onSendToChat} onClose={() => setOpen(undefined)} />}
    {edit?.scope === scope && <MermaidSourceEditor detail={edit.detail} labels={labels} onClose={() => setEdit(undefined)} />}
  </>;
}

function MermaidSourceEditor({ detail, labels, onClose }: {
  readonly detail: WorkspaceMermaidEditDetail;
  readonly labels: WorkspaceMermaidHostLabels;
  readonly onClose: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(detail.source);
  const [error, setError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const ownerDocument = detail.returnFocus.ownerDocument;
  const dirty = draft !== detail.source;
  useLayoutEffect(() => { setDraft(detail.source); setError(undefined); }, [detail]);
  const close = (): void => { detail.restoreFocus(); onClose(); };
  const apply = (): void => {
    if (!dirty) return;
    if (detail.apply(draft) === "target-missing") { setError(labels.targetMissing); return; }
    close();
  };
  return <Modal ownerDocument={ownerDocument} open title={labels.editTitle} onClose={close} size="large" restoreFocus={false}
    className="workspace-mermaid-source-modal" initialFocus={() => textareaRef.current}
  >
    <div className="workspace-mermaid-source-modal__content" onKeyDown={(event) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      const action = workspaceMermaidEditShortcutAction(event, dirty);
      if (action === undefined) return;
      event.preventDefault(); event.stopPropagation();
      if (action === "apply") apply(); else close();
    }}>
      <label className="workspace-mermaid-source-modal__field"><span>{labels.source}</span>
        <textarea ref={textareaRef} value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} />
      </label>
      {error !== undefined && <p className="workspace-mermaid-source-modal__error" role="alert">{error}</p>}
      <footer className="workspace-mermaid-source-modal__actions">
        <Button tone="ghost" onClick={close}>{labels.cancel}</Button>
        <Button tone="primary" disabled={!dirty} onClick={apply}>{labels.apply}</Button>
      </footer>
    </div>
  </Modal>;
}

export function WorkspaceMermaidLightbox({ ownerKey, detail, labels, annotationLabels, onSendToChat, onClose }: {
  readonly ownerKey: string;
  readonly detail: WorkspaceMermaidOpenDetail;
  readonly labels: WorkspaceMermaidHostLabels;
  readonly annotationLabels: GeneratedImageAnnotationLabels;
  readonly onSendToChat?: (file: File) => void | Promise<void>;
  readonly onClose: () => void;
}): JSX.Element | null {
  const ownerDocument = detail.returnFocus.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const scope = useMemo(() => ({}), [ownerKey, detail, ownerDocument]);
  const scopeRef = useRef<object | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [visible, setVisible] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const annotatingRef = useRef(false);
  const [viewport, setViewport] = useState<MermaidViewport>({ scale: 1, x: 0, y: 0 });
  const viewportRef = useRef(viewport);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<MermaidDragState | undefined>(undefined);
  const pointersRef = useRef(new Map<number, MermaidPointer>());
  const pinchRef = useRef<MermaidPinchState | undefined>(undefined);
  const backdropTapRef = useRef<{ readonly pointerId: number; readonly x: number; readonly y: number } | undefined>(undefined);
  const [wheeling, setWheeling] = useState(false);
  const timers = useRef<{ wheel?: number; close?: number }>({});
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const releasePointers = useCallback((): void => {
    const stage = stageRef.current;
    const pointerIds = [...pointersRef.current.keys()];
    pointersRef.current.clear();
    pinchRef.current = undefined;
    dragRef.current = undefined;
    backdropTapRef.current = undefined;
    for (const pointerId of pointerIds) if (stage?.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
  }, []);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) return;
    // Each presentation has its own SVG ID scope, including the expanded view of a visible diagram.
    const scene = card.shadowRoot ?? card.attachShadow({ mode: "open" });
    scene.innerHTML = detail.svg;
    const style = ownerDocument.createElement("style");
    style.textContent = "svg { width:100% !important; height:100% !important; max-width:none !important; max-height:none !important; }";
    scene.append(style);
  }, [detail.svg, ownerDocument]);
  const closingRef = useRef(false);
  const sourceKey = JSON.stringify([detail.svg, detail.source]);
  const copy = useClipboardAction({ ownerKey, sourceKey, ownerDocument, connectionOwner: detail.signal });
  const current = useCallback((): boolean => scopeRef.current === scope && !detail.signal.aborted && detail.isCurrent()
    && detail.returnFocus.isConnected && detail.returnFocus.ownerDocument === ownerDocument, [detail, ownerDocument, scope]);
  const applyViewport = useCallback((next: { readonly scale: number; readonly x: number; readonly y: number }): void => {
    viewportRef.current = next; setViewport(next);
  }, []);
  const finish = useCallback((restoreFocus: boolean): void => {
    if (scopeRef.current !== scope) return;
    if (restoreFocus && detail.returnFocus.isConnected && detail.returnFocus.ownerDocument === ownerDocument) detail.returnFocus.focus({ preventScroll: true });
    onCloseRef.current();
  }, [detail, ownerDocument, scope]);
  const close = useCallback((): void => {
    if (!current() || closingRef.current || ownerWindow == null) return;
    closingRef.current = true;
    copy.cancel();
    releasePointers();
    setDragging(false);
    setVisible(false);
    timers.current.close = ownerWindow.setTimeout(() => { if (current()) finish(true); }, ownerWindow.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200);
  }, [copy.cancel, current, finish, ownerWindow, releasePointers]);

  useLayoutEffect(() => {
    if (ownerWindow == null) return;
    scopeRef.current = scope;
    closingRef.current = false;
    annotatingRef.current = false;
    releasePointers();
    setAnnotating(false); setVisible(false); setWheeling(false); setDragging(false);
    applyViewport({ scale: 1, x: 0, y: 0 });
    const dialog = dialogRef.current;
    ownerDocument.body.classList.add("workspace-mermaid-lightbox-open");
    const releaseLock = dialog === null ? () => undefined : acquireModalLock(ownerDocument, dialog);
    const frame = ownerWindow.requestAnimationFrame(() => {
      if (!current()) return;
      setVisible(true); dialog?.focus({ preventScroll: true });
    });
    const retire = (): void => { if (scopeRef.current === scope) { copy.cancel(); releasePointers(); finish(false); scopeRef.current = undefined; } };
    const keydown = (event: KeyboardEvent): void => {
      if (!current() || closingRef.current || annotatingRef.current || event.defaultPrevented || event.isComposing || dialog === null || !modalOwnsKeyboardEvent(event, dialog)) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
      if (event.key !== "Tab" || dialog === null) return;
      const buttons = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')];
      const active = ownerDocument.activeElement;
      const index = buttons.indexOf(active as HTMLElement);
      if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === buttons.length - 1) {
        event.preventDefault(); (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
      }
    };
    ownerDocument.addEventListener("keydown", keydown, true);
    ownerWindow.addEventListener("pagehide", retire);
    detail.signal.addEventListener("abort", retire);
    if (detail.signal.aborted || !detail.isCurrent()) retire();
    return () => {
      if (scopeRef.current === scope) scopeRef.current = undefined;
      copy.cancel(); releasePointers();
      ownerWindow.cancelAnimationFrame(frame);
      if (timers.current.close !== undefined) ownerWindow.clearTimeout(timers.current.close);
      if (timers.current.wheel !== undefined) ownerWindow.clearTimeout(timers.current.wheel);
      timers.current = {};
      ownerDocument.removeEventListener("keydown", keydown, true);
      ownerWindow.removeEventListener("pagehide", retire);
      detail.signal.removeEventListener("abort", retire);
      const others = [...ownerDocument.querySelectorAll('[aria-modal="true"]')].filter((element) => element !== dialog);
      if (!others.some((element) => element.classList.contains("workspace-mermaid-lightbox"))) ownerDocument.body.classList.remove("workspace-mermaid-lightbox-open");
      releaseLock();
    };
  }, [scope, detail, ownerDocument, ownerWindow, applyViewport, current, close, copy.cancel, finish, releasePointers]);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null || ownerWindow == null) return;
    const onWheel = (event: WheelEvent): void => {
      if (!current() || closingRef.current || annotatingRef.current) return;
      event.preventDefault();
      const value = viewportRef.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = stage.getBoundingClientRect();
        applyViewport(mermaidZoomAt(value, { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 },
          value.scale * workspaceMermaidWheelZoomFactor(event.deltaY, event.deltaMode)));
      } else if (value.scale > 1 && (event.deltaX !== 0 || event.deltaY !== 0)) {
        applyViewport({ ...value, x: value.x - normalizeWorkspaceMermaidWheelDelta(event.deltaX, event.deltaMode), y: value.y - normalizeWorkspaceMermaidWheelDelta(event.deltaY, event.deltaMode) });
      } else return;
      setWheeling(true);
      if (timers.current.wheel !== undefined) ownerWindow.clearTimeout(timers.current.wheel);
      timers.current.wheel = ownerWindow.setTimeout(() => { if (current()) setWheeling(false); }, 120);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [applyViewport, current, ownerWindow]);
  const zoomBy = (factor: number): void => {
    if (!current() || closingRef.current) return;
    const value = viewportRef.current;
    applyViewport(mermaidZoomAt(value, { x: 0, y: 0 }, value.scale * factor));
  };
  const beginDrag = (pointerId: number, point: MermaidPointer): void => {
    const value = viewportRef.current;
    dragRef.current = { pointerId, startClientX: point.x, startClientY: point.y, startX: value.x, startY: value.y };
    setDragging(true);
  };
  const beginPinch = (): boolean => {
    const touches = [...pointersRef.current].filter(([, point]) => point.type === "touch");
    const first = touches[0];
    const second = touches[1];
    if (first === undefined || second === undefined) return false;
    pinchRef.current = {
      ids: [first[0], second[0]],
      distance: Math.max(1, Math.hypot(first[1].x - second[1].x, first[1].y - second[1].y)),
      center: { x: (first[1].x + second[1].x) / 2, y: (first[1].y + second[1].y) / 2 },
      viewport: viewportRef.current
    };
    dragRef.current = undefined;
    backdropTapRef.current = undefined;
    setDragging(true);
    return true;
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !current() || closingRef.current) return;
    event.preventDefault();
    const point: MermaidPointer = { x: event.clientX, y: event.clientY, type: event.pointerType };
    const pointers = pointersRef.current;
    if (pointers.size > 0) {
      const activePointers = [...pointers.values()];
      if (point.type !== "touch" || activePointers.some((active) => active.type !== "touch") || activePointers.length >= 2) return;
      backdropTapRef.current = undefined;
    } else {
      const card = cardRef.current?.getBoundingClientRect();
      const outsideCard = card === undefined || point.x < card.left || point.x > card.right || point.y < card.top || point.y > card.bottom;
      backdropTapRef.current = outsideCard ? { pointerId: event.pointerId, x: point.x, y: point.y } : undefined;
    }
    pointers.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!beginPinch()) beginDrag(event.pointerId, point);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!current() || closingRef.current) return;
    const previous = pointersRef.current.get(event.pointerId);
    if (previous === undefined) return;
    const point = { ...previous, x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, point);
    const backdropTap = backdropTapRef.current;
    if (backdropTap?.pointerId === event.pointerId && Math.hypot(point.x - backdropTap.x, point.y - backdropTap.y) > 3) backdropTapRef.current = undefined;
    const pinch = pinchRef.current;
    if (pinch !== undefined) {
      if (!pinch.ids.includes(event.pointerId)) return;
      const first = pointersRef.current.get(pinch.ids[0]);
      const second = pointersRef.current.get(pinch.ids[1]);
      const rect = stageRef.current?.getBoundingClientRect();
      if (first === undefined || second === undefined || rect === undefined) return;
      const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const scale = pinch.viewport.scale * Math.hypot(first.x - second.x, first.y - second.y) / pinch.distance;
      const next = mermaidZoomAt(pinch.viewport, {
        x: pinch.center.x - rect.left - rect.width / 2,
        y: pinch.center.y - rect.top - rect.height / 2
      }, scale);
      applyViewport({ ...next, x: next.x + center.x - pinch.center.x, y: next.y + center.y - pinch.center.y });
      return;
    }
    const drag = dragRef.current;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    applyViewport({ ...viewportRef.current, x: drag.startX + point.x - drag.startClientX, y: drag.startY + point.y - drag.startClientY });
  };
  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointersRef.current.delete(event.pointerId)) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const closeFromBackdrop = backdropTapRef.current?.pointerId === event.pointerId;
    if (closeFromBackdrop) backdropTapRef.current = undefined;
    if (pinchRef.current?.ids.includes(event.pointerId)) {
      pinchRef.current = undefined;
      if (beginPinch()) return;
      const remaining = [...pointersRef.current][0];
      if (remaining !== undefined) {
        beginDrag(remaining[0], remaining[1]);
        return;
      }
    }
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = undefined;
    if (pointersRef.current.size === 0) setDragging(false);
    if (closeFromBackdrop) close();
  };
  const cancelPointers = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointersRef.current.has(event.pointerId)) return;
    releasePointers();
    setDragging(false);
  };
  if (ownerWindow == null) return null;
  return createPortal(<div ref={dialogRef} className={`workspace-mermaid-lightbox${visible ? " is-visible" : ""}`} role="dialog" aria-modal={!annotating} aria-label={labels.close} tabIndex={-1}
    style={annotating ? { display: "none" } : undefined} aria-hidden={annotating}
  >
    <div ref={stageRef} className={`workspace-mermaid-lightbox__stage${dragging ? " is-dragging" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={cancelPointers}
      onLostPointerCapture={cancelPointers}
      onDoubleClick={() => {
        if (current() && !closingRef.current && pinchRef.current === undefined && pointersRef.current.size === 0) applyViewport({ scale: 1, x: 0, y: 0 });
      }}
    >
      <div ref={cardRef} className="workspace-mermaid-lightbox__card" style={{
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
        transition: dragging || wheeling ? "none" : "transform 80ms ease-out"
      }} />
    </div>
    <div className="workspace-mermaid-lightbox__toolbar">
      <IconButton label={labels.zoomOut} onClick={() => zoomBy(1 / 1.2)}><Minus /></IconButton>
      <span>{Math.round(viewport.scale * 100)}%</span>
      <IconButton label={labels.zoomIn} onClick={() => zoomBy(1.2)}><Plus /></IconButton>
      <i aria-hidden="true" />
      {onSendToChat !== undefined && <GeneratedImageAnnotationButton ownerKey={ownerKey} sourceKey={sourceKey} ownerDocument={ownerDocument}
        name="diagram.png" labels={annotationLabels} onSendToChat={onSendToChat}
        onPreviewOpen={() => { if (current()) { copy.cancel(); releasePointers(); setDragging(false); annotatingRef.current = true; setAnnotating(true); } }}
        onPreviewClose={() => finish(true)}
        buildImage={async (context) => {
          const card = cardRef.current;
          if (card === null || !current() || closingRef.current) throw new Error("Diagram is no longer available.");
          const png = await renderMermaidPng(detail.svg, card, context);
          if (!current() || closingRef.current) throw new Error("Diagram is no longer available.");
          return png;
        }}
      />}
      <IconButton label={copy.state === "copied" ? labels.copied : copy.state === "failed" ? labels.copyFailed : labels.copy}
        aria-busy={copy.pending} aria-disabled={copy.pending} onClick={(event) => {
          const card = cardRef.current;
          if (card === null || !current() || closingRef.current) return;
          copy.run(event.currentTarget.ownerDocument, (context) => copyMermaid(detail.svg, detail.source, card, context));
        }}
      >{copy.state === "copied" ? <Check /> : <Copy />}</IconButton>
      <IconButton label={labels.close} onClick={close}><X /></IconButton>
    </div>
    {copy.state === "failed" && <span className="sr-only" role="alert">{labels.copyFailed}</span>}
  </div>, ownerDocument.body);
}

export function mermaidZoomAt(
  viewport: { readonly scale: number; readonly x: number; readonly y: number },
  point: { readonly x: number; readonly y: number },
  scale: number
): { readonly scale: number; readonly x: number; readonly y: number } {
  const bounded = Math.min(8, Math.max(0.2, scale));
  const ratio = bounded / viewport.scale;
  return {
    scale: bounded,
    x: point.x - (point.x - viewport.x) * ratio,
    y: point.y - (point.y - viewport.y) * ratio
  };
}

/** Normalize WheelEvent line/page units to the pixel units used by the stage. */
export function normalizeWorkspaceMermaidWheelDelta(delta: number, deltaMode = 0): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 800;
  return delta;
}

/** Continuous focal-zoom curve after wheel-unit normalization. */
export function workspaceMermaidWheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const pixels = normalizeWorkspaceMermaidWheelDelta(deltaY, deltaMode);
  const clamped = Math.min(40, Math.max(-40, pixels));
  return Math.exp(-clamped * 0.01);
}
