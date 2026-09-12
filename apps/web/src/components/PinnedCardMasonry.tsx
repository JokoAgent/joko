import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import Sortable, { type SortableEvent } from "sortablejs";

import { SortableList } from "./SortableList.js";

const MINIMUM_CARD_WIDTH = 108;
const COLUMN_GAP = 6;
const TWO_COLUMN_MIN_WIDTH = MINIMUM_CARD_WIDTH * 2 + COLUMN_GAP;
const THREE_COLUMN_MIN_WIDTH = MINIMUM_CARD_WIDTH * 3 + COLUMN_GAP * 2;
const DEFAULT_DRAG_FILTER = "input, textarea, select, a, .session-menu, [data-no-drag]";
const DRAG_GROUP_NAME = "joko-pinned-cards";
const SORTING_BODY_CLASS = "sidebar-is-sorting";

export interface PinnedCardMasonryProps<T> {
  readonly items: readonly T[];
  readonly getId: (item: T) => string;
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly onReorder: (newOrderIds: readonly string[]) => void;
  readonly reducedMotion: boolean;
  readonly isFullWidth?: (item: T) => boolean;
  readonly filter?: string;
  readonly ariaLabel?: string;
}

interface IndexedPinnedCard<T> {
  readonly item: T;
  readonly id: string;
  readonly index: number;
}

interface PinnedCardColumnSegment<T> {
  readonly kind: "columns";
  readonly start: number;
  readonly length: number;
  readonly dropZoneStart: number;
  readonly buckets: readonly (readonly IndexedPinnedCard<T>[])[];
}

interface PinnedCardWideSegment<T> {
  readonly kind: "wide";
  readonly card: IndexedPinnedCard<T>;
  readonly dropZone: number;
}

type PinnedCardSegment<T> = PinnedCardColumnSegment<T> | PinnedCardWideSegment<T>;

export type PinnedCardDropTarget = {
  readonly kind: "columns";
  readonly segmentStart: number;
  readonly segmentLength: number;
  readonly column: number;
  readonly row: number;
  readonly columns: number;
} | {
  readonly kind: "wide";
  readonly itemIndex: number;
  readonly row: number;
};

export function pinnedCardColumnCount(width: number): 1 | 2 | 3 {
  if (!Number.isFinite(width) || width < TWO_COLUMN_MIN_WIDTH) return 1;
  return width < THREE_COLUMN_MIN_WIDTH ? 2 : 3;
}

export function pinnedCardRowOrder(row: number, column: number, columns: number): number {
  return row * columns + column;
}

export function reorderPinnedCardsByDropSlot(
  currentOrder: readonly string[],
  movedId: string | null,
  targetColumn: number,
  targetRow: number,
  columns: number
): readonly string[] {
  return reorderPinnedCardsAtDrop(currentOrder, movedId, {
    kind: "columns",
    segmentStart: 0,
    segmentLength: currentOrder.length,
    column: targetColumn,
    row: targetRow,
    columns
  });
}

export function reorderPinnedCardsAtDrop(
  currentOrder: readonly string[],
  movedId: string | null,
  target: PinnedCardDropTarget | undefined
): readonly string[] {
  if (
    movedId === null
    || target === undefined
    || new Set(currentOrder).size !== currentOrder.length
    || currentOrder.filter((id) => id === movedId).length !== 1
  ) return [...currentOrder];

  const movedIndex = currentOrder.indexOf(movedId);
  const remaining = currentOrder.filter((id) => id !== movedId);
  let insertionIndex: number;
  if (target.kind === "wide") {
    if (
      !Number.isInteger(target.itemIndex)
      || target.itemIndex < 0
      || target.itemIndex >= currentOrder.length
      || !Number.isInteger(target.row)
      || target.row < 0
      || target.row > 1
      || movedIndex === target.itemIndex
    ) return [...currentOrder];
    const adjustedStart = target.itemIndex - (movedIndex < target.itemIndex ? 1 : 0);
    insertionIndex = adjustedStart + target.row;
  } else {
    if (
      !Number.isInteger(target.columns)
      || target.columns <= 0
      || !Number.isInteger(target.column)
      || target.column < 0
      || target.column >= target.columns
      || !Number.isInteger(target.row)
      || target.row < 0
      || !Number.isInteger(target.segmentStart)
      || !Number.isInteger(target.segmentLength)
      || target.segmentStart < 0
      || target.segmentLength < 1
      || target.segmentStart + target.segmentLength > currentOrder.length
    ) return [...currentOrder];
    const movedFromTargetSegment = movedIndex >= target.segmentStart
      && movedIndex < target.segmentStart + target.segmentLength;
    const adjustedStart = target.segmentStart - (movedIndex < target.segmentStart ? 1 : 0);
    const adjustedLength = target.segmentLength - (movedFromTargetSegment ? 1 : 0);
    const localInsertion = Math.min(target.row * target.columns + target.column, adjustedLength);
    insertionIndex = adjustedStart + localInsertion;
  }
  if (insertionIndex < 0 || insertionIndex > remaining.length) return [...currentOrder];
  return [...remaining.slice(0, insertionIndex), movedId, ...remaining.slice(insertionIndex)];
}

