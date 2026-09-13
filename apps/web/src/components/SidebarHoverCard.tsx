import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  FocusEventHandler,
  JSX,
  KeyboardEventHandler,
  PointerEventHandler,
  ReactNode
} from "react";
import { createPortal } from "react-dom";

import { TOOLTIP_DELAY_MS, cx } from "./ui.js";

export const SIDEBAR_HOVER_CARD_OPEN_DELAY_MS = TOOLTIP_DELAY_MS;
export const SIDEBAR_HOVER_CARD_CLOSE_DELAY_MS = 140;

const VIEWPORT_PADDING = 8;
const CARD_GAP = 8;
const CARD_FOCUSABLE = "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

function focusCardTarget(panel: HTMLElement): void {
  (panel.querySelector<HTMLElement>("[data-sidebar-hover-autofocus]")
    ?? panel.querySelector<HTMLElement>(CARD_FOCUSABLE)
    ?? panel).focus({ preventScroll: true });
}

export interface SidebarHoverCardTriggerProps<TElement extends HTMLElement> {
  readonly ref: (element: TElement | null) => void;
  readonly onPointerEnter: PointerEventHandler<TElement>;
  readonly onPointerLeave: PointerEventHandler<TElement>;
  readonly onPointerDown: PointerEventHandler<TElement>;
  readonly onFocus: FocusEventHandler<TElement>;
  readonly onBlur: FocusEventHandler<TElement>;
  readonly onKeyDown: KeyboardEventHandler<TElement>;
  readonly "aria-controls"?: string;
  readonly "aria-describedby"?: string;
  readonly "aria-haspopup"?: "dialog";
}

interface HoverCardPosition {
  readonly left: number;
  readonly top: number;
}

