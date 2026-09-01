import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { useVirtualizer, type Rect, type Virtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Terminal, Wrench } from "lucide-react";

import type { MessageKey } from "../i18n.js";
import type {
  SubagentChildRunView,
  SubagentRunDetailView,
  SubagentRunView,
  SubagentTranscriptEntryView
} from "../model.js";
import type { SubagentConversationItem } from "./subagent-conversation.js";
import { localizeSubagentSystemEntry } from "./subagent-panel-state.js";
import {
  countUnreadSubagentItems,
  nextSubagentTabIndex,
  resolveSubagentAnchorIndex,
  resolveSubagentFollowingOnScroll,
  SUBAGENT_UP_NAVIGATION_KEYS,
  type SubagentVirtualAnchor
} from "./subagent-virtual-state.js";
import { StreamingMarkdown } from "./Timeline.js";
import type { Translator } from "./types.js";
import { Button, Pill, Spinner, cx, formatDateTime } from "./ui.js";

const DEFAULT_VIEWPORT_RECT = { width: 640, height: 800 };
const DEFAULT_HORIZONTAL_RECT = { width: 640, height: 36 };
const RUN_ROW_ESTIMATE_PX = 72;
const CHILD_ROW_ESTIMATE_PX = 58;
const TECHNICAL_ROW_ESTIMATE_PX = 40;
const observeDefaultViewportRect = observeElementRectWithFallback(DEFAULT_VIEWPORT_RECT);
const observeHorizontalRect = observeElementRectWithFallback(DEFAULT_HORIZONTAL_RECT);
const observeCompactViewportRect = observeElementRectWithFallback({ width: DEFAULT_VIEWPORT_RECT.width, height: 320 });

interface RunTreeRow {
  readonly run: SubagentRunView;
  readonly depth: number;
}

type VirtualRunListItem =
  | { readonly kind: "heading"; readonly id: string; readonly label: string }
  | { readonly kind: "run"; readonly id: string; readonly row: RunTreeRow; readonly headingId: string };

export function VirtualSubagentRunGroups({
  activeRows,
  finishedRows,
  activeLabel,
  finishedLabel,
  ariaLabel,
  focusRunId,
  focusRequestId,
  renderRun
}: {
  readonly activeRows: readonly RunTreeRow[];
  readonly finishedRows: readonly RunTreeRow[];
  readonly activeLabel: string;
  readonly finishedLabel: string;
  readonly ariaLabel: string;
  readonly focusRunId?: string;
  readonly focusRequestId: number;
  readonly renderRun: (row: RunTreeRow) => JSX.Element;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const handledFocusRequestRef = useRef(-1);
  const headingPrefix = useId();
  const activeHeadingId = `${headingPrefix}-running`;
  const finishedHeadingId = `${headingPrefix}-finished`;
  const items = useMemo<readonly VirtualRunListItem[]>(() => {
    const next: VirtualRunListItem[] = [];
    if (activeRows.length > 0) {
      next.push({ kind: "heading", id: `${activeHeadingId}-row`, label: activeLabel });
      next.push(...activeRows.map((row) => ({ kind: "run" as const, id: row.run.id, row, headingId: activeHeadingId })));
    }
    if (finishedRows.length > 0) {
      next.push({ kind: "heading", id: `${finishedHeadingId}-row`, label: finishedLabel });
      next.push(...finishedRows.map((row) => ({ kind: "run" as const, id: row.run.id, row, headingId: finishedHeadingId })));
    }
    return next;
  }, [activeHeadingId, activeLabel, activeRows, finishedHeadingId, finishedLabel, finishedRows]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => items[index]?.kind === "heading" ? 30 : RUN_ROW_ESTIMATE_PX,
    overscan: 10,
    getItemKey: (index) => items[index]?.id ?? index,
    initialRect: DEFAULT_VIEWPORT_RECT,
    observeElementRect: observeDefaultViewportRect,
    scrollToFn: scrollSubagentElement,
    measureElement: (element) => element.getBoundingClientRect().height || (items[Number(element.getAttribute("data-index"))]?.kind === "heading" ? 30 : RUN_ROW_ESTIMATE_PX)
  });
  const virtualRows = virtualizer.getVirtualItems();
  const renderedRowsKey = virtualRows.map((row) => row.key).join("\u0000");

  useLayoutEffect(() => {
    if (focusRunId === undefined || focusRequestId === handledFocusRequestRef.current) return;
    const index = items.findIndex((item) => item.kind === "run" && item.id === focusRunId);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "auto" });
    let attempts = 0;
    const focus = (): void => {
      const root = scrollRef.current;
      const row = root === null ? undefined : [...root.querySelectorAll<HTMLElement>("[data-subagent-run-id]")]
        .find((candidate) => candidate.dataset.subagentRunId === focusRunId);
      if (row === undefined && attempts < 3) {
        attempts += 1;
        scheduleFrame(focus);
        return;
      }
      const button = row?.querySelector<HTMLButtonElement>("button");
      if (button === null || button === undefined) return;
      handledFocusRequestRef.current = focusRequestId;
      button.focus({ preventScroll: true });
    };
    scheduleFrame(focus);
  }, [focusRequestId, focusRunId, items, renderedRowsKey, virtualizer]);

  return <div ref={scrollRef} className="subagents-run-list__viewport" role="list" aria-label={ariaLabel}>
    <div className="sr-only">
      {activeRows.length > 0 && <h3 id={activeHeadingId}>{activeLabel}</h3>}
      {finishedRows.length > 0 && <h3 id={finishedHeadingId}>{finishedLabel}</h3>}
    </div>
    <div className="subagents-run-list__virtual" style={{ height: `${virtualizer.getTotalSize()}px` }}>
      {virtualRows.map((virtualRow) => {
        const item = items[virtualRow.index];
        if (item === undefined) return null;
        return <div
          key={item.id}
          ref={virtualizer.measureElement}
          data-index={virtualRow.index}
          {...(item.kind === "run" ? { "data-subagent-run-id": item.id, role: "listitem", "aria-labelledby": item.headingId } : {})}
          className={cx("subagents-run-list__virtual-row", item.kind === "heading" && "is-heading")}
          style={{ transform: `translateY(${virtualRow.start}px)` }}
        >{item.kind === "heading" ? <div className="subagents-run-list__heading" aria-hidden="true">{item.label}</div> : renderRun(item.row)}</div>;
      })}
    </div>
  </div>;
}

