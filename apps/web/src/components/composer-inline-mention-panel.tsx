import { useEffect, useId, useRef, type JSX } from "react";
import { X } from "lucide-react";
import type {
  ComposerMentionCatalogItem,
  ComposerMentionProviderState,
  ComposerMentionResults
} from "./composer-inline-mention.js";
import { IconButton, cx } from "./ui.js";

export function ComposerInlineMentionPanel({
  title,
  query,
  state,
  results,
  activeIndex,
  labels,
  onActiveIndexChange,
  onSelect,
  onClose,
  onRetry,
  embedded = false
}: {
  readonly title: string;
  readonly query: string;
  readonly state: ComposerMentionProviderState;
  readonly results: ComposerMentionResults;
  readonly activeIndex: number;
  readonly labels: {
    readonly close: string;
    readonly loading: string;
    readonly empty: string;
    readonly more: string;
    readonly retry: string;
  };
  readonly onActiveIndexChange: (index: number) => void;
  readonly onSelect: (item: ComposerMentionCatalogItem) => void;
  readonly onClose: () => void;
  readonly onRetry?: () => void;
  readonly embedded?: boolean;
}): JSX.Element {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const selectedIndex = results.items.length === 0 ? 0 : Math.min(Math.max(activeIndex, 0), results.items.length - 1);
  const activeItem = results.items[selectedIndex];
  const activeOptionId = activeItem === undefined ? undefined : `${listId}-option-${selectedIndex}`;

  useEffect(() => {
    if (activeOptionId === undefined) return;
    document.getElementById(activeOptionId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId]);
  useEffect(() => {
    if (embedded) listRef.current?.focus({ preventScroll: true });
  }, [embedded]);

  const enabledIndices = results.items.flatMap((item, index) => item.disabled === true ? [] : [index]);

  const waiting = state.kind === "loading" || (state.kind === "ready" && state.searching === true);
  return (
    <div className={cx("composer-palette", embedded && "composer-palette--embedded")} role={embedded ? "group" : "dialog"} aria-label={title} data-mention-query={query}>
      {!embedded && <header><strong>{title}</strong><IconButton label={labels.close} onClick={onClose}><X aria-hidden="true" /></IconButton></header>}
      <div
        ref={listRef}
        id={listId}
        className="composer-palette__list"
        role="listbox"
        tabIndex={embedded ? 0 : undefined}
        data-morph-autofocus={embedded ? "" : undefined}
        aria-label={title}
        aria-busy={waiting}
        aria-activedescendant={activeOptionId}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (enabledIndices.length === 0) return;
          const selectedEnabledIndex = Math.max(0, enabledIndices.indexOf(selectedIndex));
          const next = event.key === "Home"
            ? enabledIndices[0]
            : event.key === "End"
              ? enabledIndices.at(-1)
              : event.key === "ArrowDown"
                ? enabledIndices[(selectedEnabledIndex + 1) % enabledIndices.length]
                : event.key === "ArrowUp"
                  ? enabledIndices[(selectedEnabledIndex - 1 + enabledIndices.length) % enabledIndices.length]
                  : undefined;
          if (next !== undefined) {
            event.preventDefault();
            onActiveIndexChange(next);
            return;
          }
          if (event.key !== "Enter") return;
          const selected = results.items[selectedIndex];
          if (selected === undefined || selected.disabled === true) return;
          event.preventDefault();
          onSelect(selected);
        }}
      >
        {results.items.map((item, index) => (
          <button
            id={`${listId}-option-${index}`}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            aria-disabled={item.disabled === true}
            disabled={item.disabled === true}
            tabIndex={-1}
            key={item.id}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => { if (item.disabled !== true) onActiveIndexChange(index); }}
            onClick={() => { if (item.disabled !== true) onSelect(item); }}
          >
            <span>{item.name}{item.kind === "directory" ? "/" : ""}</span><small>{item.disabledReason ?? item.meta}</small>
          </button>
        ))}
      </div>
      {results.items.length === 0 && state.kind === "loading" && <p role="status">{labels.loading}</p>}
      {results.items.length === 0 && state.kind === "error" && (
        <p role="alert">{state.message}{onRetry === undefined ? null : <button type="button" onClick={onRetry}>{labels.retry}</button>}</p>
      )}
      {results.items.length === 0 && state.kind === "ready" && <p role="status">{state.searching === true ? labels.loading : labels.empty}</p>}
      {results.items.length > 0 && waiting && <p role="status">{labels.loading}</p>}
      {results.items.length > 0 && state.kind === "error" && <p role="alert">{state.message}</p>}
      {results.truncated && <p role="status">{labels.more}</p>}
    </div>
  );
}
