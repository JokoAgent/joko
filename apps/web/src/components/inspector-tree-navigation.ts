import { useLayoutEffect, useRef } from "react";
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject
} from "react";

export interface InspectorTreeNavigationOptions {
  readonly treeRef?: RefObject<HTMLDivElement | null>;
  readonly itemCount?: number;
  readonly onRequestItem?: (index: number) => void;
}

export interface InspectorTreeNavigationBindings {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly onFocusCapture: (event: ReactFocusEvent<HTMLDivElement>) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

/**
 * One keyboard contract for the Inspector's hierarchical views. Tree items own
 * the roving tab stop; their primary/toggle controls stay pointer-accessible,
 * while explicitly marked secondary actions retain their normal Tab stop.
 */
export function useInspectorTreeNavigation(
  options: InspectorTreeNavigationOptions = {}
): InspectorTreeNavigationBindings {
  const ownedRef = useRef<HTMLDivElement>(null);
  const ref = options.treeRef ?? ownedRef;
  const activeKeyRef = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    const tree = ref.current;
    if (tree === null) return;
    synchronizeTreeTabStops(tree, activeKeyRef.current);
  });

  const focusItem = (tree: HTMLDivElement, item: HTMLElement): void => {
    activeKeyRef.current = inspectorTreeItemKey(tree, item);
    setActiveTreeItem(tree, item);
    item.focus({ preventScroll: true });
    item.scrollIntoView?.({ block: "nearest" });
  };

  const focusIndex = (tree: HTMLDivElement, index: number): void => {
    const mounted = inspectorTreeItems(tree).find((item) => treeItemIndex(item) === index);
    if (mounted !== undefined) {
      focusItem(tree, mounted);
      return;
    }
    options.onRequestItem?.(index);
    const ownerWindow = tree.ownerDocument.defaultView;
    const schedule = ownerWindow?.requestAnimationFrame.bind(ownerWindow)
      ?? ((callback: FrameRequestCallback) => globalThis.setTimeout(callback, 0));
    let attempts = 2;
    const finish = (): void => {
      if (!tree.isConnected) return;
      const item = inspectorTreeItems(tree).find((candidate) => treeItemIndex(candidate) === index);
      if (item !== undefined) {
        focusItem(tree, item);
        return;
      }
      attempts -= 1;
      if (attempts > 0) schedule(finish);
    };
    schedule(finish);
  };

  return {
    ref,
    onFocusCapture: (event) => {
      const tree = ref.current;
      const item = treeItemForTarget(tree, event.target);
      if (tree === null || item === undefined) return;
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      if (target !== item && target?.hasAttribute("data-inspector-tree-secondary-action") !== true) {
        focusItem(tree, item);
        return;
      }
      if (target === item) {
        activeKeyRef.current = inspectorTreeItemKey(tree, item);
        setActiveTreeItem(tree, item);
      }
    },
    onKeyDown: (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
      const tree = ref.current;
      const item = treeItemForTarget(tree, event.target);
      if (tree === null || item === undefined || event.target !== item) return;
      const items = inspectorTreeItems(tree);
      const mountedIndex = items.indexOf(item);
      if (mountedIndex < 0) return;

      const indexed = treeItemIndex(item);
      const total = Math.max(options.itemCount ?? items.length, items.length);
      let next: HTMLElement | undefined;
      let requestedIndex: number | undefined;
      if (event.key === "ArrowDown") {
        if (indexed !== undefined && indexed + 1 < total) requestedIndex = indexed + 1;
        else next = items[mountedIndex + 1];
      } else if (event.key === "ArrowUp") {
        if (indexed !== undefined && indexed > 0) requestedIndex = indexed - 1;
        else next = items[mountedIndex - 1];
      } else if (event.key === "Home") {
        if (indexed !== undefined) requestedIndex = 0;
        else next = items[0];
      } else if (event.key === "End") {
        if (indexed !== undefined) requestedIndex = total - 1;
        else next = items.at(-1);
      } else if (event.key === "ArrowRight") {
        if (item.getAttribute("aria-expanded") === "false") {
          event.preventDefault();
          treeItemToggle(item)?.click();
          return;
        }
        if (item.getAttribute("aria-expanded") !== "true") return;
        const firstChildIndex = dataIndex(item, "inspectorTreeFirstChildIndex");
        if (firstChildIndex !== undefined) requestedIndex = firstChildIndex;
        else {
          const candidate = items[mountedIndex + 1];
          if (candidate !== undefined && treeItemLevel(candidate) > treeItemLevel(item)) next = candidate;
        }
      } else if (event.key === "ArrowLeft") {
        if (item.getAttribute("aria-expanded") === "true") {
          event.preventDefault();
          treeItemToggle(item)?.click();
          return;
        }
        const parentIndex = dataIndex(item, "inspectorTreeParentIndex");
        if (parentIndex !== undefined) requestedIndex = parentIndex;
        else {
          const level = treeItemLevel(item);
          for (let index = mountedIndex - 1; index >= 0; index -= 1) {
            if (treeItemLevel(items[index]!) < level) {
              next = items[index];
              break;
            }
          }
        }
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        treeItemPrimaryAction(item).click();
        return;
      } else {
        return;
      }

      if (requestedIndex === undefined && next === undefined) return;
      event.preventDefault();
      if (requestedIndex !== undefined) focusIndex(tree, requestedIndex);
      else if (next !== undefined) focusItem(tree, next);
    }
  };
}