interface ChildTabItem {
  readonly id: string;
  readonly child?: SubagentChildRunView;
}

export function VirtualSubagentChildTabs({
  children,
  selectedId,
  overviewLabel,
  ariaLabel,
  controlsId,
  tabIdPrefix,
  renderChild,
  onSelect
}: {
  readonly children: readonly SubagentChildRunView[];
  readonly selectedId: string;
  readonly overviewLabel: string;
  readonly ariaLabel: string;
  readonly controlsId: string;
  readonly tabIdPrefix: string;
  readonly renderChild: (child: SubagentChildRunView) => ReactNode;
  readonly onSelect: (childId: string) => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const items = useMemo<readonly ChildTabItem[]>(() => [{ id: "" }, ...children.map((child) => ({ id: child.id, child }))], [children]);
  const virtualizer = useVirtualizer({
    horizontal: true,
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => items[index]?.child === undefined ? 96 : 164,
    overscan: 5,
    getItemKey: (index) => items[index]?.id || "overview",
    initialRect: DEFAULT_HORIZONTAL_RECT,
    observeElementRect: observeHorizontalRect,
    scrollToFn: scrollSubagentElement,
    measureElement: (element) => element.getBoundingClientRect().width || (items[Number(element.getAttribute("data-index"))]?.child === undefined ? 96 : 164)
  });
  const selectedIndex = Math.max(0, items.findIndex((item) => item.id === selectedId));

  useLayoutEffect(() => {
    virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, virtualizer]);

  const focusIndex = useCallback((index: number): void => {
    virtualizer.scrollToIndex(index, { align: "auto" });
    let attempts = 0;
    const focus = (): void => {
      const root = scrollRef.current;
      const button = root === null ? undefined : [...root.querySelectorAll<HTMLButtonElement>("[data-subagent-child-tab-index]")]
        .find((candidate) => Number(candidate.dataset.subagentChildTabIndex) === index);
      if (button === undefined && attempts < 3) {
        attempts += 1;
        scheduleFrame(focus);
        return;
      }
      button?.focus({ preventScroll: true });
    };
    scheduleFrame(focus);
  }, [virtualizer]);

  return <div ref={scrollRef} className="subagent-child-tabs" role="tablist" aria-label={ariaLabel}>
    <div className="subagent-child-tabs__virtual" style={{ width: `${virtualizer.getTotalSize()}px` }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index];
        if (item === undefined) return null;
        const selected = item.id === selectedId;
        return <div
          key={item.id || "overview"}
          ref={virtualizer.measureElement}
          data-index={virtualRow.index}
          className="subagent-child-tabs__row"
          style={{ transform: `translateX(${virtualRow.start}px)` }}
        ><button
          type="button"
          role="tab"
          id={`${tabIdPrefix}-tab-${virtualRow.index}`}
          data-subagent-child-tab-index={virtualRow.index}
          aria-selected={selected}
          aria-controls={controlsId}
          tabIndex={selected ? 0 : -1}
          className={selected ? "is-selected" : undefined}
          onClick={() => onSelect(item.id)}
          onKeyDown={(event) => {
            const nextIndex = nextSubagentTabIndex(virtualRow.index, items.length, event.key);
            if (nextIndex === undefined) return;
            event.preventDefault();
            const next = items[nextIndex];
            if (next === undefined) return;
            onSelect(next.id);
            focusIndex(nextIndex);
          }}
        >{item.child === undefined ? overviewLabel : renderChild(item.child)}</button></div>;
      })}
    </div>
  </div>;
}

