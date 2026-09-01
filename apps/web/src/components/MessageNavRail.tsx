import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX, PointerEvent as ReactPointerEvent, RefObject, WheelEvent as ReactWheelEvent } from "react";

import type { Translator } from "./types.js";
import { cx } from "./ui.js";
import {
  MESSAGE_NAV_ACTIVE_TOP_PX,
  MESSAGE_NAV_MIN_ENTRIES,
  MESSAGE_NAV_MIN_HEIGHT_PX,
  MESSAGE_NAV_RANGE_BOTTOM_EDGE_PX,
  type MessageNavEntry,
  messageNavTickProgress,
  pickActiveMessageNavId,
  pickVisibleMessageNavRange,
  planMessageNavTicks
} from "./message-nav-rail.js";

const PENDING_SAFETY_MS = 3_000;
const IDLE_MS = 2_000;
const TOOLTIP_DELAY_MS = 150;
const TOOLTIP_SKIP_MS = 700;
const TOP_PX = 28;
const BOTTOM_EXTRA_PX = 16;
const WAKE_GUTTER_PX = 48;
const HIDDEN_TOOLTIP_ID = "\u0000message-nav-hidden";
const NAVIGATION_KEYS = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "]);

export function MessageNavRail({ entries, scrollRef, contentRef, bottomOffset, resetKey, estimateEntryTop, onWheelIntent, onCoverageChange, onJump, t }: {
  readonly entries: readonly MessageNavEntry[];
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly contentRef: RefObject<HTMLDivElement | null>;
  readonly bottomOffset: number;
  readonly resetKey: string;
  /** Stable virtual-row fallback for entries outside TanStack Virtual's mounted overscan window. */
  readonly estimateEntryTop?: (id: string, contentTop: number) => number | null;
  /** Joko keeps its history/following wheel intent in React, outside the scroll root's native listeners. */
  readonly onWheelIntent?: (deltaY: number) => void;
  readonly onCoverageChange?: (covered: boolean) => void;
  readonly onJump: (id: string) => void;
  readonly t: Translator;
}): JSX.Element | null {
  const [layout, setLayout] = useState({ availableHeight: 0, hasRoom: false });
  const [activeId, setActiveId] = useState<string>();
  const [visibleRange, setVisibleRange] = useState<{ readonly startId: string; readonly endId: string }>();
  const [pendingId, setPendingId] = useState<string>();
  const [hoveredId, setHoveredId] = useState<string>();
  const [scrubId, setScrubId] = useState<string>();
  const [tooltipId, setTooltipId] = useState<string>();
  const [awake, setAwake] = useState(true);
  const railRef = useRef<HTMLElement>(null);
  const frameRef = useRef<number | undefined>(undefined);
  const pendingTimerRef = useRef<number | undefined>(undefined);
  const idleRef = useRef<number | undefined>(undefined);
  const tooltipTimerRef = useRef<number | undefined>(undefined);
  const tooltipSkipUntilRef = useRef(0);
  const tooltipTargetRef = useRef<string | undefined>(undefined);
  const tooltipIdRef = useRef<string | undefined>(undefined);
  tooltipIdRef.current = tooltipId;
  const hoveringRef = useRef(false);
  const containerLeftRef = useRef(0);
  const scrubRef = useRef<{
    pointerId: number;
    startY: number;
    moved: boolean;
    lastIndex?: number;
    button: HTMLButtonElement;
  } | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const covered = entries.length >= MESSAGE_NAV_MIN_ENTRIES && layout.hasRoom && layout.availableHeight >= MESSAGE_NAV_MIN_HEIGHT_PX;

  useEffect(() => {
    onCoverageChange?.(covered);
    return () => onCoverageChange?.(false);
  }, [covered, onCoverageChange]);

  const wake = useCallback((): void => {
    setAwake(true);
    if (idleRef.current !== undefined) window.clearTimeout(idleRef.current);
    const scheduleHide = (): void => {
      idleRef.current = window.setTimeout(() => {
        idleRef.current = undefined;
        if (hoveringRef.current) {
          scheduleHide();
          return;
        }
        setAwake(false);
      }, IDLE_MS);
    };
    scheduleHide();
  }, []);

  const closeTooltip = useCallback((id?: string): void => {
    if (tooltipTimerRef.current !== undefined) {
      window.clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = undefined;
    }
    if (id !== undefined && tooltipTargetRef.current !== id && tooltipIdRef.current !== id) return;
    if (id === undefined || tooltipTargetRef.current === id) tooltipTargetRef.current = undefined;
    if (id === undefined || tooltipIdRef.current === id) {
      if (tooltipIdRef.current !== undefined) tooltipSkipUntilRef.current = performance.now() + TOOLTIP_SKIP_MS;
      tooltipIdRef.current = undefined;
      setTooltipId(undefined);
    }
  }, []);

  const scheduleTooltip = useCallback((id: string): void => {
    tooltipTargetRef.current = id;
    if (tooltipTimerRef.current !== undefined) window.clearTimeout(tooltipTimerRef.current);
    const open = (): void => {
      tooltipTimerRef.current = undefined;
      if (tooltipTargetRef.current !== id) return;
      tooltipIdRef.current = id;
      setTooltipId(id);
    };
    if (tooltipSkipUntilRef.current > 0 && performance.now() <= tooltipSkipUntilRef.current) {
      open();
      return;
    }
    tooltipTimerRef.current = window.setTimeout(open, TOOLTIP_DELAY_MS);
  }, []);

  const measure = useCallback((): void => {
    frameRef.current = undefined;
    const root = scrollRef.current;
    const content = contentRef.current;
    if (root === null || content === null) return;
    const rootRect = root.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    containerLeftRef.current = rootRect.left;
    const leftGutter = Math.max(0, contentRect.left - rootRect.left);
    const availableHeight = Math.max(0, rootRect.height - Math.max(0, bottomOffset) - TOP_PX - BOTTOM_EXTRA_PX);
    const hasRoom = leftGutter >= 44;
    setLayout((current) => current.availableHeight === availableHeight && current.hasRoom === hasRoom
      ? current
      : { availableHeight, hasRoom });
    const current = entriesRef.current;
    if (current.length < MESSAGE_NAV_MIN_ENTRIES || !hasRoom || availableHeight < MESSAGE_NAV_MIN_HEIGHT_PX) {
      setActiveId(undefined);
      setVisibleRange(undefined);
      return;
    }
    const topById = new Map<string, number>();
    for (const anchor of root.querySelectorAll<HTMLElement>("[data-message-client-id]")) {
      const id = anchor.dataset.messageClientId;
      if (id !== undefined) topById.set(id, anchor.getBoundingClientRect().top);
    }
    const ids = current.map((entry) => entry.id);
    const topAt = (index: number): number | null => {
      const id = ids[index];
      if (id === undefined) return null;
      return topById.get(id) ?? estimateEntryTop?.(id, contentRect.top) ?? null;
    };
    setActiveId(pickActiveMessageNavId(ids, rootRect.top + MESSAGE_NAV_ACTIVE_TOP_PX, topAt));
    const range = pickVisibleMessageNavRange(
      ids,
      rootRect.top + MESSAGE_NAV_ACTIVE_TOP_PX,
      rootRect.bottom - MESSAGE_NAV_RANGE_BOTTOM_EDGE_PX,
      topAt
    );
    const nextRange = range === undefined ? undefined : { startId: ids[range.startIndex]!, endId: ids[range.endIndex]! };
    setVisibleRange((currentRange) => currentRange?.startId === nextRange?.startId && currentRange?.endId === nextRange?.endId
      ? currentRange
      : nextRange);
  }, [bottomOffset, contentRef, estimateEntryTop, scrollRef]);

  const scheduleMeasure = useCallback((): void => {
    if (frameRef.current !== undefined) return;
    frameRef.current = requestAnimationFrame(measure);
  }, [measure]);

  const dropPending = useCallback((): void => {
    if (pendingTimerRef.current !== undefined) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = undefined;
    }
    setPendingId(undefined);
  }, []);

  const markPending = useCallback((id: string): void => {
    setPendingId(id);
    if (pendingTimerRef.current !== undefined) window.clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = window.setTimeout(() => {
      pendingTimerRef.current = undefined;
      setPendingId(undefined);
    }, PENDING_SAFETY_MS);
  }, []);

  useEffect(() => {
    setActiveId(undefined);
    setVisibleRange(undefined);
    setHoveredId(undefined);
    setScrubId(undefined);
    scrubRef.current = undefined;
    suppressClickRef.current = false;
    dropPending();
    closeTooltip();
    setAwake(true);
    scheduleMeasure();
  }, [closeTooltip, dropPending, resetKey, scheduleMeasure]);

  useEffect(() => {
    const root = scrollRef.current;
    if (root === null) return;
    const onScroll = (): void => { wake(); scheduleMeasure(); };
    const onMouseMove = (event: MouseEvent): void => {
      if (event.clientX - containerLeftRef.current <= WAKE_GUTTER_PX) wake();
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("mousemove", onMouseMove, { passive: true });
    root.addEventListener("wheel", dropPending, { passive: true });
    root.addEventListener("touchstart", dropPending, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleMeasure);
    observer?.observe(root);
    observer?.observe(contentRef.current ?? root);
    if (observer === undefined) window.addEventListener("resize", scheduleMeasure);
    scheduleMeasure();
    wake();
    return () => {
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("mousemove", onMouseMove);
      root.removeEventListener("wheel", dropPending);
      root.removeEventListener("touchstart", dropPending);
      observer?.disconnect();
      if (observer === undefined) window.removeEventListener("resize", scheduleMeasure);
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [contentRef, dropPending, scheduleMeasure, scrollRef, wake]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!NAVIGATION_KEYS.has(event.key)) return;
      if (event.key === " " && isEditableKeyboardTarget(event.target)) return;
      dropPending();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dropPending]);

  useEffect(scheduleMeasure, [entries, bottomOffset, scheduleMeasure]);
  useEffect(() => {
    if (pendingId !== undefined && pendingId === activeId) dropPending();
  }, [activeId, dropPending, pendingId]);
  useEffect(() => () => {
    if (pendingTimerRef.current !== undefined) window.clearTimeout(pendingTimerRef.current);
    if (idleRef.current !== undefined) window.clearTimeout(idleRef.current);
    if (tooltipTimerRef.current !== undefined) window.clearTimeout(tooltipTimerRef.current);
  }, []);

  const jump = useCallback((entry: MessageNavEntry): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    markPending(entry.id);
    wake();
    onJump(entry.id);
  }, [markPending, onJump, wake]);

  const findScrubIndex = useCallback((clientY: number): number | undefined => {
    const rail = railRef.current;
    if (rail === null) return undefined;
    let nearest: { index: number; distance: number } | undefined;
    for (const button of rail.querySelectorAll<HTMLButtonElement>("[data-message-nav-index]")) {
      const index = Number(button.dataset.messageNavIndex);
      if (!Number.isInteger(index)) continue;
      const rect = button.getBoundingClientRect();
      const distance = Math.abs(clientY - rect.top - rect.height / 2);
      if (nearest === undefined || distance < nearest.distance) nearest = { index, distance };
    }
    return nearest?.index;
  }, []);

  const jumpToScrubIndex = useCallback((index: number): void => {
    const entry = entries[index];
    if (entry === undefined) return;
    setScrubId(entry.id);
    const scrub = scrubRef.current;
    if (scrub?.lastIndex === index) return;
    if (scrub !== undefined) scrub.lastIndex = index;
    markPending(entry.id);
    onJump(entry.id);
  }, [entries, markPending, onJump]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    const scrub = scrubRef.current;
    if (scrub === undefined || scrub.pointerId !== event.pointerId) return;
    if (!scrub.moved && Math.abs(event.clientY - scrub.startY) < 3) return;
    scrub.moved = true;
    const index = findScrubIndex(event.clientY);
    if (index !== undefined) jumpToScrubIndex(index);
  }, [findScrubIndex, jumpToScrubIndex]);

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLButtonElement>, suppressFollowUpClick: boolean): void => {
    const scrub = scrubRef.current;
    if (scrub === undefined || scrub.pointerId !== event.pointerId) return;
    if (scrub.button.hasPointerCapture?.(event.pointerId)) scrub.button.releasePointerCapture?.(event.pointerId);
    suppressClickRef.current = suppressFollowUpClick && scrub.moved;
    scrubRef.current = undefined;
    setScrubId(undefined);
  }, []);

  const beginHover = useCallback((id: string): void => {
    hoveringRef.current = true;
    if (id !== HIDDEN_TOOLTIP_ID) setHoveredId(id);
    wake();
    scheduleTooltip(id);
  }, [scheduleTooltip, wake]);

  const endHover = useCallback((id: string): void => {
    hoveringRef.current = false;
    if (id !== HIDDEN_TOOLTIP_ID) setHoveredId((current) => current === id ? undefined : current);
    closeTooltip(id);
  }, [closeTooltip]);

  const onWheel = useCallback((event: ReactWheelEvent<HTMLElement>): void => {
    dropPending();
    const root = scrollRef.current;
    if (root === null) return;
    root.dispatchEvent(new WheelEvent("wheel", { deltaX: event.deltaX, deltaY: event.deltaY }));
    onWheelIntent?.(event.deltaY);
    root.scrollBy({ top: event.deltaY, left: event.deltaX, behavior: "auto" });
  }, [dropPending, onWheelIntent, scrollRef]);

  if (entries.length < MESSAGE_NAV_MIN_ENTRIES || !layout.hasRoom || layout.availableHeight < MESSAGE_NAV_MIN_HEIGHT_PX) return null;
  const plan = planMessageNavTicks(entries.length, layout.availableHeight);
  const visible = entries.slice(plan.startIndex);
  const displayActiveId = pendingId ?? activeId;
  let rangeStartIndex = -1;
  let rangeEndIndex = -1;
  if (visibleRange !== undefined) {
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index]?.id === visibleRange.startId) rangeStartIndex = index;
      if (entries[index]?.id === visibleRange.endId) {
        rangeEndIndex = index;
        if (rangeStartIndex >= 0) break;
      }
    }
  }
  const interactionId = scrubId ?? hoveredId;
  const interactionIndex = interactionId === undefined ? -1 : entries.findIndex((entry) => entry.id === interactionId);
  const style = {
    paddingTop: `${TOP_PX}px`,
    paddingBottom: `${Math.max(0, bottomOffset) + BOTTOM_EXTRA_PX}px`,
    "--message-nav-pitch": `${plan.pitchPx}px`
  } as CSSProperties;

  return (
    <nav
      ref={railRef}
      className={cx("message-nav-rail", awake && "is-awake")}
      aria-label={t("timeline.messageNav")}
      style={style}
      onWheel={onWheel}
      onMouseLeave={() => {
        hoveringRef.current = false;
        setHoveredId(undefined);
      }}
    >
      {plan.hiddenCount > 0 && (
        <div
          className="message-nav-rail__hidden"
          style={{ height: `${plan.pitchPx}px` }}
          onMouseEnter={() => beginHover(HIDDEN_TOOLTIP_ID)}
          onMouseLeave={() => endHover(HIDDEN_TOOLTIP_ID)}
        >
          <span aria-hidden="true">⋯</span>
          {tooltipId === HIDDEN_TOOLTIP_ID && <span className="message-nav-rail__hidden-tip" role="tooltip">{t("timeline.messageNavEarlier", { count: plan.hiddenCount })}</span>}
        </div>
      )}
      {visible.map((entry, visibleIndex) => {
        const index = plan.startIndex + visibleIndex;
        const active = displayActiveId === entry.id;
        const inView = rangeStartIndex >= 0 && index >= rangeStartIndex && index <= rangeEndIndex;
        const interactionDistance = interactionIndex < 0 ? undefined : Math.abs(index - interactionIndex);
        const preview = entry.preview || t("timeline.messageNavAttachments", { count: entry.attachmentsOnly ?? 1 });
        const progress = messageNavTickProgress(interactionDistance);
        return <button
          type="button"
          key={entry.id}
          className={cx(
            "message-nav-rail__tick",
            active && "is-active",
            inView && "is-in-view",
            interactionDistance !== undefined && "is-interacting",
            interactionDistance === 0 && "is-interaction-target"
          )}
          data-message-nav-index={index}
          data-message-nav-automation={entry.isAutomation ? "true" : undefined}
          aria-current={active ? "true" : undefined}
          aria-label={t("timeline.messageNavJump", { index: index + 1, preview })}
          style={{ height: `${plan.pitchPx}px` }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            suppressClickRef.current = false;
            scrubRef.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              moved: false,
              button: event.currentTarget
            };
            setScrubId(entry.id);
            wake();
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => finishPointer(event, true)}
          onPointerCancel={(event) => finishPointer(event, false)}
          onLostPointerCapture={(event) => finishPointer(event, false)}
          onMouseEnter={() => beginHover(entry.id)}
          onMouseLeave={() => endHover(entry.id)}
          onFocus={() => beginHover(entry.id)}
          onBlur={() => endHover(entry.id)}
          onClick={() => jump(entry)}
        >
          <span
            className="message-nav-rail__line"
            aria-hidden="true"
            style={{ transform: `scaleX(${0.2308 + 0.7692 * progress})` }}
          />
          {tooltipId === entry.id && <span className="message-nav-rail__preview" role="tooltip"><strong>{preview}</strong>{entry.answerExcerpt !== undefined && <span>{entry.answerExcerpt}</span>}</span>}
        </button>;
      })}
    </nav>
  );
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target.isContentEditable
    || target.closest("[contenteditable='true']") !== null;
}
