import type { ArtifactDownloadContext } from "../model.js";
import { downloadArtifactBlob } from "../artifact-download.js";
import { ChevronLeft, ChevronRight, Copy, Download, Maximize2, MessageSquarePlus, Minimize2, Pen, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
  readonly ownerKey: string;
  readonly src: string;
  readonly name: string;
  readonly mediaType?: string;
  readonly labels: WorkspaceImageLightboxLabels;
  readonly status?: "ready" | "loading" | "error";
  readonly gallery?: WorkspaceImageLightboxGallery;
  readonly showZoomControls?: boolean;
  readonly startAnnotating?: boolean;
  readonly returnFocus?: HTMLElement | null;
  readonly onClose: () => void;
  readonly onDownload: (context: ArtifactDownloadContext) => unknown | Promise<unknown>;
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

interface ImagePointer {
  readonly x: number;
  readonly y: number;
  readonly type: string;
}

interface PinchState {
  readonly ids: readonly [number, number];
  readonly distance: number;
  readonly center: { readonly x: number; readonly y: number };
  readonly viewport: Viewport;
}

interface ImageAction {
  readonly scope: object;
  readonly request: AbortController;
  readonly strokes: readonly WorkspaceImageStroke[];
  assertCurrent(): void;
}

const INITIAL_VIEWPORT: Viewport = { scale: 1, x: 0, y: 0 };

/**
 * Full-screen image viewer for authenticated artifact URLs.
 * It deliberately never receives or exposes an absolute workspace path.
 */
export function WorkspaceImageLightbox({
  ownerKey,
  src,
  name,
  mediaType,
  labels,
  status = "ready",
  gallery,
  showZoomControls = false,
  startAnnotating = false,
  returnFocus,
  onClose,
  onDownload,
  onImageError,
  onSendToChat
}: WorkspaceImageLightboxProps): JSX.Element {
  const ownerDocument = returnFocus?.ownerDocument ?? document;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const scope = useMemo(() => ({ active: false }), [ownerKey, src, name, mediaType, status, ownerDocument, returnFocus]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const actionRef = useRef<ImageAction | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const restoreFocusRef = useRef<object | undefined>(undefined);
  const overlayRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const galleryRef = useRef(gallery);
  galleryRef.current = gallery;
  const sendEnabledRef = useRef(onSendToChat !== undefined);
  sendEnabledRef.current = onSendToChat !== undefined;
  const closingRef = useRef(false);
  const [visible, setVisible] = useState(false);
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const [drag, setDrag] = useState<DragState>();
  const dragRef = useRef<DragState | undefined>(undefined);
  const pointersRef = useRef(new Map<number, ImagePointer>());
  const pinchRef = useRef<PinchState | undefined>(undefined);
  const strokePointerRef = useRef<number | undefined>(undefined);
  const [pinching, setPinching] = useState(false);
  const dragMovedRef = useRef(false);
  const imageClickRef = useRef(false);
  const [annotating, setAnnotating] = useState(startAnnotating && onSendToChat !== undefined);
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

  const retireAction = useCallback((): void => {
    actionRef.current?.request.abort();
    actionRef.current = undefined;
  }, []);

  const releasePointers = useCallback((): void => {
    const surface = overlayRef.current;
    const ids = [...pointersRef.current.keys()];
    pointersRef.current.clear();
    pinchRef.current = undefined;
    dragRef.current = undefined;
    strokePointerRef.current = undefined;
    draftStrokeRef.current = undefined;
    for (const id of ids) if (surface?.hasPointerCapture(id)) surface.releasePointerCapture(id);
  }, []);

  const close = useCallback((): void => {
    const current = scopeRef.current;
    if (closingRef.current || !current.active) return;
    closingRef.current = true;
    retireAction();
    releasePointers();
    setVisible(false);
    closeTimerRef.current = ownerWindow.setTimeout(() => {
      if (!current.active || scopeRef.current !== current) return;
      restoreFocusRef.current = current;
      closeRef.current();
    }, ownerWindow.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true ? 0 : 160);
  }, [ownerWindow, releasePointers, retireAction]);

  useLayoutEffect(() => {
    scope.active = true;
    restoreFocusRef.current = undefined;
    setBusy(false);
    setFeedback(undefined);
    setWheeling(false);
    if (closingRef.current) setVisible(true);
    closingRef.current = false;
    const onPageHide = (): void => { retireAction(); setBusy(false); };
    ownerWindow.addEventListener("pagehide", onPageHide);
    return () => {
      ownerWindow.removeEventListener("pagehide", onPageHide);
      scope.active = false;
      if (actionRef.current?.scope === scope) retireAction();
      if (closeTimerRef.current !== undefined) ownerWindow.clearTimeout(closeTimerRef.current);
      if (wheelTimerRef.current !== undefined) ownerWindow.clearTimeout(wheelTimerRef.current);
    };
  }, [ownerWindow, retireAction, scope]);

  const discardAnnotation = useCallback((): void => {
    strokePointerRef.current = undefined;
    draftStrokeRef.current = undefined;
    setDraftStroke(undefined);
    setStrokes([]);
    setAnnotating(false);
  }, []);

  useLayoutEffect(() => {
    const body = ownerDocument.body;
    const ownedModalLock = !body.classList.contains("modal-open");
    body.classList.add("workspace-image-lightbox-open", "modal-open");
    const frame = ownerWindow.requestAnimationFrame(() => {
      if (closingRef.current) return;
      setVisible(true);
      overlayRef.current?.focus({ preventScroll: true });
    });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.defaultPrevented || closingRef.current) return;
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
    ownerDocument.addEventListener("keydown", onKeyDown, true);
    return () => {
      ownerWindow.cancelAnimationFrame(frame);
      ownerDocument.removeEventListener("keydown", onKeyDown, true);
      if (wheelTimerRef.current !== undefined) ownerWindow.clearTimeout(wheelTimerRef.current);
      body.classList.remove("workspace-image-lightbox-open");
      if (ownedModalLock && [...ownerDocument.querySelectorAll(".modal-layer, [role='dialog'][aria-modal='true']")].every((element) => element === overlayRef.current)) body.classList.remove("modal-open");
      if (restoreFocusRef.current === scopeRef.current && returnFocus?.isConnected === true) returnFocus.focus({ preventScroll: true });
    };
  }, [close, discardAnnotation, ownerDocument, ownerWindow, returnFocus]);

  useLayoutEffect(() => {
    viewportRef.current = INITIAL_VIEWPORT;
    setViewport(INITIAL_VIEWPORT);
    pointersRef.current.clear();
    pinchRef.current = undefined;
    setPinching(false);
    dragRef.current = undefined;
    strokePointerRef.current = undefined;
    draftStrokeRef.current = undefined;
    dragMovedRef.current = false;
    imageClickRef.current = false;
    setDrag(undefined);
    setAnnotating(startAnnotating && onSendToChat !== undefined);
    setStrokes([]);
    setDraftStroke(undefined);
    setNaturalSize(undefined);
    setMenu(undefined);
    setFeedback(undefined);
    return releasePointers;
  }, [ownerKey, ownerDocument, releasePointers, returnFocus, src, startAnnotating]);

  useLayoutEffect(() => {
    if (ready) return;
    releasePointers();
    setPinching(false);
    setDrag(undefined);
    setDraftStroke(undefined);
  }, [ready, releasePointers]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (annotatingRef.current || closingRef.current || !scopeRef.current.active) return;
      event.preventDefault();
      const rect = overlay.getBoundingClientRect();
      const point = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
      const factor = workspaceImageWheelZoomFactor(event.deltaY, event.deltaMode);
      setWheeling(true);
      if (wheelTimerRef.current !== undefined) ownerWindow.clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = ownerWindow.setTimeout(() => {
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
    draftStrokeRef.current = undefined;
    setDraftStroke(undefined);
  }, [ownerWindow]);

  const moveViewport = (next: Viewport): void => {
    const image = imageRef.current;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (image !== null && rect !== undefined && image.clientWidth > 0 && image.clientHeight > 0) {
      const maxX = Math.max(0, (image.clientWidth * next.scale - rect.width) / 2);
      const maxY = Math.max(0, (image.clientHeight * next.scale - rect.height) / 2);
      next = { ...next, x: Math.min(maxX, Math.max(-maxX, next.x)), y: Math.min(maxY, Math.max(-maxY, next.y)) };
    }
    viewportRef.current = next;
    setViewport(next);
  };

  const beginDrag = (pointerId: number, point: ImagePointer): void => {
    const current = viewportRef.current;
    const next = { pointerId, startClientX: point.x, startClientY: point.y, startX: current.x, startY: current.y };
    dragRef.current = next;
    setDrag(next);
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
    setPinching(true);
    strokePointerRef.current = undefined;
    draftStrokeRef.current = undefined;
    setDraftStroke(undefined);
    dragRef.current = undefined;
    setDrag(undefined);
    dragMovedRef.current = true;
    imageClickRef.current = false;
    return true;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    setMenu(undefined);
    if (!ready || closingRef.current) return;
    // A pen/mouse stroke owns its contact; incidental touch contacts do not replace it.
    const drawingPointer = strokePointerRef.current;
    if (drawingPointer !== undefined && pointersRef.current.get(drawingPointer)?.type !== "touch") return;
    const point = { x: event.clientX, y: event.clientY, type: event.pointerType };
    if (point.type !== "touch" && pointersRef.current.size > 0) return;
    pointersRef.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pinchRef.current !== undefined) return;
    if (beginPinch()) return;
    dragMovedRef.current = false;
    if (annotating) {
      const image = imageRef.current;
      if (image === null) return;
      const point = normalizeWorkspaceImagePoint(event.clientX, event.clientY, image.getBoundingClientRect());
      if (point === undefined) return;
      strokePointerRef.current = event.pointerId;
      draftStrokeRef.current = { points: [point] };
      setDraftStroke(draftStrokeRef.current);
      return;
    }
    if (viewportRef.current.scale > 1) beginDrag(event.pointerId, point);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pointer = pointersRef.current.get(event.pointerId);
    if (pointer === undefined) return;
    pointersRef.current.set(event.pointerId, { ...pointer, x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (pinch !== undefined) {
      if (!pinch.ids.includes(event.pointerId)) return;
      const first = pointersRef.current.get(pinch.ids[0]);
      const second = pointersRef.current.get(pinch.ids[1]);
      const rect = overlayRef.current?.getBoundingClientRect();
      if (first === undefined || second === undefined || rect === undefined) return;
      const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const scale = pinch.viewport.scale * Math.hypot(first.x - second.x, first.y - second.y) / pinch.distance;
      const next = zoomWorkspaceImageAtPoint(pinch.viewport, {
        x: pinch.center.x - rect.left - rect.width / 2,
        y: pinch.center.y - rect.top - rect.height / 2
      }, scale);
      moveViewport({ ...next, x: next.x + center.x - pinch.center.x, y: next.y + center.y - pinch.center.y });
      return;
    }
    if (annotating) {
      if (strokePointerRef.current !== event.pointerId) return;
      const current = draftStrokeRef.current;
      const image = imageRef.current;
      if (current === undefined || image === null) return;
      const point = normalizeWorkspaceImagePoint(event.clientX, event.clientY, image.getBoundingClientRect());
      if (point === undefined || !shouldAppendWorkspaceImagePoint(current, point)) return;
      draftStrokeRef.current = { points: [...current.points, point] };
      setDraftStroke(draftStrokeRef.current);
      return;
    }
    const currentDrag = dragRef.current;
    if (currentDrag === undefined || currentDrag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - currentDrag.startClientX;
    const deltaY = event.clientY - currentDrag.startClientY;
    if (Math.hypot(deltaX, deltaY) > 3) {
      dragMovedRef.current = true;
      imageClickRef.current = false;
    }
    moveViewport({ ...viewportRef.current, x: currentDrag.startX + deltaX, y: currentDrag.startY + deltaY });
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointersRef.current.delete(event.pointerId)) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (strokePointerRef.current === event.pointerId) {
      strokePointerRef.current = undefined;
      commitDraftStroke();
    }
    if (pinchRef.current?.ids.includes(event.pointerId)) {
      pinchRef.current = undefined;
      setPinching(false);
      if (beginPinch()) return;
      const remaining = [...pointersRef.current][0];
      if (!annotating && remaining !== undefined && viewportRef.current.scale > 1) {
        beginDrag(remaining[0], remaining[1]);
        return;
      }
    }
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = undefined;
      setDrag(undefined);
    }
  };

  const cancelPointers = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointersRef.current.has(event.pointerId)) return;
    releasePointers();
    setPinching(false);
    dragMovedRef.current = true;
    imageClickRef.current = false;
    setDraftStroke(undefined);
    setDrag(undefined);
  };

  const materialize = async (action: ImageAction, forcePng: boolean): Promise<{ readonly blob: Blob; readonly name: string }> => {
    action.assertCurrent();
    const signal = action.request.signal;
    const response = await abortable(ownerWindow.fetch(src, { signal, credentials: "omit", referrerPolicy: "no-referrer" }), signal);
    action.assertCurrent();
    if (!response.ok) throw new Error(`Image fetch failed (${response.status}).`);
    const source = await abortable(response.blob(), signal);
    action.assertCurrent();
    if (!forcePng && action.strokes.length === 0) return { blob: source, name };
    const image = ownerDocument.createElement("img");
    const imageUrl = ownerWindow.URL.createObjectURL(source);
    const canvas = ownerDocument.createElement("canvas");
    try {
      await loadImage(image, imageUrl, signal);
      action.assertCurrent();
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Canvas is unavailable.");
      context.drawImage(image, 0, 0);
      drawWorkspaceImageStrokes(context, action.strokes, canvas.width, canvas.height);
      const blob = await abortable(canvasBlob(canvas, "image/png"), signal);
      action.assertCurrent();
      return { blob, name: withPngExtension(name) };
    } finally {
      image.removeAttribute("src");
      ownerWindow.URL.revokeObjectURL(imageUrl);
      canvas.width = 0;
      canvas.height = 0;
    }
  };

  const run = (operation: (action: ImageAction) => Promise<void>, failedLabel: string): void => {
    if (!ready || !scope.active || scopeRef.current !== scope || closingRef.current || actionRef.current !== undefined) return;
    const request = new ownerWindow.AbortController();
    const current = (): boolean => scope.active && scopeRef.current === scope && actionRef.current === action && !closingRef.current && !request.signal.aborted;
    const action: ImageAction = {
      scope,
      request,
      strokes: strokesRef.current.map((stroke) => ({ points: stroke.points.map((point) => ({ ...point })) })),
      assertCurrent() {
        if (current()) return;
        request.abort();
        request.signal.throwIfAborted();
      }
    };
    actionRef.current = action;
    setBusy(true);
    setFeedback(undefined);
    void (async () => {
      try {
        await operation(action);
      } catch {
        if (current()) setFeedback(failedLabel);
      } finally {
        if (current()) {
          actionRef.current = undefined;
          setBusy(false);
        }
      }
    })();
  };

  const copy = (): void => run(async (action) => {
    if (ownerWindow.ClipboardItem === undefined || ownerWindow.navigator.clipboard?.write === undefined) throw new Error("Image clipboard is unavailable.");
    const { blob } = await materialize(action, true);
    action.assertCurrent();
    await ownerWindow.navigator.clipboard.write([new ownerWindow.ClipboardItem({ "image/png": blob })]);
    action.assertCurrent();
    setFeedback(labels.copied);
  }, labels.copyFailed);

  const save = (): void => {
    if (strokesRef.current.length === 0) {
      run(async (action) => { action.assertCurrent(); await onDownload({ ownerDocument, signal: action.request.signal }); }, labels.saveFailed);
      return;
    }
    run(async (action) => {
      const rendered = await materialize(action, true);
      action.assertCurrent();
      downloadArtifactBlob(rendered.blob, rendered.name, { ownerDocument, signal: action.request.signal });
    }, labels.saveFailed);
  };

  const send = (): void => {
    if (onSendToChat === undefined) return;
    run(async (action) => {
      const rendered = await materialize(action, action.strokes.length > 0);
      action.assertCurrent();
      if (!sendEnabledRef.current) throw new Error("Image attachments are unavailable.");
      const file = new ownerWindow.File([rendered.blob], rendered.name, { type: rendered.blob.type || mediaType || "image/png" });
      await onSendToChat(file);
      action.assertCurrent();
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
    onPointerMove={handlePointerMove}
    onPointerUp={handlePointerEnd}
    onPointerCancel={cancelPointers}
    onLostPointerCapture={cancelPointers}
    onPointerDownCapture={(event) => {
      if (!(event.target instanceof ownerWindow.Node) || !imageRef.current?.parentElement?.contains(event.target)) imageClickRef.current = false;
    }}
    onPointerDown={(event) => {
      if (event.target instanceof ownerWindow.Node && imageRef.current?.parentElement?.contains(event.target)) {
        if (pointersRef.current.size === 0) imageClickRef.current = true;
        handlePointerDown(event);
        return;
      }
      if (event.target === event.currentTarget && event.pointerType === "touch" && pointersRef.current.size > 0) {
        handlePointerDown(event);
        return;
      }
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
    onDoubleClick={(event) => {
      if (annotating || closingRef.current || !ready || !imageClickRef.current || pinchRef.current !== undefined) return;
      const fromImage = event.target instanceof ownerWindow.Node && imageRef.current?.parentElement?.contains(event.target);
      if (!fromImage && event.target !== event.currentTarget) return;
      const overlay = event.currentTarget.getBoundingClientRect();
      const point = { x: event.clientX - overlay.left - overlay.width / 2, y: event.clientY - overlay.top - overlay.height / 2 };
      event.preventDefault();
      event.stopPropagation();
      setViewport((current) => current.scale === 1 ? zoomWorkspaceImageAtPoint(current, point, 2) : INITIAL_VIEWPORT);
    }}
  >
    <div
      className={`workspace-image-lightbox__image-wrap${drag !== undefined || pinching ? " is-dragging" : ""}${wheeling ? " is-wheeling" : ""}${annotating ? " is-annotating" : ""}`}
      style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}
    >
      {ready && <img
        key={JSON.stringify([ownerKey, src])}
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
        onLoad={(event) => { if (scope.active && scopeRef.current === scope) setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); }}
        onError={() => { if (scope.active && scopeRef.current === scope) onImageError?.(); }}
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
      {hasSend && <LightboxMenuItem label={labels.annotate} disabled={busy || !ready} icon={<Pen />} onClick={() => { setAnnotating(true); setMenu(undefined); }} />}
      <LightboxMenuItem label={labels.copy} disabled={busy || !ready} icon={<Copy />} onClick={() => { setMenu(undefined); copy(); }} />
      <LightboxMenuItem label={labels.saveAs} disabled={busy || !ready} icon={<Download />} onClick={() => { setMenu(undefined); save(); }} />
      {hasSend && <LightboxMenuItem label={labels.sendToChat} disabled={busy || !ready} icon={<MessageSquarePlus />} onClick={() => { setMenu(undefined); send(); }} />}
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
  </div>, ownerDocument.body);
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

function LightboxMenuItem({ label, icon, onClick, disabled }: {
  readonly label: string;
  readonly icon: JSX.Element;
  readonly onClick: () => void;
  readonly disabled: boolean;
}): JSX.Element {
  return <button type="button" role="menuitem" disabled={disabled} onClick={onClick}>{icon}<span>{label}</span></button>;
}

async function loadImage(image: HTMLImageElement, src: string, signal: AbortSignal): Promise<void> {
  if (image.decode !== undefined) {
    image.src = src;
    await abortable(image.decode(), signal);
    return;
  }
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Image decode failed."));
  });
  image.src = src;
  try {
    await abortable(loaded, signal);
  } finally {
    image.onload = null;
    image.onerror = null;
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
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