export function VirtualSubagentChildList({
  children,
  ariaLabel,
  renderChild,
  onSelect
}: {
  readonly children: readonly SubagentChildRunView[];
  readonly ariaLabel: string;
  readonly renderChild: (child: SubagentChildRunView) => ReactNode;
  readonly onSelect: (childId: string) => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: children.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CHILD_ROW_ESTIMATE_PX,
    overscan: 8,
    getItemKey: (index) => children[index]?.id ?? index,
    initialRect: { width: DEFAULT_VIEWPORT_RECT.width, height: 320 },
    observeElementRect: observeCompactViewportRect,
    scrollToFn: scrollSubagentElement,
    measureElement: (element) => element.getBoundingClientRect().height || CHILD_ROW_ESTIMATE_PX
  });
  return <div ref={scrollRef} className="subagent-children" role="list" aria-label={ariaLabel}>
    <div className="subagent-children__virtual" style={{ height: `${virtualizer.getTotalSize()}px` }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const child = children[virtualRow.index];
        if (child === undefined) return null;
        return <div
          key={child.id}
          ref={virtualizer.measureElement}
          data-index={virtualRow.index}
          role="listitem"
          className="subagent-children__row"
          style={{ transform: `translateY(${virtualRow.start}px)` }}
        ><button type="button" onClick={() => onSelect(child.id)}>{renderChild(child)}</button></div>;
      })}
    </div>
  </div>;
}

