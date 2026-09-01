import { useCallback, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { GripVertical } from "lucide-react";

import { moveProviderDisplayOrder } from "../provider-display-order.js";
import { SortableList } from "./SortableList.js";
import { IconButton } from "./ui.js";

export interface ProviderOrderListItem {
  readonly id: string;
  readonly name: string;
}

export interface ProviderOrderListLabels {
  readonly list: string;
  readonly reorder: (providerName: string) => string;
  readonly moved: (providerName: string, position: number, total: number) => string;
  readonly changed: string;
}

export function ProviderOrderList<T extends ProviderOrderListItem>({
  items,
  labels,
  onReorder,
  renderItem,
  reducedMotion = false,
  disabled = false
}: {
  readonly items: readonly T[];
  readonly labels: ProviderOrderListLabels;
  readonly onReorder: (ids: readonly string[]) => void;
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly reducedMotion?: boolean;
  readonly disabled?: boolean;
}): JSX.Element {
  const [announcement, setAnnouncement] = useState("");
  const publishDragOrder = useCallback((ids: readonly string[]): void => {
    onReorder(ids);
    setAnnouncement(labels.changed);
  }, [labels.changed, onReorder]);
  const moveWithKeyboard = useCallback((item: T, delta: -1 | 1): void => {
    const currentIds = items.map(({ id }) => id);
    const nextIds = moveProviderDisplayOrder(currentIds, item.id, delta);
    const currentIndex = currentIds.indexOf(item.id);
    const nextIndex = nextIds.indexOf(item.id);
    if (currentIndex === nextIndex) return;
    onReorder(nextIds);
    setAnnouncement(labels.moved(item.name, nextIndex + 1, items.length));
  }, [items, labels, onReorder]);

  return <>
    <SortableList
      items={items}
      getId={(item) => item.id}
      onReorder={publishDragOrder}
      disabled={disabled}
      reducedMotion={reducedMotion}
      handle=".provider-order-handle"
      filter="input, textarea, select, a, [data-no-drag]"
      className="provider-order-list"
      rowClassName="provider-order-list__row"
      role="list"
      ariaLabel={labels.list}
      renderItem={(item, index) => <div className="provider-order-list__item" role="listitem">
        <IconButton
          className="provider-order-handle"
          disabled={disabled}
          disabledReason={disabled ? labels.reorder(item.name) : undefined}
          label={labels.reorder(item.name)}
          onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            event.stopPropagation();
            moveWithKeyboard(item, event.key === "ArrowUp" ? -1 : 1);
          }}
        ><GripVertical aria-hidden="true" /></IconButton>
        <div className="provider-order-list__content">{renderItem(item, index)}</div>
      </div>}
    />
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </>;
}
