import { Plus, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { JSX, KeyboardEvent, ReactNode } from "react";

import { MorphPopover } from "./MorphPopover.js";
import { IconButton } from "./ui.js";

export function ComposerAddMenu({
  open,
  onOpenChange,
  label,
  panelLabel,
  closeLabel,
  disabled = false,
  disabledReason,
  count,
  children
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly label: string;
  readonly panelLabel?: string;
  readonly closeLabel: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly count?: number;
  readonly children: ReactNode;
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (disabled && open) onOpenChange(false);
  }, [disabled, onOpenChange, open]);
  const handleBodyKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const menu = target.closest<HTMLElement>('[role="menu"]');
    if (menu === null || !bodyRef.current?.contains(menu)) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])')];
    if (items.length === 0) return;
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (activeIndex + 1 + items.length) % items.length
          : (activeIndex - 1 + items.length) % items.length;
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex]?.focus({ preventScroll: true });
  };
  return <MorphPopover
    open={open && !disabled}
    onOpenChange={onOpenChange}
    label={panelLabel ?? label}
    trigger={<IconButton
      className="composer-add-menu__trigger"
      label={label}
      disabled={disabled}
      disabledReason={disabledReason}
      aria-haspopup="dialog"
      aria-expanded={open && !disabled}
      onClick={() => onOpenChange(!open)}
    ><Plus aria-hidden="true" />{count !== undefined && count > 0 && <span aria-hidden="true">×{count}</span>}</IconButton>}
    panelWidth={480}
    panelClassName="composer-add-menu__panel"
    initialFocus={() => bodyRef.current?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled])") ?? null}
  >
    <header className="composer-add-menu__header"><strong>{panelLabel ?? label}</strong><IconButton label={closeLabel} onClick={() => onOpenChange(false)}><X aria-hidden="true" /></IconButton></header>
    <div ref={bodyRef} className="composer-add-menu__body" onKeyDown={handleBodyKeyDown}>{children}</div>
  </MorphPopover>;
}