export function VirtualSubagentConversation({
  scopeKey,
  items,
  locale,
  t,
  toolExpansion,
  onToolExpansion
}: {
  readonly scopeKey: string;
  readonly items: readonly SubagentConversationItem[];
  readonly locale: string;
  readonly t: Translator;
  readonly toolExpansion: Readonly<Record<string, boolean>>;
  readonly onToolExpansion: (itemId: string, expanded: boolean) => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const previousScrollTopRef = useRef(0);
  const programmaticScrollUntilRef = useRef(0);
  const touchYRef = useRef<number | undefined>(undefined);
  const anchorRef = useRef<SubagentVirtualAnchor | undefined>(undefined);
  const restoreAnchorRef = useRef<SubagentVirtualAnchor | undefined>(undefined);
  const pendingFocusRef = useRef<SubagentVirtualAnchor | undefined>(undefined);
  const knownItemIdsRef = useRef<ReadonlySet<string>>(new Set(items.map((item) => item.id)));
  const previousItemsRef = useRef(items);
  const [following, setFollowing] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const reducedMotion = usePrefersReducedMotion();
  const itemIds = useMemo(() => items.map((item) => item.id), [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateConversationItemHeight(items[index]),
    overscan: 10,
    getItemKey: (index) => items[index]?.id ?? index,
    initialRect: DEFAULT_VIEWPORT_RECT,
    observeElementRect: observeDefaultViewportRect,
    scrollToFn: scrollSubagentElement,
    measureElement: (element) => element.getBoundingClientRect().height || estimateConversationItemHeight(items[Number(element.getAttribute("data-index"))])
  });
  const virtualRows = virtualizer.getVirtualItems();
  const renderedRowsKey = virtualRows.map((row) => row.key).join("\u0000");

  if (previousItemsRef.current !== items) {
    const root = scrollRef.current;
    if (!followingRef.current && anchorRef.current !== undefined) {
      const desired = anchorRef.current;
      const directIndex = itemIds.indexOf(desired.itemId);
      const index = directIndex >= 0
        ? directIndex
        : resolveSubagentAnchorIndex(itemIds, desired, previousItemsRef.current.map((item) => item.id));
      if (index !== undefined) {
        const itemId = itemIds[index];
        if (itemId !== undefined) {
          const resolved = { itemId, index, offset: desired.offset };
          anchorRef.current = resolved;
          restoreAnchorRef.current = resolved;
        }
      }
    }
    if (root !== null && root.contains(root.ownerDocument.activeElement)) pendingFocusRef.current = focusedConversationAnchor(root) ?? anchorRef.current;
    previousItemsRef.current = items;
  }

  const captureAnchor = useCallback((): void => {
    const root = scrollRef.current;
    if (root === null) return;
    const viewportTop = root.getBoundingClientRect().top;
    for (const row of root.querySelectorAll<HTMLElement>("[data-subagent-conversation-id]")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= viewportTop + 0.5) continue;
      const itemId = row.dataset.subagentConversationId;
      const index = Number(row.dataset.index);
      if (itemId !== undefined && Number.isInteger(index)) anchorRef.current = { itemId, index, offset: rect.top - viewportTop };
      return;
    }
  }, []);

  const writeScrollTop = useCallback((top: number, behavior: ScrollBehavior = "auto"): void => {
    const root = scrollRef.current;
    if (root === null) return;
    programmaticScrollUntilRef.current = performance.now() + (behavior === "smooth" ? 500 : 60);
    if (typeof root.scrollTo === "function") root.scrollTo({ top, behavior });
    else root.scrollTop = top;
    previousScrollTopRef.current = root.scrollTop;
    scheduleFrame(captureAnchor);
  }, [captureAnchor]);

  const pinToLatest = useCallback((behavior: ScrollBehavior = "auto"): void => {
    const root = scrollRef.current;
    if (root === null || items.length === 0) return;
    programmaticScrollUntilRef.current = performance.now() + (behavior === "smooth" ? 500 : 60);
    virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    scheduleFrame(() => writeScrollTop(Math.max(0, root.scrollHeight - root.clientHeight), behavior));
  }, [items.length, virtualizer, writeScrollTop]);

  const setFollowingState = useCallback((next: boolean): void => {
    followingRef.current = next;
    setFollowing(next);
    if (next) setUnreadCount(0);
  }, []);

  useLayoutEffect(() => {
    const added = countUnreadSubagentItems(knownItemIdsRef.current, itemIds, anchorRef.current);
    knownItemIdsRef.current = new Set(itemIds);
    if (followingRef.current) {
      setUnreadCount(0);
      pinToLatest();
      return;
    }
    if (added > 0) {
      setUnreadCount((current) => {
        const next = current + added;
        setAnnouncement(`${t("a11y.newActivity")} (${next})`);
        return next;
      });
    }
  }, [itemIds, pinToLatest, t]);

  useLayoutEffect(() => {
    const desired = restoreAnchorRef.current;
    const root = scrollRef.current;
    if (desired === undefined || root === null) return;
    const index = resolveSubagentAnchorIndex(itemIds, desired);
    if (index === undefined) {
      restoreAnchorRef.current = undefined;
      return;
    }
    virtualizer.scrollToIndex(index, { align: "start" });
    let attempts = 0;
    const align = (): void => {
      const current = scrollRef.current;
      if (current === null) return;
      const row = [...current.querySelectorAll<HTMLElement>("[data-subagent-conversation-id]")]
        .find((candidate) => Number(candidate.dataset.index) === index);
      if (row === undefined && attempts < 3) {
        attempts += 1;
        scheduleFrame(align);
        return;
      }
      if (row === undefined) return;
      const itemId = itemIds[index];
      if (itemId === undefined) return;
      const currentOffset = row.getBoundingClientRect().top - current.getBoundingClientRect().top;
      restoreAnchorRef.current = undefined;
      anchorRef.current = { itemId, index, offset: desired.offset };
      writeScrollTop(Math.max(0, current.scrollTop + currentOffset - desired.offset));
    };
    scheduleFrame(align);
  }, [itemIds, renderedRowsKey, virtualizer, writeScrollTop]);

  useLayoutEffect(() => {
    const desired = pendingFocusRef.current;
    const root = scrollRef.current;
    if (desired === undefined || root === null) return;
    if (root.contains(root.ownerDocument.activeElement)) {
      pendingFocusRef.current = undefined;
      return;
    }
    const index = resolveSubagentAnchorIndex(itemIds, desired);
    if (index === undefined) {
      pendingFocusRef.current = undefined;
      return;
    }
    virtualizer.scrollToIndex(index, { align: "auto" });
    let attempts = 0;
    const focus = (): void => {
      const current = scrollRef.current;
      const row = current === null ? undefined : [...current.querySelectorAll<HTMLElement>("[data-subagent-conversation-id]")]
        .find((candidate) => Number(candidate.dataset.index) === index);
      if (row === undefined && attempts < 3) {
        attempts += 1;
        scheduleFrame(focus);
        return;
      }
      pendingFocusRef.current = undefined;
      row?.focus({ preventScroll: true });
    };
    scheduleFrame(focus);
  }, [itemIds, renderedRowsKey, virtualizer]);

  useEffect(() => {
    setFollowingState(true);
    knownItemIdsRef.current = new Set(itemIds);
    anchorRef.current = undefined;
    restoreAnchorRef.current = undefined;
    pendingFocusRef.current = undefined;
    setAnnouncement("");
    pinToLatest();
  }, [scopeKey]);

  const detach = (): void => {
    if (followingRef.current) setFollowingState(false);
    captureAnchor();
  };
  const onScroll = (): void => {
    const root = scrollRef.current;
    if (root === null) return;
    const currentScrollTop = root.scrollTop;
    const scrollDelta = currentScrollTop - previousScrollTopRef.current;
    previousScrollTopRef.current = currentScrollTop;
    if (performance.now() < programmaticScrollUntilRef.current) {
      captureAnchor();
      return;
    }
    const next = resolveSubagentFollowingOnScroll({
      distanceFromEnd: root.scrollHeight - currentScrollTop - root.clientHeight,
      scrollDelta
    });
    if (next !== followingRef.current) setFollowingState(next);
    captureAnchor();
  };

  return <div className="subagent-conversation-shell">
    <div
      ref={scrollRef}
      className="subagent-conversation"
      role="list"
      aria-label={t("subagents.transcript")}
      tabIndex={0}
      onScroll={onScroll}
      onWheel={(event) => { if (event.deltaY < 0 && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) detach(); }}
      onKeyDown={(event) => {
        if (!SUBAGENT_UP_NAVIGATION_KEYS.has(event.key) || isEditableTarget(event.target)) return;
        detach();
      }}
      onTouchStart={(event) => { touchYRef.current = event.touches[0]?.clientY; }}
      onTouchMove={(event) => {
        const nextY = event.touches[0]?.clientY;
        if (nextY !== undefined && touchYRef.current !== undefined && nextY > touchYRef.current + 8) {
          touchYRef.current = nextY;
          detach();
        }
      }}
      onTouchEnd={() => { touchYRef.current = undefined; }}
      onTouchCancel={() => { touchYRef.current = undefined; }}
      onPointerUp={() => { if (hasSelectionWithin(scrollRef.current)) detach(); }}
    >
      <div className="subagent-conversation__virtual" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualRows.map((virtualRow) => {
          const item = items[virtualRow.index];
          if (item === undefined) return null;
          const toolOpen = item.kind === "tool" ? toolExpansion[item.id] ?? item.isError : false;
          return <div
            key={item.id}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            data-subagent-conversation-id={item.id}
            className="subagent-conversation__row"
            role="listitem"
            tabIndex={-1}
            aria-posinset={virtualRow.index + 1}
            aria-setsize={items.length}
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >{item.kind === "tool"
            ? <details
                className={cx("subagent-tool", item.isError && "is-error")}
                open={toolOpen}
              >
                <summary onClick={(event) => { event.preventDefault(); onToolExpansion(item.id, !toolOpen); }}><Wrench aria-hidden="true" /><strong>{item.summary || item.toolName || t("subagents.tool")}</strong>{!item.done && <Spinner label={t("subagents.toolRunning")} />}{item.done && <ChevronDown aria-hidden="true" />}</summary>
                <div>{item.inputJson !== undefined && <section><strong>{t("subagents.toolInput")}</strong><pre>{item.inputJson}</pre></section>}{item.result !== undefined && <section><strong>{item.isError ? t("subagents.toolError") : t("subagents.toolResult")}</strong><pre>{item.result}</pre></section>}{item.inputJson === undefined && item.result === undefined && <p>{t("subagents.toolNoDetails")}</p>}</div>
              </details>
            : <article className={`subagent-message subagent-message--${item.kind}`}>{item.controlAction !== undefined && <Pill>{controlActionLabel(item.controlAction, t)}</Pill>}<StreamingMarkdown text={item.content} streaming={false} t={t} /><time>{formatDateTime(item.occurredAt, locale)}</time></article>}
          </div>;
        })}
      </div>
    </div>
    {!following && <Button className="subagent-conversation__jump" tone="secondary" aria-label={unreadCount > 0 ? `${t("timeline.jumpLatest")} (${unreadCount})` : t("timeline.jumpLatest")} onClick={() => { setFollowingState(true); pinToLatest(reducedMotion ? "auto" : "smooth"); }}>
      <ChevronDown aria-hidden="true" />{t("timeline.jumpLatest")}{unreadCount > 0 && <span>{unreadCount}</span>}
    </Button>}
    <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
  </div>;
}

