import { ChevronLeft, ChevronRight, Copy, Download, Maximize2, MessageSquarePlus, Minimize2, Pen, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./ui.js";

import {
  WORKSPACE_IMAGE_ANNOTATION_COLOR,
  WORKSPACE_IMAGE_ANNOTATION_OUTLINE,
  clampWorkspaceImageScale,
  drawWorkspaceImageStrokes,
  normalizeWorkspaceImagePoint,
  shouldAppendWorkspaceImagePoint,
  workspaceImageStrokePath,
  workspaceImageStrokeWidth,
  workspaceImageWheelZoomFactor,
  zoomWorkspaceImageAtPoint,
  type WorkspaceImageStroke
} from "./workspace-image-annotations.js";
import "./workspace-image-lightbox.css";

export interface WorkspaceImageLightboxLabels {
  readonly close: string;
  readonly copy: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly saveAs: string;
  readonly saveFailed: string;
  readonly annotate: string;
  readonly discardAnnotation: string;
  readonly undoAnnotation: string;
  readonly sendToChat: string;
  readonly sendFailed: string;
  readonly previousImage?: string;
  readonly nextImage?: string;
  readonly zoomIn?: string;
  readonly zoomOut?: string;
  readonly fitImage?: string;
  readonly actualSize?: string;
  readonly loading?: string;
  readonly unavailable?: string;
}

export interface WorkspaceImageLightboxGallery {
  readonly index: number;
  readonly total: number;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}

export interface WorkspaceImageLightboxProps {
  readonly src: string;
  readonly name: string;
  readonly mediaType?: string;
  readonly labels: WorkspaceImageLightboxLabels;
  readonly status?: "ready" | "loading" | "error";
  readonly gallery?: WorkspaceImageLightboxGallery;
  readonly showZoomControls?: boolean;
  readonly returnFocus?: HTMLElement | null;
  readonly onClose: () => void;
  readonly onDownload: () => void | Promise<void>;
  readonly onImageError?: () => void;
  /** Present only when the current task and backend can accept image attachments. */
  readonly onSendToChat?: (file: File) => void | Promise<void>;
}

interface Viewport {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

interface DragState {
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startX: number;
  readonly startY: number;
}

const INITIAL_VIEWPORT: Viewport = { scale: 1, x: 0, y: 0 };

/**
 * Full-screen image viewer for authenticated artifact URLs.
 * It deliberately never receives or exposes an absolute workspace path.
 */
export function WorkspaceImageLightbox({
  src,
  name,
  mediaType,
  labels,
  status = "ready",
  gallery,
  showZoomControls = false,
  returnFocus,
  onClose,
  onDownload,
  onImageError,
  onSendToChat
}: WorkspaceImageLightboxProps): JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const galleryRef = useRef(gallery);
  galleryRef.current = gallery;
  const closingRef = useRef(false);
  const [visible, setVisible] = useState(false);
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const [drag, setDrag] = useState<DragState>();
  const dragMovedRef = useRef(false);
  const [annotating, setAnnotating] = useState(false);
  const annotatingRef = useRef(annotating);
  annotatingRef.current = annotating;
  const [strokes, setStrokes] = useState<readonly WorkspaceImageStroke[]>([]);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const [draftStroke, setDraftStroke] = useState<WorkspaceImageStroke>();
  const draftStrokeRef = useRef(draftStroke);
  draftStrokeRef.current = draftStroke;
  const [naturalSize, setNaturalSize] = useState<{ readonly width: number; readonly height: number }>();
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number }>();
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const [feedback, setFeedback] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [wheeling, setWheeling] = useState(false);
  const wheelTimerRef = useRef<number | undefined>(undefined);
  const ready = status === "ready" && src !== "";

  const close = useCallback((): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    setVisible(false);
    window.setTimeout(() => closeRef.current(), 160);
  }, []);

  const discardAnnotation = useCallback((): void => {
    setDraftStroke(undefined);
    setStrokes([]);
    setAnnotating(false);
  }, []);

  useEffect(() => {
    const body = document.body;
    const ownedModalLock = !body.classList.contains("modal-open");
    body.classList.add("workspace-image-lightbox-open", "modal-open");
    const frame = window.requestAnimationFrame(() => {
      setVisible(true);
      overlayRef.current?.focus({ preventScroll: true });
    });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if (annotatingRef.current
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !event.altKey
        && event.key.toLocaleLowerCase() === "z") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setStrokes((current) => current.slice(0, -1));
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "Tab") {
        const overlay = overlayRef.current;
        if (overlay === null) return;
        const focusable = [...overlay.querySelectorAll<HTMLElement>(
          "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"
        )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
        if (focusable.length === 0) {
          event.preventDefault();
          overlay.focus({ preventScroll: true });
          return;
        }
        const active = overlay.ownerDocument.activeElement;
        const index = focusable.indexOf(active as HTMLElement);
        if (index < 0 || (!event.shiftKey && index === focusable.length - 1) || (event.shiftKey && index === 0)) {
          event.preventDefault();
          (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (menuRef.current !== undefined) setMenu(undefined);
        else if (annotatingRef.current) discardAnnotation();
        else close();
        return;
      }
      if (annotatingRef.current) return;
      const currentGallery = galleryRef.current;
      if (currentGallery !== undefined && currentGallery.total > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === "ArrowLeft") currentGallery.onPrevious();
        else currentGallery.onNext();
        return;
      }
      if (event.key !== "+" && event.key !== "=" && event.key !== "-" && event.key !== "_" && event.key !== "0") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setViewport((current) => {
        if (event.key === "0") return INITIAL_VIEWPORT;
        const factor = event.key === "+" || event.key === "=" ? 1.2 : 1 / 1.2;
        return zoomWorkspaceImageAtPoint(current, { x: 0, y: 0 }, current.scale * factor);
      });
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      if (wheelTimerRef.current !== undefined) window.clearTimeout(wheelTimerRef.current);
      body.classList.remove("workspace-image-lightbox-open");
      if (ownedModalLock && document.querySelector(".modal-layer, .image-lightbox") === null) body.classList.remove("modal-open");
      if (returnFocus?.isConnected === true) returnFocus.focus({ preventScroll: true });
    };
  }, [close, discardAnnotation, returnFocus]);

  useEffect(() => {
    setViewport(INITIAL_VIEWPORT);
    setDrag(undefined);
    setAnnotating(false);
    setStrokes([]);
    setDraftStroke(undefined);
    setNaturalSize(undefined);
    setMenu(undefined);
    setFeedback(undefined);
  }, [src]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (annotatingRef.current) return;
      event.preventDefault();
      const rect = overlay.getBoundingClientRect();
      const point = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
      const factor = workspaceImageWheelZoomFactor(event.deltaY, event.deltaMode);
      setWheeling(true);
      if (wheelTimerRef.current !== undefined) window.clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = window.setTimeout(() => {
        wheelTimerRef.current = undefined;
        setWheeling(false);
      }, 120);
      setViewport((current) => zoomWorkspaceImageAtPoint(current, point, current.scale * factor));
    };
    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => overlay.removeEventListener("wheel", onWheel);
  }, []);

  const commitDraftStroke = useCallback((): void => {
    const draft = draftStrokeRef.current;
    if (draft !== undefined && draft.points.length > 0) setStrokes((current) => [...current, draft]);
    setDraftStroke(undefined);
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    setMenu(undefined);
    if (!ready) return;
    if (annotating) {
      const image = imageRef.current;
      if (image === null) return;
      const point = normalizeWorkspaceImagePoint(event.clientX, event.clientY, image.getBoundingClientRect());
      if (point === undefined) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDraftStroke({ points: [point] });
      return;
    }
    if (viewport.scale <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragMovedRef.current = false;
    setDrag({
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: viewport.x,
      startY: viewport.y
    });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (annotating) {
      const current = draftStrokeRef.current;
      const image = imageRef.current;
      if (current === undefined || image === null) return;
      const point = normalizeWorkspaceImagePoint(event.clientX, event.clientY, image.getBoundingClientRect());
      if (point === undefined || !shouldAppendWorkspaceImagePoint(current, point)) return;
      setDraftStroke({ points: [...current.points, point] });
      return;
    }
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (Math.hypot(deltaX, deltaY) > 3) dragMovedRef.current = true;
    setViewport((current) => ({ ...current, x: drag.startX + deltaX, y: drag.startY + deltaY }));
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (annotating) commitDraftStroke();
    setDrag(undefined);
  };

  const materialize = useCallback(async (forcePng: boolean): Promise<{ readonly blob: Blob; readonly name: string }> => {
    if (!ready) throw new Error("Image is unavailable.");
    const response = await fetch(src);
    if (!response.ok) throw new Error(`Image fetch failed (${response.status}).`);
    const source = await response.blob();
    const currentStrokes = strokesRef.current;
    if (!forcePng && currentStrokes.length === 0) return { blob: source, name };
    const image = await loadImage(src);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable.");
    context.drawImage(image, 0, 0);
    drawWorkspaceImageStrokes(context, currentStrokes, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas, "image/png");
    return { blob, name: withPngExtension(name) };
  }, [name, ready, src]);

  const run = (operation: () => Promise<void>, failedLabel: string): void => {
    if (busy) return;
    setBusy(true);
    setFeedback(undefined);
    void operation().catch(() => setFeedback(failedLabel)).finally(() => setBusy(false));
  };

  const copy = (): void => run(async () => {
    const { blob } = await materialize(true);
    if (typeof ClipboardItem === "undefined" || navigator.clipboard?.write === undefined) throw new Error("Image clipboard is unavailable.");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setFeedback(labels.copied);
  }, labels.copyFailed);

  const save = (): void => {
    if (strokesRef.current.length === 0) {
      run(async () => { await onDownload(); }, labels.saveFailed);
      return;
    }
    run(async () => {
      const rendered = await materialize(true);
      downloadBlob(rendered.blob, rendered.name);
    }, labels.saveFailed);
  };

  const send = (): void => {
    if (onSendToChat === undefined) return;
    run(async () => {
      const rendered = await materialize(strokesRef.current.length > 0);
      const file = new File([rendered.blob], rendered.name, { type: rendered.blob.type || mediaType || "image/png" });
      await onSendToChat(file);
      close();
    }, labels.sendFailed);
  };

  const allStrokes = draftStroke === undefined ? strokes : [...strokes, draftStroke];
  const strokeWidth = naturalSize === undefined ? 4 : workspaceImageStrokeWidth(naturalSize.width, naturalSize.height);
  const hasSend = onSendToChat !== undefined;
  const zoomOut = (): void => setViewport((current) => zoomWorkspaceImageAtPoint(current, { x: 0, y: 0 }, current.scale / 1.2));
  const zoomIn = (): void => setViewport((current) => zoomWorkspaceImageAtPoint(current, { x: 0, y: 0 }, current.scale * 1.2));
  const showActualSize = (): void => {
    const image = imageRef.current;
    if (image === null || naturalSize === undefined || image.clientWidth <= 0 || image.clientHeight <= 0) return;
    const scale = Math.max(1, naturalSize.width / image.clientWidth, naturalSize.height / image.clientHeight);
    setViewport(zoomWorkspaceImageAtPoint(INITIAL_VIEWPORT, { x: 0, y: 0 }, scale));
  };

  return createPortal(<div
    ref={overlayRef}
    className={`workspace-image-lightbox${visible ? " is-visible" : ""}`}
    role="dialog"
    aria-modal="true"
    aria-label={name}
    tabIndex={-1}
    onPointerDown={(event) => {
      if (event.target !== event.currentTarget || annotating) return;
      if (menu !== undefined) {
        event.preventDefault();
        setMenu(undefined);
        return;
      }
      if (dragMovedRef.current) {
        dragMovedRef.current = false;
        return;
      }
      close();
    }}
  >
    <div
      className={`workspace-image-lightbox__image-wrap${drag !== undefined ? " is-dragging" : ""}${wheeling ? " is-wheeling" : ""}${annotating ? " is-annotating" : ""}`}
      style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onDoubleClick={(event) => {
        if (annotating) return;
        const overlay = overlayRef.current?.getBoundingClientRect();
        if (overlay === undefined) return;
        const point = { x: event.clientX - overlay.left - overlay.width / 2, y: event.clientY - overlay.top - overlay.height / 2 };
        setViewport((current) => current.scale === 1
          ? zoomWorkspaceImageAtPoint(current, point, 2)
          : INITIAL_VIEWPORT);
      }}
    >
      {ready && <img
        ref={imageRef}
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        draggable={false}
        onContextMenu={(event) => {
          if (annotating) return;
          event.preventDefault();
          event.stopPropagation();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        onLoad={(event) => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={onImageError}
      />}
      {naturalSize !== undefined && allStrokes.length > 0 && <svg
        viewBox={`0 0 ${naturalSize.width} ${naturalSize.height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {allStrokes.map((stroke, index) => {
          const path = workspaceImageStrokePath(stroke, naturalSize.width, naturalSize.height);
          return path === "" ? null : <g key={index}>
            <path d={path} fill="none" stroke={WORKSPACE_IMAGE_ANNOTATION_OUTLINE} strokeWidth={Math.round(strokeWidth * 1.8)} strokeLinecap="round" strokeLinejoin="round" />
            <path d={path} fill="none" stroke={WORKSPACE_IMAGE_ANNOTATION_COLOR} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
          </g>;
        })}
      </svg>}
    </div>

    {!ready && <div className={`workspace-image-lightbox__status${status === "error" ? " is-error" : ""}`} role={status === "error" ? "alert" : "status"}>
      <span>{status === "error" ? labels.unavailable : labels.loading}</span>
    </div>}

    {gallery !== undefined && gallery.total > 1 && <>
      <div className="workspace-image-lightbox__counter" aria-live="polite">{gallery.index + 1} / {gallery.total}</div>
      <LightboxButton className="workspace-image-lightbox__nav workspace-image-lightbox__nav--previous" label={labels.previousImage ?? ""} onClick={gallery.onPrevious}><ChevronLeft /></LightboxButton>
      <LightboxButton className="workspace-image-lightbox__nav workspace-image-lightbox__nav--next" label={labels.nextImage ?? ""} onClick={gallery.onNext}><ChevronRight /></LightboxButton>
    </>}

    {menu !== undefined && <div className="workspace-image-lightbox__menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
      {hasSend && <LightboxMenuItem label={labels.annotate} icon={<Pen />} onClick={() => { setAnnotating(true); setMenu(undefined); }} />}
      <LightboxMenuItem label={labels.copy} icon={<Copy />} onClick={() => { setMenu(undefined); copy(); }} />
      <LightboxMenuItem label={labels.saveAs} icon={<Download />} onClick={() => { setMenu(undefined); save(); }} />
      {hasSend && <LightboxMenuItem label={labels.sendToChat} icon={<MessageSquarePlus />} onClick={() => { setMenu(undefined); send(); }} />}
    </div>}

    <div className="workspace-image-lightbox__toolbar" onPointerDown={(event) => event.stopPropagation()}>
      {annotating ? <>
        <LightboxButton label={labels.discardAnnotation} disabled={busy} onClick={discardAnnotation}><X /></LightboxButton>
        <LightboxButton label={labels.undoAnnotation} disabled={busy || strokes.length === 0} onClick={() => setStrokes((current) => current.slice(0, -1))}><Undo2 /></LightboxButton>
        <span aria-hidden="true" />
        <LightboxButton label={labels.sendToChat} disabled={busy} onClick={send}><MessageSquarePlus /></LightboxButton>
      </> : <>
        {showZoomControls && <>
          <LightboxButton label={labels.zoomOut ?? ""} disabled={busy || !ready || viewport.scale <= 1} onClick={zoomOut}><ZoomOut /></LightboxButton>
          <output className="workspace-image-lightbox__scale" aria-live="polite">{Math.round(viewport.scale * 100)}%</output>
          <LightboxButton label={labels.fitImage ?? ""} disabled={busy || !ready} onClick={() => setViewport(INITIAL_VIEWPORT)}><Minimize2 /></LightboxButton>
          <LightboxButton label={labels.actualSize ?? ""} disabled={busy || !ready || naturalSize === undefined} onClick={showActualSize}><Maximize2 /></LightboxButton>
          <LightboxButton label={labels.zoomIn ?? ""} disabled={busy || !ready || viewport.scale >= clampWorkspaceImageScale(Number.POSITIVE_INFINITY)} onClick={zoomIn}><ZoomIn /></LightboxButton>
          <span aria-hidden="true" />
        </>}
        <LightboxButton label={labels.copy} disabled={busy || !ready} onClick={copy}><Copy /></LightboxButton>
        <LightboxButton label={labels.saveAs} disabled={busy || !ready} onClick={save}><Download /></LightboxButton>
        {hasSend && <><span aria-hidden="true" /><LightboxButton label={labels.annotate} disabled={busy || !ready} onClick={() => setAnnotating(true)}><Pen /></LightboxButton><LightboxButton label={labels.sendToChat} disabled={busy || !ready} onClick={send}><MessageSquarePlus /></LightboxButton></>}
      </>}
    </div>
    <button className="workspace-image-lightbox__a11y-close" type="button" onClick={close}>{labels.close}</button>
    {feedback !== undefined && <div className="workspace-image-lightbox__feedback" role="status">{feedback}</div>}
  </div>, document.body);
}

function LightboxButton({ className, label, disabled, onClick, children }: {
  readonly className?: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: JSX.Element;
}): JSX.Element {
  return <IconButton className={className} label={label} disabled={disabled} disabledReason={disabled ? label : undefined} onClick={onClick}>{children}</IconButton>;
}

function LightboxMenuItem({ label, icon, onClick }: {
  readonly label: string;
  readonly icon: JSX.Element;
  readonly onClick: () => void;
}): JSX.Element {
  return <button type="button" role="menuitem" onClick={onClick}>{icon}<span>{label}</span></button>;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  if (image.decode !== undefined) await image.decode();
  else await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Image decode failed."));
  });
  return image;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob === null) reject(new Error("Image encoding failed."));
    else resolve(blob);
  }, type));
}

function withPngExtension(name: string): string {
  return `${name.replace(/\.[^.]+$/, "") || "image"}.png`;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
