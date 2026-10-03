import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

interface RailOwner {
  readonly key: string;
  readonly node: HTMLDivElement;
  readonly view: Window & typeof globalThis;
  active: boolean;
  generation: number;
}

interface ScheduledHandle {
  readonly id: number;
  readonly view: Window;
}

export function MessageNavRail({ entries, scrollRef, contentRef, bottomOffset, resetKey, estimateEntryTop, onWheelIntent, onCoverageChange, onJump, t }: {
  readonly entries: readonly MessageNavEntry[];
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly contentRef: RefObject<HTMLDivElement | null>;
  readonly bottomOffset: number;
  readonly resetKey: string;
  /** Stable virtual-row fallback for entries outside TanStack Virtual's mounted overscan window. */
  readonly estimateEntryTop?: (id: string, contentTop: number) => number | null;
  /** Joko keeps its history/following wheel intent in React, outside the scroll root's native listeners. */
  readonly onWheelIntent?: (deltaY: number, deltaX: number) => void;
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
  const [pageActive, setPageActive] = useState(true);
  const railRef = useRef<HTMLElement>(null);
  const ownerRef = useRef<RailOwner | undefined>(undefined);
  const ownerKeyRef = useRef(resetKey);
  ownerKeyRef.current = resetKey;
  const documentLifecycleRef = useRef<{ readonly view: Window; active: boolean } | undefined>(undefined);
  const frameRef = useRef<ScheduledHandle | undefined>(undefined);
  const pendingTimerRef = useRef<ScheduledHandle | undefined>(undefined);
  const idleRef = useRef<ScheduledHandle | undefined>(undefined);
  const tooltipTimerRef = useRef<ScheduledHandle | undefined>(undefined);
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
  const plan = planMessageNavTicks(entries.length, layout.availableHeight);
  const covered = pageActive && entries.length >= MESSAGE_NAV_MIN_ENTRIES
    && layout.hasRoom
    && layout.availableHeight >= MESSAGE_NAV_MIN_HEIGHT_PX
    && plan.hiddenCount === 0;

  useEffect(() => {
    onCoverageChange?.(covered);
    return () => onCoverageChange?.(false);
  }, [covered, onCoverageChange]);

  const ownsCallback = useCallback((owner: RailOwner, generation: number): boolean =>
    ownerRef.current === owner && owner.key === ownerKeyRef.current
    && owner.node === scrollRef.current && owner.active && owner.generation === generation,
  [scrollRef]);

  const wake = useCallback((): void => {
    const owner = ownerRef.current;
    if (owner === undefined || !ownsCallback(owner, owner.generation)) return;
    const generation = owner.generation;
    setAwake(true);
    clearTimer(idleRef);
    const scheduleHide = (): void => {
      const handle = { view: owner.view, id: owner.view.setTimeout(() => {
        if (!ownsCallback(owner, generation) || idleRef.current !== handle) return;
        idleRef.current = undefined;
        if (hoveringRef.current) {
          scheduleHide();
          return;
        }
        setAwake(false);
      }, IDLE_MS) };
      idleRef.current = handle;
    };
    scheduleHide();
  }, [ownsCallback]);

  const closeTooltip = useCallback((id?: string): void => {
    clearTimer(tooltipTimerRef);
    if (id !== undefined && tooltipTargetRef.current !== id && tooltipIdRef.current !== id) return;
    if (id === undefined || tooltipTargetRef.current === id) tooltipTargetRef.current = undefined;
    if (id === undefined || tooltipIdRef.current === id) {
      if (tooltipIdRef.current !== undefined) tooltipSkipUntilRef.current = (ownerRef.current?.view.performance.now() ?? 0) + TOOLTIP_SKIP_MS;
      tooltipIdRef.current = undefined;
      setTooltipId(undefined);
    }
  }, []);

  const scheduleTooltip = useCallback((id: string): void => {
    const owner = ownerRef.current;
    if (owner === undefined || !ownsCallback(owner, owner.generation)) return;
    const generation = owner.generation;
    tooltipTargetRef.current = id;
    clearTimer(tooltipTimerRef);
    const open = (): void => {
      if (!ownsCallback(owner, generation)) return;
      tooltipTimerRef.current = undefined;
      if (tooltipTargetRef.current !== id) return;
      tooltipIdRef.current = id;
      setTooltipId(id);
    };
    if (tooltipSkipUntilRef.current > 0 && owner.view.performance.now() <= tooltipSkipUntilRef.current) {
      open();
      return;
    }
    const handle = { view: owner.view, id: owner.view.setTimeout(() => {
      if (tooltipTimerRef.current === handle) open();
    }, TOOLTIP_DELAY_MS) };
    tooltipTimerRef.current = handle;
  }, [ownsCallback]);

  const measure = useCallback((): void => {
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
  const measureRef = useRef(measure);
  measureRef.current = measure;

  const scheduleMeasure = useCallback((): void => {
    if (frameRef.current !== undefined) return;
    const owner = ownerRef.current;
    if (owner === undefined || !ownsCallback(owner, owner.generation)) return;
    const generation = owner.generation;
    const handle = { view: owner.view, id: owner.view.requestAnimationFrame(() => {
      if (!ownsCallback(owner, generation) || frameRef.current !== handle) return;
      frameRef.current = undefined;
      measureRef.current();
    }) };
    frameRef.current = handle;
  }, [ownsCallback]);

  const dropPending = useCallback((): void => {
    clearTimer(pendingTimerRef);
    setPendingId(undefined);
  }, []);

  const markPending = useCallback((id: string): void => {
    const owner = ownerRef.current;
    if (owner === undefined || !ownsCallback(owner, owner.generation)) return;
    const generation = owner.generation;
    setPendingId(id);
    clearTimer(pendingTimerRef);
    const handle = { view: owner.view, id: owner.view.setTimeout(() => {
      if (!ownsCallback(owner, generation) || pendingTimerRef.current !== handle) return;
      pendingTimerRef.current = undefined;
      setPendingId(undefined);
    }, PENDING_SAFETY_MS) };
    pendingTimerRef.current = handle;
  }, [ownsCallback]);

  const retireInteractions = useCallback((updateState: boolean): void => {
    const scrub = scrubRef.current;
    scrubRef.current = undefined;
    if (scrub?.button.hasPointerCapture?.(scrub.pointerId)) scrub.button.releasePointerCapture?.(scrub.pointerId);
    suppressClickRef.current = false;
    hoveringRef.current = false;
    tooltipTargetRef.current = undefined;
    tooltipIdRef.current = undefined;
    tooltipSkipUntilRef.current = 0;
    clearTimer(pendingTimerRef);
    clearTimer(idleRef);
    clearTimer(tooltipTimerRef);
    const frame = frameRef.current;
    frameRef.current = undefined;
    if (frame !== undefined) frame.view.cancelAnimationFrame(frame.id);
    if (updateState) {
      setActiveId(undefined);
      setVisibleRange(undefined);
      setPendingId(undefined);
      setHoveredId(undefined);
      setScrubId(undefined);
      setTooltipId(undefined);
      setAwake(true);
    }
  }, []);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    const view = node?.ownerDocument.defaultView;
    if (node === null || view === null || view === undefined) return;
    if (documentLifecycleRef.current?.view !== view) documentLifecycleRef.current = { view, active: true };
    const lifecycle = documentLifecycleRef.current;
    const owner: RailOwner = { key: resetKey, node, view, active: lifecycle.active, generation: 0 };
    ownerRef.current = owner;
    retireInteractions(true);
    setPageActive(owner.active);
    const onPageHide = (): void => {
      if (ownerRef.current !== owner || !owner.active) return;
      lifecycle.active = false;
      owner.active = false;
      owner.generation += 1;
      retireInteractions(true);
      setPageActive(false);
    };
    const onPageShow = (): void => {
      if (ownerRef.current !== owner || owner.active) return;
      lifecycle.active = true;
      owner.active = true;
      owner.generation += 1;
      retireInteractions(true);
      setPageActive(true);
      scheduleMeasure();
      wake();
    };
    view.addEventListener("pagehide", onPageHide);
    view.addEventListener("pageshow", onPageShow);
    scheduleMeasure();
    wake();
    return () => {
      view.removeEventListener("pagehide", onPageHide);
      view.removeEventListener("pageshow", onPageShow);
      owner.active = false;
      owner.generation += 1;
      if (ownerRef.current === owner) {
        retireInteractions(false);
        ownerRef.current = undefined;
      }
    };
  }, [resetKey, retireInteractions, scheduleMeasure, scrollRef, wake]);

  useEffect(() => {
    const root = scrollRef.current;
    const owner = ownerRef.current;
    if (root === null || owner === undefined || !owner.active) return;
    const generation = owner.generation;
    const scheduleOwnedMeasure = (): void => { if (ownsCallback(owner, generation)) scheduleMeasure(); };
    const onScroll = (): void => {
      if (!ownsCallback(owner, generation)) return;
      wake();
      scheduleMeasure();
    };
    const onMouseMove = (event: MouseEvent): void => {
      if (!ownsCallback(owner, generation)) return;
      if (event.clientX - containerLeftRef.current <= WAKE_GUTTER_PX) wake();
    };
    const onScrollIntent = (): void => { if (ownsCallback(owner, generation)) dropPending(); };
    root.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("mousemove", onMouseMove, { passive: true });
    root.addEventListener("wheel", onScrollIntent, { passive: true });
    root.addEventListener("touchstart", onScrollIntent, { passive: true });
    const observer = typeof owner.view.ResizeObserver === "undefined" ? undefined : new owner.view.ResizeObserver(scheduleOwnedMeasure);
    observer?.observe(root);
    observer?.observe(contentRef.current ?? root);
    if (observer === undefined) owner.view.addEventListener("resize", scheduleOwnedMeasure);
    scheduleMeasure();
    wake();
    return () => {
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("mousemove", onMouseMove);
      root.removeEventListener("wheel", onScrollIntent);
      root.removeEventListener("touchstart", onScrollIntent);
      observer?.disconnect();
      if (observer === undefined) owner.view.removeEventListener("resize", scheduleOwnedMeasure);
    };
  }, [contentRef, dropPending, ownsCallback, pageActive, resetKey, scheduleMeasure, scrollRef, wake]);

  useEffect(() => {
    const owner = ownerRef.current;
    if (owner === undefined || !owner.active) return;
    const generation = owner.generation;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!ownsCallback(owner, generation)) return;
      if (!NAVIGATION_KEYS.has(event.key)) return;
      if (event.key === " " && isEditableKeyboardTarget(event.target, owner.view)) return;
      dropPending();
    };
    owner.view.addEventListener("keydown", onKeyDown);
    return () => owner.view.removeEventListener("keydown", onKeyDown);
  }, [dropPending, ownsCallback, pageActive, resetKey]);

  useEffect(scheduleMeasure, [entries, bottomOffset, scheduleMeasure]);
  useEffect(() => {
    if (pendingId !== undefined && pendingId === activeId) dropPending();
  }, [activeId, dropPending, pendingId]);
  const jump = useCallback((entry: MessageNavEntry): void => {
    const owner = ownerRef.current;
    if (owner === undefined || !ownsCallback(owner, owner.generation)) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    markPending(entry.id);
    wake();
    onJump(entry.id);
  }, [markPending, onJump, ownsCallback, wake]);

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
    const owner = ownerRef.current;
    if (owner === undefined || !ownsCallback(owner, owner.generation)) return;
    const entry = entries[index];
    if (entry === undefined) return;
    setScrubId(entry.id);
    const scrub = scrubRef.current;
    if (scrub?.lastIndex === index) return;
    if (scrub !== undefined) scrub.lastIndex = index;
    markPending(entry.id);
    onJump(entry.id);
  }, [entries, markPending, onJump, ownsCallback]);

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
    const owner = ownerRef.current;
    if (owner === undefined || !ownsCallback(owner, owner.generation)) return;
    hoveringRef.current = true;
    if (id !== HIDDEN_TOOLTIP_ID) setHoveredId(id);
    wake();
    scheduleTooltip(id);
  }, [ownsCallback, scheduleTooltip, wake]);

  const endHover = useCallback((id: string): void => {
    hoveringRef.current = false;
    if (id !== HIDDEN_TOOLTIP_ID) setHoveredId((current) => current === id ? undefined : current);
    closeTooltip(id);
  }, [closeTooltip]);

  const onWheel = useCallback((event: ReactWheelEvent<HTMLElement>): void => {
    if (event.ctrlKey || event.metaKey) return;
    const owner = ownerRef.current;
    if (owner === undefined || !ownsCallback(owner, owner.generation)) return;
    dropPending();
    const root = scrollRef.current;
    if (root === null) return;
    root.dispatchEvent(new owner.view.WheelEvent("wheel", { deltaX: event.deltaX, deltaY: event.deltaY }));
    onWheelIntent?.(event.deltaY, event.deltaX);
    root.scrollBy({ top: event.deltaY, left: event.deltaX, behavior: "auto" });
  }, [dropPending, onWheelIntent, ownsCallback, scrollRef]);

  if (entries.length < MESSAGE_NAV_MIN_ENTRIES || !layout.hasRoom || layout.availableHeight < MESSAGE_NAV_MIN_HEIGHT_PX) return null;
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
            const owner = ownerRef.current;
            if (owner === undefined || !ownsCallback(owner, owner.generation)) return;
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

function clearTimer(ref: { current: ScheduledHandle | undefined }): void {
  const handle = ref.current;
  ref.current = undefined;
  if (handle !== undefined) handle.view.clearTimeout(handle.id);
}

function isEditableKeyboardTarget(target: EventTarget | null, view: Window & typeof globalThis): boolean {
  if (!(target instanceof view.HTMLElement)) return false;
  return target instanceof view.HTMLInputElement
    || target instanceof view.HTMLTextAreaElement
    || target instanceof view.HTMLSelectElement
    || target.isContentEditable
    || target.closest("[contenteditable='true']") !== null;
}