export function inspectorTreeItems(tree: HTMLElement): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    .filter((item) => item.closest('[role="tree"]') === tree);
}

function synchronizeTreeTabStops(tree: HTMLDivElement, activeKey: string | undefined): void {
  const items = inspectorTreeItems(tree);
  const active = items.find((item) => inspectorTreeItemKey(tree, item) === activeKey)
    ?? items.find((item) => item.getAttribute("aria-selected") === "true" || item.getAttribute("aria-current") === "true")
    ?? items[0];
  setActiveTreeItem(tree, active);
}

function setActiveTreeItem(tree: HTMLDivElement, active: HTMLElement | undefined): void {
  for (const item of inspectorTreeItems(tree)) {
    item.tabIndex = item === active ? 0 : -1;
    for (const control of item.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]'
    )) {
      if (control.closest('[role="treeitem"]') !== item) continue;
      if (control.hasAttribute("data-inspector-tree-secondary-action")) continue;
      control.tabIndex = -1;
    }
  }
}

function treeItemForTarget(tree: HTMLDivElement | null, target: EventTarget): HTMLElement | undefined {
  if (tree === null || !(target instanceof Element)) return undefined;
  const item = target.closest<HTMLElement>('[role="treeitem"]');
  return item?.closest('[role="tree"]') === tree ? item : undefined;
}

function inspectorTreeItemKey(tree: HTMLElement, item: HTMLElement): string {
  return item.dataset.inspectorTreeKey ?? String(inspectorTreeItems(tree).indexOf(item));
}

function treeItemIndex(item: HTMLElement): number | undefined {
  return dataIndex(item, "inspectorTreeIndex");
}

function dataIndex(item: HTMLElement, key: "inspectorTreeIndex" | "inspectorTreeParentIndex" | "inspectorTreeFirstChildIndex"): number | undefined {
  const raw = item.dataset[key];
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function treeItemLevel(item: HTMLElement): number {
  const level = Number.parseInt(item.getAttribute("aria-level") ?? "1", 10);
  return Number.isSafeInteger(level) && level > 0 ? level : 1;
}

function treeItemToggle(item: HTMLElement): HTMLElement | undefined {
  if (item.hasAttribute("data-inspector-tree-toggle")) return item;
  return item.querySelector<HTMLElement>("[data-inspector-tree-toggle]") ?? undefined;
}

function treeItemPrimaryAction(item: HTMLElement): HTMLElement {
  if (item instanceof HTMLButtonElement || item instanceof HTMLAnchorElement) return item;
  return item.querySelector<HTMLElement>("[data-inspector-tree-primary]") ?? item;
}