type TechnicalItem =
  | { readonly kind: "activity"; readonly id: string; readonly value: SubagentRunDetailView["activity"][number] }
  | { readonly kind: "system"; readonly id: string; readonly value: SubagentTranscriptEntryView };

export function VirtualSubagentTechnicalDetails({
  activity,
  system,
  showActivity,
  locale,
  t
}: {
  readonly activity: readonly SubagentRunDetailView["activity"][number][];
  readonly system: readonly SubagentTranscriptEntryView[];
  readonly showActivity: boolean;
  readonly locale: string;
  readonly t: Translator;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const items = useMemo<readonly TechnicalItem[]>(() => [
    ...(showActivity ? activity.map((value) => ({ kind: "activity" as const, id: `activity:${value.sequence}`, value })) : []),
    ...system.map((value) => ({ kind: "system" as const, id: `system:${value.id}`, value }))
  ], [activity, showActivity, system]);
  return <details className="subagent-technical" open={open}>
    <summary onClick={(event) => { event.preventDefault(); setOpen((current) => !current); }}><Terminal aria-hidden="true" />{t("subagents.technicalDetails")}<ChevronDown aria-hidden="true" /></summary>
    {open && <VirtualTechnicalList items={items} locale={locale} t={t} />}
  </details>;
}

function VirtualTechnicalList({ items, locale, t }: {
  readonly items: readonly TechnicalItem[];
  readonly locale: string;
  readonly t: Translator;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TECHNICAL_ROW_ESTIMATE_PX,
    overscan: 8,
    getItemKey: (index) => items[index]?.id ?? index,
    initialRect: { width: DEFAULT_VIEWPORT_RECT.width, height: 320 },
    observeElementRect: observeCompactViewportRect,
    scrollToFn: scrollSubagentElement,
    measureElement: (element) => element.getBoundingClientRect().height || TECHNICAL_ROW_ESTIMATE_PX
  });
  if (items.length === 0) return <p className="subagent-technical__empty">{t("subagents.noTechnicalDetails")}</p>;
  return <div ref={scrollRef} className="subagent-technical__viewport" role="list">
    <div className="subagent-technical__virtual" style={{ height: `${virtualizer.getTotalSize()}px` }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index];
        if (item === undefined) return null;
        return <p
          key={item.id}
          ref={virtualizer.measureElement}
          data-index={virtualRow.index}
          role="listitem"
          className="subagent-technical__row"
          style={{ transform: `translateY(${virtualRow.start}px)` }}
        >{item.kind === "activity"
          ? <><time>{formatDateTime(item.value.occurredAt, locale)}</time><strong>{t(`subagents.activity.${item.value.kind}` as MessageKey)}</strong><span>{item.value.summary ?? item.value.lastToolName ?? item.value.state}</span></>
          : <><time>{formatDateTime(item.value.occurredAt, locale)}</time><strong>{item.value.childTitle ?? t("subagents.system")}</strong><span>{localizeSubagentSystemEntry(item.value, t)}</span></>}
        </p>;
      })}
    </div>
  </div>;
}

