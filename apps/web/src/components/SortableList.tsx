import { useEffect, useMemo, useRef, type AriaRole, type JSX, type ReactNode } from "react";
import Sortable, { type SortableEvent } from "sortablejs";

export interface SortableListProps<T> {
  readonly items: readonly T[];
  readonly getId: (item: T) => string;
  readonly onReorder: (newOrderIds: readonly string[]) => void;
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly disabled?: boolean;
  readonly reducedMotion?: boolean;
  readonly handle?: string;
  readonly filter?: string;
  readonly className?: string;
  readonly rowClassName?: string;
  readonly role?: AriaRole;
  readonly ariaLabel?: string;
}

const DEFAULT_FILTER = "button, input, textarea, select, a, [data-no-drag]";
const SORTING_BODY_CLASS = "sidebar-is-sorting";

/** SortableJS ownership boundary. Sortable animates the gesture, then
 * this component restores the pre-drag DOM before publishing IDs so React is
 * the only writer of the committed child order. */
export function SortableList<T>({
  items,
  getId,
  onReorder,
  renderItem,
  disabled = false,
  reducedMotion = false,
  handle,
  filter,
  className,
  rowClassName,
  role,
  ariaLabel
}: SortableListProps<T>): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sortableRef = useRef<Sortable | null>(null);
  const itemsRef = useRef(items);
  const getIdRef = useRef(getId);
  const onReorderRef = useRef(onReorder);
  const abortNextEndRef = useRef(false);
  itemsRef.current = items;
  getIdRef.current = getId;
  onReorderRef.current = onReorder;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const sortable = Sortable.create(container, {
      animation: reducedMotion ? 0 : 150,
      disabled,
      handle,
      filter: filter ?? DEFAULT_FILTER,
      preventOnFilter: false,
      ghostClass: "sidebar-sortable-ghost",
      chosenClass: "",
      dragClass: "sidebar-sortable-drag",
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 4,
      setData: (dataTransfer, dragElement) => {
        // Never place task titles or project names on the OS drag clipboard.
        dataTransfer.setData("Text", "");
        const rect = dragElement.getBoundingClientRect();
        dataTransfer.setDragImage(
          dragElement,
          Math.min(24, Math.max(0, rect.width / 2)),
          Math.min(24, Math.max(0, rect.height / 2))
        );
      },
      onStart: () => document.body.classList.add(SORTING_BODY_CLASS),
      onEnd: (event: SortableEvent) => {
        document.body.classList.remove(SORTING_BODY_CLASS);
        const aborted = abortNextEndRef.current;
        abortNextEndRef.current = false;
        const oldIndex = event.oldIndex;
        const newIndex = event.newIndex;

        restoreSortableDom(event);
        if (aborted || oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) return;
        const nextIds = reorderedSortableIds(itemsRef.current, getIdRef.current, oldIndex, newIndex);
        if (nextIds !== undefined) onReorderRef.current(nextIds);
      }
    });
    sortableRef.current = sortable;

    const abortIfActive = (): void => {
      if (Sortable.active !== sortable) return;
      abortNextEndRef.current = true;
      document.dispatchEvent(new Event("pointercancel"));
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") abortIfActive();
    };
    window.addEventListener("blur", abortIfActive);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", abortIfActive);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.body.classList.remove(SORTING_BODY_CLASS);
      sortable.destroy();
      sortableRef.current = null;
    };
    // The instance is intentionally stable. Live callbacks and item data flow
    // through refs, while mutable options are synchronized below.
  }, []);

  useEffect(() => {
    const sortable = sortableRef.current;
    if (sortable === null) return;
    sortable.option("disabled", disabled);
    sortable.option("animation", reducedMotion ? 0 : 150);
    sortable.option("handle", handle ?? "");
    sortable.option("filter", filter ?? DEFAULT_FILTER);
  }, [disabled, filter, handle, reducedMotion]);

  const children = useMemo(() => items.map((item, index) => {
    const id = getId(item);
    return <div
      className={rowClassName === undefined ? "sidebar-sortable-row" : `sidebar-sortable-row ${rowClassName}`}
      data-sortable-id={id}
      key={id}
    >{renderItem(item, index)}</div>;
  }), [getId, items, renderItem, rowClassName]);

  return <div ref={containerRef} role={role} aria-label={ariaLabel} className={className}>{children}</div>;
}

export function reorderedSortableIds<T>(
  items: readonly T[],
  getId: (item: T) => string,
  oldIndex: number,
  newIndex: number
): readonly string[] | undefined {
  if (oldIndex < 0 || newIndex < 0 || oldIndex >= items.length || newIndex >= items.length) return undefined;
  const next = items.map(getId);
  const moved = next.splice(oldIndex, 1)[0];
  if (moved === undefined) return undefined;
  next.splice(newIndex, 0, moved);
  return next;
}

function restoreSortableDom(event: SortableEvent): void {
  const oldIndex = event.oldIndex;
  const parent = event.from;
  if (oldIndex === undefined || parent === undefined || event.item === undefined) return;
  event.item.parentNode?.removeChild(event.item);
  parent.insertBefore(event.item, parent.children[oldIndex] ?? null);
}