export function PinnedCardMasonry<T>({
  items,
  getId,
  renderItem,
  onReorder,
  reducedMotion,
  isFullWidth,
  filter = DEFAULT_DRAG_FILTER,
  ariaLabel
}: PinnedCardMasonryProps<T>): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState<1 | 2 | 3>(1);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const updateColumns = (): void => setColumns(pinnedCardColumnCount(container.clientWidth));
    updateColumns();

    const ownerWindow = container.ownerDocument.defaultView;
    const ResizeObserverConstructor = ownerWindow?.ResizeObserver ?? globalThis.ResizeObserver;
    if (ResizeObserverConstructor === undefined) return;
    const observer = new ResizeObserverConstructor(updateColumns);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef} className="pinned-card-masonry">
    <div
      className={reducedMotion ? "pinned-card-masonry__layout" : "pinned-card-masonry__layout is-animated"}
      data-pinned-card-column-count={columns}
      key={columns}
    >
      {columns === 1
        ? <SortableList
            items={items}
            getId={getId}
            onReorder={onReorder}
            renderItem={renderItem}
            reducedMotion={reducedMotion}
            filter={filter}
            className="session-section__sortable-sessions pinned-card-masonry__single"
            role="list"
            ariaLabel={ariaLabel}
          />
        : <PinnedCardColumns
            items={items}
            columns={columns}
            getId={getId}
            renderItem={renderItem}
            onReorder={onReorder}
            reducedMotion={reducedMotion}
            isFullWidth={isFullWidth}
            filter={filter}
            ariaLabel={ariaLabel}
          />}
    </div>
  </div>;
}

export interface PinnedCardColumnsProps<T> extends PinnedCardMasonryProps<T> {
  readonly columns: 2 | 3;
}