function estimateConversationItemHeight(item: SubagentConversationItem | undefined): number {
  if (item === undefined) return 72;
  if (item.kind === "tool") {
    const contentLength = (item.inputJson?.length ?? 0) + (item.result?.length ?? 0);
    return item.isError ? Math.min(520, 74 + Math.ceil(contentLength / 96) * 15) : 52;
  }
  return Math.min(520, 62 + Math.ceil(item.content.length / 88) * 18);
}

function focusedConversationAnchor(root: HTMLElement): SubagentVirtualAnchor | undefined {
  const active = root.ownerDocument.activeElement;
  if (!(active instanceof HTMLElement)) return undefined;
  const row = active.closest<HTMLElement>("[data-subagent-conversation-id]");
  const itemId = row?.dataset.subagentConversationId;
  const index = Number(row?.dataset.index);
  if (itemId === undefined || !Number.isInteger(index) || row === null) return undefined;
  return { itemId, index, offset: row.getBoundingClientRect().top - root.getBoundingClientRect().top };
}

function hasSelectionWithin(root: HTMLElement | null): boolean {
  if (root === null) return false;
  const selection = root.ownerDocument.getSelection();
  if (selection === null || selection.isCollapsed || selection.anchorNode === null) return false;
  return root.contains(selection.anchorNode);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
}

