import { ChevronDown, ChevronUp, X } from "lucide-react";
import { forwardRef, type JSX, type KeyboardEvent } from "react";
import { IconButton } from "./ui.js";

import "./workspace-document-search-bar.css";

export interface WorkspaceDocumentSearchBarLabels {
  readonly search: string;
  readonly placeholder: string;
  readonly previous: string;
  readonly next: string;
  readonly close: string;
  readonly truncated: string;
}

export interface WorkspaceDocumentSearchBarProps {
  readonly query: string;
  readonly total: number;
  readonly activeIndex: number;
  readonly truncated?: boolean;
  readonly labels: WorkspaceDocumentSearchBarLabels;
  readonly onChange: (query: string) => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly onClose: () => void;
}

/** Fixed-width, document-scoped Ctrl/Cmd+F surface. */
export const WorkspaceDocumentSearchBar = forwardRef<HTMLInputElement, WorkspaceDocumentSearchBarProps>(function WorkspaceDocumentSearchBar({
  query,
  total,
  activeIndex,
  truncated = false,
  labels,
  onChange,
  onPrevious,
  onNext,
  onClose
}, forwardedRef): JSX.Element {
  const unavailable = query === "" || total === 0;
  const keyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) onPrevious();
    else onNext();
  };
  return <div
    className="workspace-document-search-bar"
    role="search"
    aria-label={labels.search}
    data-doc-search-bar=""
  >
    <input
      ref={forwardedRef}
      type="text"
      value={query}
      aria-label={labels.search}
      placeholder={labels.placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={keyDown}
    />
    <span className="workspace-document-search-bar__count" aria-live="polite" title={truncated ? labels.truncated : undefined}>
      {query === "" ? "" : total === 0 ? "0/0" : `${activeIndex + 1}/${total}${truncated ? "+" : ""}`}
    </span>
    <IconButton label={labels.previous} disabled={unavailable} disabledReason={unavailable ? labels.previous : undefined} onClick={onPrevious}><ChevronUp aria-hidden="true" /></IconButton>
    <IconButton label={labels.next} disabled={unavailable} disabledReason={unavailable ? labels.next : undefined} onClick={onNext}><ChevronDown aria-hidden="true" /></IconButton>
    <IconButton label={labels.close} onClick={onClose}><X aria-hidden="true" /></IconButton>
  </div>;
});