export function PinnedCardColumns<T>({
  items,
  columns,
  getId,
  renderItem,
  onReorder,
  reducedMotion,
  isFullWidth = () => false,
  filter = DEFAULT_DRAG_FILTER,
  ariaLabel
}: PinnedCardColumnsProps<T>): JSX.Element {
  const dropZoneRefs = useRef<Array<HTMLDivElement | null>>([]);
  const itemsRef = useRef(items);
  const getIdRef = useRef(getId);
  const onReorderRef = useRef(onReorder);
  const originalBucketsRef = useRef<readonly (readonly string[])[] | undefined>(undefined);
  const abortNextEndRef = useRef(false);
  const nativeDropRef = useRef<"internal" | "external" | undefined>(undefined);
  itemsRef.current = items;
  getIdRef.current = getId;
  onReorderRef.current = onReorder;

  const layout = useMemo(
    () => createPinnedCardLayout(items, columns, getId, isFullWidth),
    [columns, getId, isFullWidth, items]
  );

  useEffect(() => {
    const dropZones = dropZoneRefs.current
      .slice(0, layout.dropZoneCount)
      .filter((element): element is HTMLDivElement => element !== null);
    if (dropZones.length !== layout.dropZoneCount || dropZones.length === 0) return;
    const ownerDocument = dropZones[0]?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (ownerDocument === undefined) return;

    const onStart = (): void => {
      nativeDropRef.current = undefined;
      originalBucketsRef.current = readPinnedCardDropZoneIds(dropZones);
      ownerDocument.body.classList.add(SORTING_BODY_CLASS);
    };
    const onEnd = (event: SortableEvent): void => {
      ownerDocument.body.classList.remove(SORTING_BODY_CLASS);
      const aborted = abortNextEndRef.current;
      abortNextEndRef.current = false;
      const dropDisposition = nativeDropRef.current;
      nativeDropRef.current = undefined;

      const currentOrder = itemsRef.current.map(getIdRef.current);
      const movedId = event.item.dataset.pinnedCardId ?? null;
      const targetRow = event.newDraggableIndex ?? event.newIndex ?? -1;
      const nextOrder = reorderPinnedCardsAtDrop(
        currentOrder,
        movedId,
        readPinnedCardDropTarget(event.to, targetRow)
      );

      const originalBuckets = originalBucketsRef.current;
      originalBucketsRef.current = undefined;
      if (originalBuckets !== undefined) restorePinnedCardDropZoneDom(dropZones, originalBuckets, event.item);

      if (aborted || dropDisposition !== "internal" || sameOrder(currentOrder, nextOrder)) return;
      onReorderRef.current(nextOrder);
    };

    const instances = dropZones.map((element) => Sortable.create(element, {
      group: { name: DRAG_GROUP_NAME, pull: true, put: true },
      animation: reducedMotion ? 0 : 150,
      filter,
      preventOnFilter: false,
      ghostClass: "sidebar-sortable-ghost",
      chosenClass: "",
      dragClass: "sidebar-sortable-drag",
      fallbackOnBody: true,
      fallbackTolerance: 4,
      forceFallback: false,
      setData: (dataTransfer, dragElement) => {
        dataTransfer.setData("Text", "");
        const rect = dragElement.getBoundingClientRect();
        dataTransfer.setDragImage(
          dragElement,
          Math.min(24, Math.max(0, rect.width / 2)),
          Math.min(24, Math.max(0, rect.height / 2))
        );
      },
      onStart,
      onEnd
    }));

    const recordDropTarget = (event: Event): void => {
      const active = Sortable.active;
      if (active === null || !instances.includes(active)) return;
      const target = event.target;
      const NodeConstructor = ownerWindow?.Node;
      nativeDropRef.current = NodeConstructor !== undefined
        && target instanceof NodeConstructor
        && dropZones.some((dropZone) => dropZone.contains(target))
        ? "internal"
        : "external";
    };
    const abortIfActive = (): void => {
      const active = Sortable.active;
      if (active === null || !instances.includes(active)) return;
      abortNextEndRef.current = true;
      ownerDocument.dispatchEvent(new Event("pointercancel"));
    };
    const abortWhenHidden = (): void => {
      if (ownerDocument.visibilityState === "hidden") abortIfActive();
    };
    ownerDocument.addEventListener("drop", recordDropTarget, true);
    ownerWindow?.addEventListener("blur", abortIfActive);
    ownerDocument.addEventListener("visibilitychange", abortWhenHidden);
    return () => {
      ownerDocument.removeEventListener("drop", recordDropTarget, true);
      ownerWindow?.removeEventListener("blur", abortIfActive);
      ownerDocument.removeEventListener("visibilitychange", abortWhenHidden);
      ownerDocument.body.classList.remove(SORTING_BODY_CLASS);
      originalBucketsRef.current = undefined;
      nativeDropRef.current = undefined;
      for (const instance of instances) instance.destroy();
    };
  }, [filter, layout.dropZoneCount, layout.structureKey, reducedMotion]);

  return <div
    className="pinned-card-masonry__flow"
    data-sidebar-card-order="row-major"
    role="list"
    aria-label={ariaLabel}
  >
    {layout.segments.map((segment) => segment.kind === "wide"
      ? <div
          className="pinned-card-masonry__wide-lane"
          data-pinned-card-drop-kind="wide"
          data-pinned-card-item-index={segment.card.index}
          data-sortable-native-dnd="true"
          ref={(element) => { dropZoneRefs.current[segment.dropZone] = element; }}
          key={`wide:${segment.card.id}`}
        >
          <PinnedCardWrapper card={segment.card} renderItem={renderItem} wide />
        </div>
      : <div className="pinned-card-masonry__columns" key={`columns:${segment.start}`}>
          {segment.buckets.map((bucket, column) => <div
            className="pinned-card-masonry__column"
            data-pinned-card-drop-kind="columns"
            data-pinned-card-segment-start={segment.start}
            data-pinned-card-segment-length={segment.length}
            data-pinned-card-column={column}
            data-pinned-card-columns={columns}
            data-sortable-native-dnd="true"
            ref={(element) => { dropZoneRefs.current[segment.dropZoneStart + column] = element; }}
            key={column}
          >
            {bucket.map((card) => <PinnedCardWrapper card={card} renderItem={renderItem} key={card.id} />)}
          </div>)}
        </div>)}
  </div>;
}