function controlActionLabel(action: "stop" | "steer" | "followUp" | "resume", t: Translator): string {
  if (action === "stop") return t("common.stop");
  if (action === "steer") return t("subagents.steer");
  if (action === "followUp") return t("subagents.followUp");
  return t("subagents.resume");
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (query === undefined) return;
    const update = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function observeElementRectWithFallback(fallback: Rect) {
  return <TScrollElement extends Element, TItemElement extends Element>(
    instance: Virtualizer<TScrollElement, TItemElement>,
    callback: (rect: Rect) => void
  ): (() => void) | undefined => {
    const element = instance.scrollElement;
    if (!(element instanceof HTMLElement)) return undefined;
    const report = (): void => {
      const rect = element.getBoundingClientRect();
      callback({
        width: Math.round(rect.width || element.clientWidth || fallback.width),
        height: Math.round(rect.height || element.clientHeight || fallback.height)
      });
    };
    report();
    const ResizeObserverConstructor = element.ownerDocument.defaultView?.ResizeObserver;
    if (ResizeObserverConstructor === undefined) return () => undefined;
    const observer = new ResizeObserverConstructor(report);
    observer.observe(element);
    return () => observer.disconnect();
  };
}

function scrollSubagentElement<TScrollElement extends Element, TItemElement extends Element>(
  offset: number,
  options: { readonly adjustments?: number; readonly behavior?: "auto" | "smooth" },
  instance: Virtualizer<TScrollElement, TItemElement>
): void {
  const element = instance.scrollElement;
  if (!(element instanceof HTMLElement)) return;
  const target = offset + (options.adjustments ?? 0);
  const horizontal = instance.options.horizontal;
  const rect = element.getBoundingClientRect();
  const lacksLayout = horizontal
    ? rect.width === 0 && element.clientWidth === 0
    : rect.height === 0 && element.clientHeight === 0;
  if (!lacksLayout && typeof element.scrollTo === "function") {
    element.scrollTo({ [horizontal ? "left" : "top"]: target, behavior: options.behavior });
    return;
  }
  if (horizontal) element.scrollLeft = target;
  else element.scrollTop = target;
  const EventConstructor = element.ownerDocument.defaultView?.Event;
  if (EventConstructor !== undefined) queueMicrotask(() => element.dispatchEvent(new EventConstructor("scroll")));
}

function scheduleFrame(callback: FrameRequestCallback | (() => void)): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback as FrameRequestCallback);
  return window.setTimeout(() => callback(performance.now()), 0);
}