export function SidebarHoverCard<TElement extends HTMLElement>({
  label,
  interactive = false,
  className,
  trigger,
  children
}: {
  readonly label: string;
  readonly interactive?: boolean;
  readonly className?: string;
  readonly trigger: (props: SidebarHoverCardTriggerProps<TElement>) => ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  const panelId = useId();
  const anchorRef = useRef<TElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const focusPanelWhenOpenRef = useRef(false);
  const pointerFocusRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<HoverCardPosition>();

  const clearTimer = useCallback((): void => {
    if (timerRef.current === undefined) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const ownsFocus = useCallback((): boolean => {
    const active = anchorRef.current?.ownerDocument.activeElement;
    return active instanceof Node
      && (anchorRef.current?.contains(active) === true || panelRef.current?.contains(active) === true);
  }, []);

  const close = useCallback((restoreFocus = false): void => {
    clearTimer();
    focusPanelWhenOpenRef.current = false;
    setOpen(false);
    if (restoreFocus) anchorRef.current?.focus({ preventScroll: true });
  }, [clearTimer]);

  const scheduleOpen = useCallback((): void => {
    clearTimer();
    if (open) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      setOpen(true);
    }, SIDEBAR_HOVER_CARD_OPEN_DELAY_MS);
  }, [clearTimer, open]);

  const openForFocus = useCallback((): void => {
    clearTimer();
    setOpen(true);
  }, [clearTimer]);

  const scheduleClose = useCallback((): void => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      if (!ownsFocus()) setOpen(false);
    }, SIDEBAR_HOVER_CARD_CLOSE_DELAY_MS);
  }, [clearTimer, ownsFocus]);

  const updatePosition = useCallback((): void => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    const ownerWindow = anchor?.ownerDocument.defaultView;
    if (anchor === null || panel === null || ownerWindow === null || ownerWindow === undefined) return;
    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const panelWidth = panelRect.width || panel.offsetWidth;
    const panelHeight = panelRect.height || panel.offsetHeight;
    const right = anchorRect.right + CARD_GAP;
    const left = right + panelWidth <= ownerWindow.innerWidth - VIEWPORT_PADDING
      ? right
      : anchorRect.left - CARD_GAP - panelWidth;
    setPosition({
      left: Math.max(VIEWPORT_PADDING, Math.min(left, ownerWindow.innerWidth - VIEWPORT_PADDING - panelWidth)),
      top: Math.max(VIEWPORT_PADDING, Math.min(anchorRect.top, ownerWindow.innerHeight - VIEWPORT_PADDING - panelHeight))
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined);
      return;
    }
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    const ownerWindow = anchor?.ownerDocument.defaultView;
    if (anchor === null || panel === null || ownerWindow === null || ownerWindow === undefined) return;
    updatePosition();
    const frame = ownerWindow.requestAnimationFrame(() => {
      updatePosition();
      if (!focusPanelWhenOpenRef.current) return;
      focusPanelWhenOpenRef.current = false;
      focusCardTarget(panel);
    });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updatePosition);
    observer?.observe(anchor);
    observer?.observe(panel);
    ownerWindow.addEventListener("resize", updatePosition);
    ownerWindow.addEventListener("scroll", updatePosition, true);
    return () => {
      ownerWindow.cancelAnimationFrame(frame);
      observer?.disconnect();
      ownerWindow.removeEventListener("resize", updatePosition);
      ownerWindow.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const ownerDocument = anchorRef.current?.ownerDocument;
    if (ownerDocument === undefined) return;
    const closeFromPointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || anchorRef.current?.contains(target) === true || panelRef.current?.contains(target) === true) return;
      close(false);
    };
    const closeFromEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const active = ownerDocument.activeElement;
      const restoreFocus = active instanceof Node && panelRef.current?.contains(active) === true;
      close(restoreFocus);
    };
    ownerDocument.addEventListener("pointerdown", closeFromPointer, true);
    ownerDocument.addEventListener("keydown", closeFromEscape, true);
    return () => {
      ownerDocument.removeEventListener("pointerdown", closeFromPointer, true);
      ownerDocument.removeEventListener("keydown", closeFromEscape, true);
    };
  }, [close, open]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const triggerProps: SidebarHoverCardTriggerProps<TElement> = {
    ref: (element) => { anchorRef.current = element; },
    onPointerEnter: (event) => {
      if (event.pointerType !== "touch") scheduleOpen();
    },
    onPointerLeave: scheduleClose,
    onPointerDown: () => {
      pointerFocusRef.current = true;
      window.setTimeout(() => { pointerFocusRef.current = false; }, 0);
    },
    onFocus: () => { if (pointerFocusRef.current) scheduleOpen(); else openForFocus(); },
    onBlur: (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && panelRef.current?.contains(next) === true) {
        clearTimer();
        return;
      }
      scheduleClose();
    },
    onKeyDown: (event) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        close(false);
        return;
      }
      if (!interactive || event.key !== "ArrowRight") return;
      event.preventDefault();
      clearTimer();
      focusPanelWhenOpenRef.current = true;
      if (!open) setOpen(true);
      else {
        focusPanelWhenOpenRef.current = false;
        const panel = panelRef.current;
        if (panel !== null) focusCardTarget(panel);
      }
    },
    ...(interactive
      ? { "aria-controls": panelId, "aria-haspopup": "dialog" as const }
      : { "aria-describedby": open ? panelId : undefined })
  };

  const panel = open && typeof document !== "undefined" ? createPortal(<div
    ref={panelRef}
    id={panelId}
    className={cx("sidebar-hover-card", interactive ? "sidebar-hover-card--interactive" : "sidebar-hover-card--informational", className)}
    role={interactive ? "dialog" : "tooltip"}
    aria-label={interactive ? label : undefined}
    tabIndex={interactive ? -1 : undefined}
    style={{ left: position?.left ?? -9_999, top: position?.top ?? -9_999 }}
    onPointerEnter={clearTimer}
    onPointerLeave={scheduleClose}
    onFocusCapture={clearTimer}
    onBlurCapture={(event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && (panelRef.current?.contains(next) === true || anchorRef.current?.contains(next) === true)) return;
      scheduleClose();
    }}
    onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }}
  >{children}</div>, document.body) : null;

  return <>{trigger(triggerProps)}{panel}</>;
}
