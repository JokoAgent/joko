import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import { Bot, Plus, X } from "lucide-react";

import type { SessionView } from "../model.js";
import { IconButton, cx } from "./ui.js";
import "./workspace-files.css";

export interface WorkspaceSessionCreateOption {
  readonly id: string;
  readonly label: string;
  readonly icon?: JSX.Element;
  readonly disabled?: boolean;
}

export interface WorkspaceSessionTabsLabels {
  readonly unnamed: string;
  readonly close: (name: string) => string;
  readonly create: string;
}

export interface WorkspaceSessionTabsBarProps {
  readonly activeSessionId?: string;
  /** Already filtered to active sessions for this exact workspace and sorted by the host. */
  readonly sessions: readonly SessionView[];
  readonly labels: WorkspaceSessionTabsLabels;
  readonly createOptions?: readonly WorkspaceSessionCreateOption[];
  readonly onActivate: (sessionId: string) => void;
  readonly onClose: (sessionId: string, neighborId: string | undefined) => void;
  readonly onRename: (sessionId: string, name: string) => void;
  readonly onCreate?: (optionId: string) => void;
}

const SESSION_TAB_PEEK = 80;

export function WorkspaceSessionTabsBar({
  activeSessionId,
  sessions,
  labels,
  createOptions = [],
  onActivate,
  onClose,
  onRename,
  onCreate
}: WorkspaceSessionTabsBarProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const inputRef = useRef<HTMLInputElement>(null);
  const firstScrollRef = useRef(true);
  const committedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const createMenuId = useId();
  const typeaheadRef = useRef<{ value: string; timer: number | undefined }>({ value: "", timer: undefined });
  const [renamingId, setRenamingId] = useState<string>();
  const [editValue, setEditValue] = useState("");
  const [createMenu, setCreateMenu] = useState<{ readonly x: number; readonly y: number }>();

  const beginRename = useCallback((session: SessionView): void => {
    committedRef.current = false;
    setEditValue(session.name.trim() || labels.unnamed);
    setRenamingId(session.id);
  }, [labels.unnamed]);

  const cancelRename = useCallback((): void => setRenamingId(undefined), []);
  const commitRename = useCallback((): void => {
    if (committedRef.current) return;
    committedRef.current = true;
    const id = renamingId;
    setRenamingId(undefined);
    if (id === undefined) return;
    const name = editValue.trim();
    const session = sessions.find((candidate) => candidate.id === id);
    if (name === "" || session === undefined || name === session.name || (session.name.trim() === "" && name === labels.unnamed)) return;
    onRename(id, name);
  }, [editValue, labels.unnamed, onRename, renamingId, sessions]);

  useEffect(() => {
    if (renamingId === undefined || inputRef.current === null) return;
    inputRef.current.focus();
    inputRef.current.select();
  }, [renamingId]);

  useEffect(() => {
    if (activeSessionId === undefined) return;
    const tab = tabRefs.current.get(activeSessionId);
    const scroller = scrollRef.current;
    if (tab === undefined || scroller === null) return;
    const index = sessions.findIndex((session) => session.id === activeSessionId);
    const leftPeek = index > 0 ? SESSION_TAB_PEEK : 0;
    const rightPeek = index >= 0 && index < sessions.length - 1 ? SESSION_TAB_PEEK : 0;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    const visibleLeft = scroller.scrollLeft;
    const visibleRight = visibleLeft + scroller.clientWidth;
    let target: number | undefined;
    if (left - leftPeek < visibleLeft) target = Math.max(0, left - leftPeek);
    else if (right + rightPeek > visibleRight) target = right + rightPeek - scroller.clientWidth;
    if (target === undefined) return;
    if (firstScrollRef.current) {
      firstScrollRef.current = false;
      scroller.scrollLeft = target;
    } else {
      scroller.scrollTo({ left: target, behavior: "smooth" });
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (createMenu === undefined) return;
    const ownerDocument = rootRef.current?.ownerDocument;
    if (ownerDocument === undefined) return;
    const close = (): void => setCreateMenu(undefined);
    ownerDocument.addEventListener("pointerdown", close);
    return () => {
      ownerDocument.removeEventListener("pointerdown", close);
    };
  }, [createMenu]);

  useEffect(() => {
    if (createMenu === undefined) {
      typeaheadRef.current.value = "";
      const ownerWindow = rootRef.current?.ownerDocument.defaultView;
      if (typeaheadRef.current.timer !== undefined) ownerWindow?.clearTimeout(typeaheadRef.current.timer);
      typeaheadRef.current.timer = undefined;
      return;
    }
    const menu = createMenuRef.current;
    const first = menu?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)');
    (first ?? menu)?.focus({ preventScroll: true });
  }, [createMenu]);

  useEffect(() => () => {
    const ownerWindow = rootRef.current?.ownerDocument.defaultView;
    if (typeaheadRef.current.timer !== undefined) ownerWindow?.clearTimeout(typeaheadRef.current.timer);
  }, []);

  const closeCreateMenu = useCallback((restoreFocus: boolean): void => {
    setCreateMenu(undefined);
    typeaheadRef.current.value = "";
    if (restoreFocus) createButtonRef.current?.focus({ preventScroll: true });
  }, []);

  const createMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const menu = createMenuRef.current;
    if (menu === null) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')];
    const currentIndex = items.findIndex((item) => item === event.currentTarget.ownerDocument.activeElement);
    const focusAt = (index: number): void => items[index]?.focus({ preventScroll: true });
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      closeCreateMenu(true);
      return;
    }
    const targetIndex = event.key === "ArrowDown" ? (currentIndex + 1 + items.length) % items.length
      : event.key === "ArrowUp" ? (currentIndex - 1 + items.length) % items.length
        : event.key === "Home" ? 0
          : event.key === "End" ? items.length - 1
            : undefined;
    if (targetIndex !== undefined && items.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      focusAt(targetIndex);
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || items.length === 0) return;
    const ownerWindow = event.currentTarget.ownerDocument.defaultView;
    const key = event.key.toLocaleLowerCase();
    const previous = typeaheadRef.current.value;
    const next = previous !== "" && [...previous].every((character) => character === key) ? key : `${previous}${key}`;
    typeaheadRef.current.value = next;
    if (typeaheadRef.current.timer !== undefined) ownerWindow?.clearTimeout(typeaheadRef.current.timer);
    typeaheadRef.current.timer = ownerWindow?.setTimeout(() => { typeaheadRef.current.value = ""; }, 500);
    const start = currentIndex < 0 ? 0 : currentIndex + 1;
    const ordered = [...items.slice(start), ...items.slice(0, start)];
    const match = ordered.find((item) => item.textContent?.trim().toLocaleLowerCase().startsWith(next));
    if (match !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      match.focus({ preventScroll: true });
    }
  };

  const wheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const scroller = scrollRef.current;
    if (scroller === null || event.shiftKey || event.deltaX !== 0 || scroller.scrollWidth <= scroller.clientWidth) return;
    event.preventDefault();
    scroller.scrollLeft += event.deltaY;
  };

  const tabKey = (event: ReactKeyboardEvent<HTMLDivElement>, index: number, session: SessionView): void => {
    if (event.metaKey || event.ctrlKey || event.altKey || renamingId !== undefined) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (session.id !== activeSessionId) onActivate(session.id);
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      beginRename(session);
      return;
    }
    const nextIndex = event.key === "ArrowRight" ? Math.min(sessions.length - 1, index + 1)
      : event.key === "ArrowLeft" ? Math.max(0, index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? sessions.length - 1
            : undefined;
    const nextId = nextIndex === undefined ? undefined : sessions[nextIndex]?.id;
    if (nextId === undefined || nextIndex === index) return;
    event.preventDefault();
    tabRefs.current.get(nextId)?.focus({ preventScroll: true });
  };

  const ownerDocument = rootRef.current?.ownerDocument;
  const closable = sessions.length > 1;
  const canCreate = createOptions.length > 0 && onCreate !== undefined;
  return <div ref={rootRef} className="workspace-session-tabs-bar">
    <div ref={scrollRef} className="workspace-session-tabs-bar__scroll" role="tablist" onWheel={wheel}>
      {sessions.map((session, index) => {
        const active = session.id === activeSessionId;
        const title = session.name.trim() || labels.unnamed;
        const editing = session.id === renamingId;
        return <div
          key={session.id}
          ref={(node) => { if (node === null) tabRefs.current.delete(session.id); else tabRefs.current.set(session.id, node); }}
          role="tab"
          aria-selected={active}
          tabIndex={active || (activeSessionId === undefined && index === 0) ? 0 : -1}
          title={editing ? undefined : title}
          data-session-id={session.id}
          data-state={session.state}
          className={cx("workspace-session-tab", active && "is-active")}
          onClick={(event) => {
            if (editing || (event as ReactMouseEvent<HTMLDivElement>).detail > 1) return;
            if (!active) onActivate(session.id);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            beginRename(session);
          }}
          onKeyDown={(event) => tabKey(event, index, session)}
        >
          <span className="workspace-session-tab__agent" aria-hidden="true"><Bot /></span>
          {editing ? <input
            ref={inputRef}
            value={editValue}
            aria-label={title}
            onChange={(event) => setEditValue(event.target.value)}
            onBlur={commitRename}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                committedRef.current = true;
                cancelRename();
              }
            }}
          /> : <span className="workspace-session-tab__title">{title}</span>}
          {closable && !editing && <IconButton label={labels.close(title)} onClick={(event) => {
            event.stopPropagation();
            onClose(session.id, workspaceSessionTabNeighbor(sessions, session.id));
          }}><X aria-hidden="true" /></IconButton>}
        </div>;
      })}
    </div>
    {canCreate && <div className="workspace-session-tabs-bar__create">
      <IconButton buttonRef={createButtonRef} label={labels.create} aria-haspopup="menu" aria-controls={createMenu === undefined ? undefined : createMenuId} aria-expanded={createMenu !== undefined} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => {
        event.stopPropagation();
        if (createMenu !== undefined) {
          closeCreateMenu(true);
          return;
        }
        const bounds = createButtonRef.current?.getBoundingClientRect();
        const ownerWindow = event.currentTarget.ownerDocument.defaultView;
        if (bounds === undefined || ownerWindow === null) return;
        setCreateMenu({
          x: Math.max(8, Math.min(bounds.right - 148, ownerWindow.innerWidth - 156)),
          y: Math.max(8, Math.min(bounds.bottom + 4, ownerWindow.innerHeight - (createOptions.length * 28 + 12)))
        });
      }}><Plus aria-hidden="true" /></IconButton>
    </div>}
    {createMenu !== undefined && ownerDocument !== undefined && createPortal(<div
      ref={createMenuRef}
      id={createMenuId}
      className="workspace-session-create-menu"
      role="menu"
      aria-orientation="vertical"
      tabIndex={-1}
      style={{ left: createMenu.x, top: createMenu.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={createMenuKeyDown}
    >{createOptions.map((option) => <button
      key={option.id}
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={option.disabled}
      onClick={() => {
        setCreateMenu(undefined);
        onCreate?.(option.id);
      }}
    >{option.icon ?? <Bot aria-hidden="true" />}<span>{option.label}</span></button>)}</div>, ownerDocument.body)}
  </div>;
}

export function workspaceSessionTabNeighbor(sessions: readonly Pick<SessionView, "id">[], sessionId: string): string | undefined {
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index < 0) return undefined;
  return sessions[index + 1]?.id ?? sessions[index - 1]?.id;
}
