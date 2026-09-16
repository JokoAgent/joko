import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX, KeyboardEventHandler, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

import { cx } from "./ui.js";

const FOCUSABLE = "[data-morph-autofocus]:not([disabled]), input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [role='option'], [role='menuitem'], [tabindex]:not([tabindex='-1'])";
const MORPH_DURATION_MS = 220;
const MORPH_EASING = "cubic-bezier(.3, .9, .25, 1)";
const SIDE_GAP = 6;
const VIEWPORT_PADDING = 8;
const PANEL_RADIUS = 12;

interface MorphAppearance {
  readonly backgroundColor: string;
  readonly borderColor: string;
}

export const MORPH_CONTENT_RESIZE_EVENT = "joko:morph-content-resize";
export const MORPH_POPOVER_DURATION_MS = MORPH_DURATION_MS;

export function MorphPopover({
  open,
  onOpenChange,
  label,
  trigger,
  children,
  panelWidth = 360,
  side = "top",
  align = "start",
  className,
  panelClassName,
  initialFocus,
  panelElementRef,
  additionalOwnedElementRef,
  onPanelKeyDown
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly label: string;
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  readonly panelWidth?: number;
  readonly side?: "top" | "bottom";
  readonly align?: "start" | "end";
  readonly className?: string;
  readonly panelClassName?: string;
  readonly initialFocus?: () => HTMLElement | null;
  readonly panelElementRef?: RefObject<HTMLDivElement | null>;
  readonly additionalOwnedElementRef?: RefObject<HTMLElement | null>;
  readonly onPanelKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}): JSX.Element {
  const [mounted, setMounted] = useState(false);
  const [ownerDocument, setOwnerDocument] = useState<Document | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const ownerWindowRef = useRef<Window | null>(null);
  const triggerRectRef = useRef<DOMRect | undefined>(undefined);
  const panelAppearanceRef = useRef<MorphAppearance>({ backgroundColor: "", borderColor: "" });
  const settledRef = useRef(false);
  const pointerInteractionRef = useRef(false);
  const openFrameOneRef = useRef<number | undefined>(undefined);
  const openFrameTwoRef = useRef<number | undefined>(undefined);
  const phaseTimerRef = useRef<number | undefined>(undefined);
  const focusSnapshotTimerRef = useRef<number | undefined>(undefined);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;
  const panelElementRefRef = useRef(panelElementRef);
  panelElementRefRef.current = panelElementRef;
  const additionalOwnedElementRefRef = useRef(additionalOwnedElementRef);
  additionalOwnedElementRefRef.current = additionalOwnedElementRef;
  const portalTarget = ownerDocument?.defaultView === null ? null : ownerDocument?.body ?? null;

  if (open && !mounted) setMounted(true);

  const clearOpenFrames = useCallback((): void => {
    const ownerWindow = ownerWindowRef.current;
    if (ownerWindow !== null && openFrameOneRef.current !== undefined) ownerWindow.cancelAnimationFrame(openFrameOneRef.current);
    if (ownerWindow !== null && openFrameTwoRef.current !== undefined) ownerWindow.cancelAnimationFrame(openFrameTwoRef.current);
    openFrameOneRef.current = undefined;
    openFrameTwoRef.current = undefined;
  }, []);
  const clearTimers = useCallback((): void => {
    const ownerWindow = ownerWindowRef.current;
    if (ownerWindow !== null && phaseTimerRef.current !== undefined) ownerWindow.clearTimeout(phaseTimerRef.current);
    if (ownerWindow !== null && focusSnapshotTimerRef.current !== undefined) ownerWindow.clearTimeout(focusSnapshotTimerRef.current);
    phaseTimerRef.current = undefined;
    focusSnapshotTimerRef.current = undefined;
  }, []);
  const requestClose = useCallback((): void => onOpenChangeRef.current(false), []);
  const setPanelElement = useCallback((element: HTMLDivElement | null): void => {
    panelRef.current = element;
    const externalRef = panelElementRefRef.current;
    if (externalRef !== undefined) externalRef.current = element;
  }, []);
  const setRootElement = useCallback((element: HTMLDivElement | null): void => {
    rootRef.current = element;
    if (element === null) return;
    const nextDocument = element.ownerDocument;
    ownerWindowRef.current = nextDocument.defaultView;
    setOwnerDocument((current) => current === nextDocument ? current : nextDocument);
  }, []);

  const measure = useCallback((panel: HTMLDivElement, triggerRect: DOMRect, ownerWindow: Window): { readonly width: number; readonly height: number } => {
    const previousTransition = panel.style.transition;
    const previousWidth = panel.style.width;
    const previousHeight = panel.style.height;
    panel.style.transition = "none";
    panel.style.width = "max-content";
    panel.style.height = "auto";
    const viewportWidth = Math.max(0, ownerWindow.innerWidth - VIEWPORT_PADDING * 2);
    const width = Math.min(
      Math.max(panelWidth, triggerRect.width),
      viewportWidth
    );
    panel.style.width = `${width}px`;
    const availableHeight = side === "top"
      ? triggerRect.top - SIDE_GAP - VIEWPORT_PADDING
      : ownerWindow.innerHeight - triggerRect.bottom - SIDE_GAP - VIEWPORT_PADDING;
    const naturalHeight = Math.max(panel.offsetHeight, contentRef.current?.scrollHeight ?? 0, triggerRect.height);
    const height = Math.max(0, Math.min(naturalHeight, Math.max(0, availableHeight), 520));
    panel.style.transition = previousTransition;
    panel.style.width = previousWidth;
    panel.style.height = previousHeight;
    return { width, height };
  }, [panelWidth, side]);

  const applyTriggerGeometry = useCallback((panel: HTMLDivElement, rect: DOMRect, ownerWindow: Window, root?: HTMLDivElement): void => {
    panel.style.left = align === "start" ? `${rect.left}px` : "auto";
    panel.style.right = align === "end" ? `${ownerWindow.innerWidth - rect.right}px` : "auto";
    panel.style.top = side === "bottom" ? `${rect.top}px` : "auto";
    panel.style.bottom = side === "top" ? `${ownerWindow.innerHeight - rect.bottom}px` : "auto";
    panel.style.width = `${rect.width}px`;
    panel.style.height = `${rect.height}px`;
    panel.style.borderRadius = `${rect.height / 2}px`;
    panel.style.boxShadow = "0 0 0 rgb(0 0 0 / 0)";
    const triggerElement = root?.querySelector<HTMLElement>("button, summary, [role='button'], [tabindex]") ?? root;
    if (triggerElement !== undefined) {
      const triggerStyle = ownerWindow.getComputedStyle(triggerElement);
      panel.style.backgroundColor = triggerStyle.backgroundColor;
      panel.style.borderColor = triggerStyle.borderColor;
    }
  }, [align, side]);

  const applyDockedGeometry = useCallback((panel: HTMLDivElement, rect: DOMRect, size: { readonly width: number; readonly height: number }, ownerWindow: Window): void => {
    const desiredLeft = align === "end" ? rect.right - size.width : rect.left;
    const maximumLeft = Math.max(VIEWPORT_PADDING, ownerWindow.innerWidth - VIEWPORT_PADDING - size.width);
    const left = Math.min(Math.max(desiredLeft, VIEWPORT_PADDING), maximumLeft);
    if (align === "end") {
      panel.style.left = "auto";
      panel.style.right = `${Math.max(VIEWPORT_PADDING, ownerWindow.innerWidth - left - size.width)}px`;
    } else {
      panel.style.left = `${left}px`;
      panel.style.right = "auto";
    }
    panel.style.width = `${size.width}px`;
    panel.style.height = `${size.height}px`;
    if (side === "top") panel.style.bottom = `${ownerWindow.innerHeight - rect.top + SIDE_GAP}px`;
    else panel.style.top = `${rect.bottom + SIDE_GAP}px`;
    panel.style.borderRadius = `${PANEL_RADIUS}px`;
    panel.style.boxShadow = "var(--shadow-lg)";
    panel.style.backgroundColor = panelAppearanceRef.current.backgroundColor;
    panel.style.borderColor = panelAppearanceRef.current.borderColor;
    panel.style.opacity = "1";
  }, [align, side]);

  const syncPanelToContent = useCallback((): void => {
    const panel = panelRef.current;
    const rect = triggerRectRef.current;
    if (panel === null || rect === undefined) return;
    const ownerWindow = panel.ownerDocument.defaultView;
    if (ownerWindow === null) return;
    const size = measure(panel, rect, ownerWindow);
    const currentWidth = panel.offsetWidth;
    const currentHeight = panel.offsetHeight;
    if (Math.abs(size.width - currentWidth) <= 1 && Math.abs(size.height - currentHeight) <= 1) return;
    applyDockedGeometry(panel, rect, size, ownerWindow);
  }, [applyDockedGeometry, measure]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const root = rootRef.current;
    if (!mounted || panel === null || root === null) return;
    const currentDocument = root.ownerDocument;
    const ownerWindow = currentDocument.defaultView;
    if (ownerWindow === null || panel.ownerDocument !== currentDocument) return;
    ownerWindowRef.current = ownerWindow;
    clearOpenFrames();
    clearTimers();
    const reducedMotion = prefersReducedMotion(ownerWindow);

    if (open) {
      pointerInteractionRef.current = false;
      settledRef.current = false;
      panel.inert = false;
      panel.style.pointerEvents = "";
      const rect = root.getBoundingClientRect();
      triggerRectRef.current = rect;
      panel.style.backgroundColor = "";
      panel.style.borderColor = "";
      const panelStyle = ownerWindow.getComputedStyle(panel);
      panelAppearanceRef.current = {
        backgroundColor: panelStyle.backgroundColor,
        borderColor: panelStyle.borderColor
      };
      panel.style.transition = "none";
      applyTriggerGeometry(panel, rect, ownerWindow, root);
      panel.style.opacity = "0";
      panel.dataset.state = "closed";
      setContentOverflow(contentRef.current, "hidden");
      const size = measure(panel, rect, ownerWindow);
      void panel.offsetHeight;
      panel.style.transition = reducedMotion ? "none" : morphTransition();
      const finishOpen = (): void => {
        panel.dataset.state = "open";
        applyDockedGeometry(panel, rect, size, ownerWindow);
        const focusDelay = reducedMotion ? 0 : MORPH_DURATION_MS;
        phaseTimerRef.current = ownerWindow.setTimeout(() => {
          phaseTimerRef.current = undefined;
          settledRef.current = true;
          setContentOverflow(contentRef.current, "auto");
          syncPanelToContent();
          const target = initialFocusRef.current?.()
            ?? panel.querySelector<HTMLElement>(FOCUSABLE)
            ?? panel;
          target.focus({ preventScroll: true });
        }, focusDelay);
      };
      if (reducedMotion) finishOpen();
      else {
        openFrameOneRef.current = ownerWindow.requestAnimationFrame(() => {
          openFrameOneRef.current = undefined;
          openFrameTwoRef.current = ownerWindow.requestAnimationFrame(() => {
            openFrameTwoRef.current = undefined;
            if (panelRef.current === panel) finishOpen();
          });
        });
      }
      return;
    }

    settledRef.current = false;
    const liveRect = root.getBoundingClientRect();
    const rect = liveRect.width > 0 ? liveRect : triggerRectRef.current;
    const reducedClose = reducedMotion || rect === undefined;
    panel.dataset.state = "closed";
    panel.style.pointerEvents = "none";
    setContentOverflow(contentRef.current, "hidden");
    panel.style.transition = reducedClose ? "none" : morphTransition();
    if (rect !== undefined) {
      triggerRectRef.current = rect;
      applyTriggerGeometry(panel, rect, ownerWindow, root);
    }
    panel.style.opacity = "0";

    let ownedFocusAtClose = false;
    focusSnapshotTimerRef.current = ownerWindow.setTimeout(() => {
      focusSnapshotTimerRef.current = undefined;
      const active = currentDocument.activeElement;
      ownedFocusAtClose = !pointerInteractionRef.current && active !== null
        && (panel.contains(active) || root.contains(active) || additionalOwnedElementRefRef.current?.current?.contains(active) === true);
      panel.inert = true;
    }, 0);
    phaseTimerRef.current = ownerWindow.setTimeout(() => {
      phaseTimerRef.current = undefined;
      setMounted(false);
      if (!ownedFocusAtClose) return;
      const active = currentDocument.activeElement;
      const focusClaimedElsewhere = active !== null
        && active !== currentDocument.body
        && !panel.contains(active)
        && !root.contains(active)
        && additionalOwnedElementRefRef.current?.current?.contains(active) !== true;
      if (!focusClaimedElsewhere) root.querySelector<HTMLElement>("button, [tabindex]")?.focus({ preventScroll: true });
    }, reducedClose ? 0 : MORPH_DURATION_MS + 20);
  }, [applyDockedGeometry, applyTriggerGeometry, clearOpenFrames, clearTimers, measure, mounted, open, ownerDocument, syncPanelToContent]);

  useEffect(() => {
    const panel = panelRef.current;
    const content = contentRef.current;
    const ownerWindow = panel?.ownerDocument.defaultView;
    const ResizeObserverConstructor = ownerWindow?.ResizeObserver;
    if (!mounted || !open || panel === null || content === null || ownerWindow === null || ownerWindow === undefined
      || ResizeObserverConstructor === undefined) return;
    let frame: number | undefined;
    const requestSync = (): void => {
      if (frame !== undefined) return;
      frame = ownerWindow.requestAnimationFrame(() => {
        frame = undefined;
        if (settledRef.current) syncPanelToContent();
      });
    };
    const observer = new ResizeObserverConstructor(requestSync);
    observer.observe(content);
    content.addEventListener(MORPH_CONTENT_RESIZE_EVENT, requestSync);
    return () => {
      if (frame !== undefined) ownerWindow.cancelAnimationFrame(frame);
      observer.disconnect();
      content.removeEventListener(MORPH_CONTENT_RESIZE_EVENT, requestSync);
    };
  }, [mounted, open, ownerDocument, syncPanelToContent]);

  useEffect(() => {
    if (!mounted || !open) return;
    const root = rootRef.current;
    const panel = panelRef.current;
    const currentDocument = root?.ownerDocument;
    const ownerWindow = currentDocument?.defaultView;
    if (root === null || root === undefined || panel === null || currentDocument === undefined
      || ownerWindow === null || ownerWindow === undefined || panel.ownerDocument !== currentDocument) return;
    const closeFromOutside = (event: PointerEvent): void => {
      const target = event.target;
      if (!isNodeOwnedBy(target, currentDocument) || panel.contains(target) || root.contains(target)
        || additionalOwnedElementRefRef.current?.current?.contains(target) === true) return;
      pointerInteractionRef.current = true;
      requestClose();
    };
    const closeFromKeyboard = (event: KeyboardEvent): void => {
      if (event.key === "Enter" || event.key === " ") pointerInteractionRef.current = false;
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      pointerInteractionRef.current = false;
      requestClose();
    };
    const closeFromFocus = (event: FocusEvent): void => {
      const target = event.target;
      if (!isNodeOwnedBy(target, currentDocument) || target === currentDocument.body || panel.contains(target)
        || root.contains(target) || additionalOwnedElementRefRef.current?.current?.contains(target) === true) return;
      pointerInteractionRef.current = true;
      requestClose();
    };
    const closeFromResize = (): void => {
      pointerInteractionRef.current = true;
      requestClose();
    };
    currentDocument.addEventListener("pointerdown", closeFromOutside, true);
    currentDocument.addEventListener("keydown", closeFromKeyboard, true);
    currentDocument.addEventListener("focusin", closeFromFocus, true);
    ownerWindow.addEventListener("resize", closeFromResize);
    return () => {
      currentDocument.removeEventListener("pointerdown", closeFromOutside, true);
      currentDocument.removeEventListener("keydown", closeFromKeyboard, true);
      currentDocument.removeEventListener("focusin", closeFromFocus, true);
      ownerWindow.removeEventListener("resize", closeFromResize);
    };
  }, [mounted, open, ownerDocument, requestClose]);

  useEffect(() => () => {
    clearOpenFrames();
    clearTimers();
  }, [clearOpenFrames, clearTimers]);

  return <>
    <div
      ref={setRootElement}
      className={cx("morph-popover", className)}
      onPointerDownCapture={() => { pointerInteractionRef.current = true; }}
    >{trigger}</div>
    {mounted && portalTarget !== null && createPortal(<div
      ref={setPanelElement}
      className={cx("morph-popover__panel", panelClassName)}
      data-state="closed"
      data-morph-side={side}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      onPointerDownCapture={() => { pointerInteractionRef.current = true; }}
      style={{ left: -9_999, top: -9_999, width: 0, height: 0, opacity: 0 }}
    >
      <div ref={contentRef} className="morph-popover__content">{children}</div>
    </div>, portalTarget)}
  </>;
}

function prefersReducedMotion(ownerWindow: Window): boolean {
  return ownerWindow.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function isNodeOwnedBy(value: EventTarget | null, ownerDocument: Document): value is Node {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<Node>;
  return typeof candidate.nodeType === "number" && (value === ownerDocument || candidate.ownerDocument === ownerDocument);
}

function morphTransition(): string {
  return ["width", "height", "left", "right", "top", "bottom", "border-radius", "background-color", "border-color", "box-shadow", "opacity"]
    .map((property) => `${property} ${MORPH_DURATION_MS}ms ${property === "background-color" || property === "border-color" || property === "box-shadow" || property === "opacity" ? "ease" : MORPH_EASING}`)
    .join(", ");
}

function setContentOverflow(content: HTMLDivElement | null, overflowY: "auto" | "hidden"): void {
  if (content === null) return;
  content.style.overflowX = "hidden";
  content.style.overflowY = overflowY;
}
