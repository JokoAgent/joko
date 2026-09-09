import { useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A menu belongs to the document of its source link, including keyboard and focus. */
export function TimelineLinkMenu({ trigger, position, label, onClose, children }: {
  readonly trigger: HTMLAnchorElement;
  readonly position: { readonly x: number; readonly y: number };
  readonly label: string;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly children: ReactNode;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const ownerDocument = trigger.ownerDocument;
  const [bounds, setBounds] = useState({ left: position.x, top: position.y });
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const ownerWindow = ownerDocument.defaultView;
    if (menu === null || ownerWindow === null) return;
    const viewport = ownerWindow.visualViewport;
    const measure = (): void => {
      const rect = menu.getBoundingClientRect();
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      setBounds({
        left: Math.max(left + 8, Math.min(position.x, left + (viewport?.width ?? ownerWindow.innerWidth) - rect.width - 8)),
        top: Math.max(top + 8, Math.min(position.y, top + (viewport?.height ?? ownerWindow.innerHeight) - rect.height - 8))
      });
    };
    measure();
    const Resize = (ownerWindow as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const resize = Resize === undefined ? undefined : new Resize(measure);
    resize?.observe(menu);
    const items = (): HTMLButtonElement[] => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    (items()[0] ?? menu).focus();
    const outside = (event: Event): void => {
      if (!menu.contains(event.target as Node)) closeRef.current(false);
    };
    const dismiss = (): void => closeRef.current(false);
    const scroll = (event: Event): void => { if (!menu.contains(event.target as Node)) dismiss(); };
    const key = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || !menu.contains(ownerDocument.activeElement)) return;
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") event.preventDefault();
        event.stopPropagation();
        closeRef.current(true);
      } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const enabled = items();
        const index = enabled.indexOf(ownerDocument.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
        enabled[next]?.focus();
      }
    };
    ownerDocument.addEventListener("pointerdown", outside, true);
    ownerDocument.addEventListener("focusin", outside);
    ownerDocument.addEventListener("keydown", key, true);
    ownerWindow.addEventListener("resize", dismiss);
    ownerWindow.addEventListener("scroll", scroll, true);
    viewport?.addEventListener("resize", dismiss);
    viewport?.addEventListener("scroll", dismiss);
    return () => {
      resize?.disconnect();
      ownerDocument.removeEventListener("pointerdown", outside, true);
      ownerDocument.removeEventListener("focusin", outside);
      ownerDocument.removeEventListener("keydown", key, true);
      ownerWindow.removeEventListener("resize", dismiss);
      ownerWindow.removeEventListener("scroll", scroll, true);
      viewport?.removeEventListener("resize", dismiss);
      viewport?.removeEventListener("scroll", dismiss);
    };
  }, [ownerDocument, position, trigger]);
  return createPortal(<div ref={menuRef} className="timeline-link-menu" role="menu" tabIndex={-1} aria-label={label}
    style={bounds} onContextMenu={(event) => event.preventDefault()} onClick={(event) => event.stopPropagation()}>
    {children}
  </div>, ownerDocument.body);
}