function PinnedCardWrapper<T>({ card, renderItem, wide = false }: {
  readonly card: IndexedPinnedCard<T>;
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly wide?: boolean;
}): JSX.Element {
  return <div
    className={wide
      ? "sidebar-sortable-row pinned-card-masonry__card pinned-card-masonry__card--wide"
      : "sidebar-sortable-row pinned-card-masonry__card"}
    data-pinned-card-id={card.id}
    data-sortable-id={card.id}
    data-sidebar-row-order={card.index}
  >{renderItem(card.item, card.index)}</div>;
}

function createPinnedCardLayout<T>(
  items: readonly T[],
  columns: 2 | 3,
  getId: (item: T) => string,
  isFullWidth: (item: T) => boolean
): { readonly segments: readonly PinnedCardSegment<T>[]; readonly dropZoneCount: number; readonly structureKey: string } {
  const segments: PinnedCardSegment<T>[] = [];
  let pending: IndexedPinnedCard<T>[] = [];
  let dropZoneCount = 0;
  const flushPending = (): void => {
    const first = pending[0];
    if (first === undefined) return;
    const buckets = Array.from({ length: columns }, (): IndexedPinnedCard<T>[] => []);
    pending.forEach((card, localIndex) => buckets[localIndex % columns]?.push(card));
    segments.push({
      kind: "columns",
      start: first.index,
      length: pending.length,
      dropZoneStart: dropZoneCount,
      buckets
    });
    dropZoneCount += columns;
    pending = [];
  };
  items.forEach((item, index) => {
    const card = { item, id: getId(item), index };
    if (!isFullWidth(item)) {
      pending.push(card);
      return;
    }
    flushPending();
    segments.push({ kind: "wide", card, dropZone: dropZoneCount });
    dropZoneCount += 1;
  });
  flushPending();
  return {
    segments,
    dropZoneCount,
    structureKey: segments.map((segment) => segment.kind === "wide"
      ? `w:${segment.card.index}:${segment.card.id}`
      : `c:${segment.start}:${segment.length}`).join("|")
  };
}

function readPinnedCardDropZoneIds(dropZones: readonly HTMLElement[]): readonly (readonly string[])[] {
  return dropZones.map((dropZone) => [...dropZone.children].flatMap((child) => {
    if (!(child instanceof HTMLElement)) return [];
    const id = child.dataset.pinnedCardId;
    return id === undefined || id === "" ? [] : [id];
  }));
}

function readPinnedCardDropTarget(dropZone: HTMLElement, row: number): PinnedCardDropTarget | undefined {
  const kind = dropZone.dataset.pinnedCardDropKind;
  if (kind === "wide") {
    const itemIndex = parseDatasetInteger(dropZone.dataset.pinnedCardItemIndex);
    return itemIndex === undefined ? undefined : { kind, itemIndex, row };
  }
  if (kind !== "columns") return undefined;
  const segmentStart = parseDatasetInteger(dropZone.dataset.pinnedCardSegmentStart);
  const segmentLength = parseDatasetInteger(dropZone.dataset.pinnedCardSegmentLength);
  const column = parseDatasetInteger(dropZone.dataset.pinnedCardColumn);
  const columns = parseDatasetInteger(dropZone.dataset.pinnedCardColumns);
  return segmentStart === undefined || segmentLength === undefined || column === undefined || columns === undefined
    ? undefined
    : { kind, segmentStart, segmentLength, column, row, columns };
}

function parseDatasetInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function restorePinnedCardDropZoneDom(
  dropZones: readonly HTMLElement[],
  originalBuckets: readonly (readonly string[])[],
  movedItem?: HTMLElement
): void {
  const nodesById = new Map<string, HTMLElement>();
  for (const dropZone of dropZones) {
    for (const child of dropZone.children) {
      if (child instanceof HTMLElement && child.dataset.pinnedCardId !== undefined) {
        nodesById.set(child.dataset.pinnedCardId, child);
      }
    }
  }
  if (movedItem?.dataset.pinnedCardId !== undefined) nodesById.set(movedItem.dataset.pinnedCardId, movedItem);
  originalBuckets.forEach((bucket, dropZoneIndex) => {
    const dropZone = dropZones[dropZoneIndex];
    if (dropZone === undefined) return;
    for (const id of bucket) {
      const node = nodesById.get(id);
      if (node !== undefined) dropZone.appendChild(node);
    }
  });
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
