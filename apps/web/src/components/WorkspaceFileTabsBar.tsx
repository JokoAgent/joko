import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent
} from "react";
import {
  Braces,
  ChevronsLeft,
  ChevronsRight,
  Clipboard,
  File,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  Menu,
  X,
  type LucideIcon
} from "lucide-react";

import {
  WorkspaceOpenTabsStore,
  nextActiveWorkspaceTab,
  workspaceOpenTabsStore
} from "../workspace-open-tabs.js";
import { IconButton, cx } from "./ui.js";
import "./workspace-files.css";

export interface WorkspaceFileTabsLabels {
  readonly close: (name: string) => string;
  readonly copyPath: string;
  readonly closeTab: string;
  readonly closeOthers: string;
  readonly closeRight: string;
  readonly closeLeft: string;
  readonly closeAll: string;
  readonly collapseChat: string;
  readonly expandChat: string;
  readonly openNavigation?: string;
}

export interface WorkspaceFileTabsBarProps {
  readonly workspaceId: string;
  readonly activePath?: string;
  readonly labels: WorkspaceFileTabsLabels;
  readonly store?: WorkspaceOpenTabsStore;
  readonly onActivate: (path: string) => void;
  /** Called after one dirty confirmation has already permitted the close. */
  readonly onActivateAfterClose?: (path: string) => void;
  readonly onClear: () => void;
  readonly onBeforeClose?: (path: string) => Promise<boolean>;
  readonly onCopyPath?: (path: string) => void | Promise<void>;
  readonly chatCollapsed?: boolean;
  readonly onToggleChat?: () => void;
  readonly navigationOpen?: boolean;
  readonly onOpenNavigation?: () => void;
}

type CloseAction = "tab" | "others" | "right" | "left" | "all";

interface ContextMenuState {
  readonly path: string;
  readonly x: number;
  readonly y: number;
}

interface DragGhost {
  readonly path: string;
  readonly x: number;
  readonly y: number;
}

export interface WorkspaceFileTabMenuKeyInput {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly currentIndex: number;
  readonly itemLabels: readonly string[];
  readonly typeahead: string;
}

export type WorkspaceFileTabMenuKeyIntent =
  | { readonly kind: "close" }
  | { readonly kind: "focus"; readonly index: number }
  | { readonly kind: "typeahead"; readonly value: string; readonly index?: number }
  | null;

export function WorkspaceFileTabsBar({
  workspaceId,
  activePath,
  labels,
  store = workspaceOpenTabsStore,
  onActivate,
  onActivateAfterClose,
  onClear,
  onBeforeClose,
  onCopyPath,
  chatCollapsed = false,
  onToggleChat,
  navigationOpen = true,
  onOpenNavigation
}: WorkspaceFileTabsBarProps): JSX.Element | null {
  const tabs = useSyncExternalStore(
    (notify) => store.subscribe((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) notify();
    }),
    () => store.getTabs(workspaceId),
    () => store.getTabs(workspaceId)
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuSourceRef = useRef<HTMLDivElement>(null);
  const contextMenuTypeaheadRef = useRef<{ value: string; timer: number | undefined }>({ value: "", timer: undefined });
  const dragCleanupRef = useRef<(() => void) | undefined>(undefined);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  const [dragSource, setDragSource] = useState<number>();
  const [insertAt, setInsertAt] = useState<number>();
  const [dragGhost, setDragGhost] = useState<DragGhost>();

  const resetContextMenuTypeahead = useCallback((): void => {
    if (contextMenuTypeaheadRef.current.timer !== undefined) {
      clearTimeout(contextMenuTypeaheadRef.current.timer);
    }
    contextMenuTypeaheadRef.current.value = "";
    contextMenuTypeaheadRef.current.timer = undefined;
  }, []);

  const closeContextMenu = useCallback((restoreFocus: boolean): void => {
    setContextMenu(undefined);
    resetContextMenuTypeahead();
    if (restoreFocus) contextMenuSourceRef.current?.focus({ preventScroll: true });
  }, [resetContextMenuTypeahead]);

  useEffect(() => () => dragCleanupRef.current?.(), []);
  useEffect(() => resetContextMenuTypeahead, [resetContextMenuTypeahead]);

  useEffect(() => {
    if (contextMenu === undefined) return;
    if (!tabs.includes(contextMenu.path)) {
      closeContextMenu(false);
      return;
    }
    const ownerDocument = rootRef.current?.ownerDocument;
    if (ownerDocument === undefined) return;
    const close = (): void => closeContextMenu(false);
    ownerDocument.addEventListener("pointerdown", close);
    return () => {
      ownerDocument.removeEventListener("pointerdown", close);
    };
  }, [closeContextMenu, contextMenu, tabs]);

  useEffect(() => {
    if (contextMenu === undefined) return;
    const menu = contextMenuRef.current;
    const first = menu?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)');
    (first ?? menu)?.focus({ preventScroll: true });
  }, [contextMenu]);

  useEffect(() => {
    if (activePath === undefined) return;
    const tab = tabRefs.current.get(activePath);
    const scroller = scrollRef.current;
    if (tab === undefined || scroller === null) return;
    const peek = 32;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    const visibleLeft = scroller.scrollLeft;
    const visibleRight = visibleLeft + scroller.clientWidth;
    const maximum = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    if (left < visibleLeft) scroller.scrollLeft = Math.max(0, left - (left > 0 ? peek : 0));
    else if (right > visibleRight) {
      scroller.scrollLeft = Math.min(maximum, right - scroller.clientWidth + (right < scroller.scrollWidth ? peek : 0));
    }
  }, [activePath]);

  if (tabs.length === 0 && onToggleChat === undefined && onOpenNavigation === undefined) return null;

  const closeMany = async (paths: readonly string[]): Promise<void> => {
    if (paths.length === 0) return;
    const closing = new Set(paths);
    const activeIsClosing = activePath !== undefined && closing.has(activePath);
    if (activeIsClosing && activePath !== undefined && onBeforeClose !== undefined) {
      if (!(await onBeforeClose(activePath))) return;
    }
    // The confirmation is asynchronous. Derive the successor
    // from the current store rather than the pre-dialog render snapshot.
    const liveTabs = store.getTabs(workspaceId);
    if (activeIsClosing && activePath !== undefined) {
      const next = nextActiveWorkspaceTab(liveTabs, activePath, paths);
      if (next === undefined) onClear();
      else (onActivateAfterClose ?? onActivate)(next);
    }
    store.closeTabs(workspaceId, paths);
  };

  const copyPath = async (path: string): Promise<void> => {
    if (onCopyPath !== undefined) {
      await onCopyPath(path);
      return;
    }
    await rootRef.current?.ownerDocument.defaultView?.navigator.clipboard.writeText(path);
  };

  const beginDrag = (event: ReactMouseEvent<HTMLDivElement>, sourceIndex: number): void => {
    if (event.button !== 0 || (event.target as HTMLElement | null)?.closest("button") !== null) return;
    const ownerWindow = event.currentTarget.ownerDocument.defaultView;
    const sourcePath = tabs[sourceIndex];
    if (ownerWindow === null || sourcePath === undefined) return;
    event.preventDefault();
    dragCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let pendingInsertAt: number | undefined;

    const cleanup = (): void => {
      ownerWindow.removeEventListener("mousemove", move);
      ownerWindow.removeEventListener("mouseup", finish);
      ownerWindow.removeEventListener("blur", cancel);
    };
    const reset = (): void => {
      setDragSource(undefined);
      setInsertAt(undefined);
      setDragGhost(undefined);
    };
    const move = (moveEvent: MouseEvent): void => {
      if (!active) {
        if (Math.abs(moveEvent.clientX - startX) < 5 && Math.abs(moveEvent.clientY - startY) < 5) return;
        active = true;
        setDragSource(sourceIndex);
      }
      setDragGhost({ path: sourcePath, x: moveEvent.clientX, y: moveEvent.clientY });
      let candidate = tabs.length;
      for (let index = 0; index < tabs.length; index += 1) {
        const path = tabs[index];
        const element = path === undefined ? undefined : tabRefs.current.get(path);
        if (element === undefined) continue;
        const bounds = element.getBoundingClientRect();
        if (moveEvent.clientX < bounds.left + bounds.width / 2) {
          candidate = index;
          break;
        }
      }
      pendingInsertAt = candidate;
      setInsertAt(candidate);
    };
    const finish = (): void => {
      cleanup();
      dragCleanupRef.current = undefined;
      if (!active) return;
      const suppressClick = (clickEvent: MouseEvent): void => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        ownerWindow.removeEventListener("click", suppressClick, true);
      };
      ownerWindow.addEventListener("click", suppressClick, true);
      ownerWindow.setTimeout(() => ownerWindow.removeEventListener("click", suppressClick, true), 100);
      if (pendingInsertAt !== undefined) {
        let target = pendingInsertAt;
        if (sourceIndex < target) target -= 1;
        if (target !== sourceIndex) store.reorderTabs(workspaceId, sourceIndex, target);
      }
      reset();
    };
    const cancel = (): void => {
      cleanup();
      dragCleanupRef.current = undefined;
      if (active) reset();
    };
    ownerWindow.addEventListener("mousemove", move);
    ownerWindow.addEventListener("mouseup", finish);
    ownerWindow.addEventListener("blur", cancel);
    dragCleanupRef.current = cleanup;
  };

  const wheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const scroller = scrollRef.current;
    if (scroller === null || event.shiftKey || event.deltaX !== 0 || scroller.scrollWidth <= scroller.clientWidth) return;
    event.preventDefault();
    scroller.scrollLeft += event.deltaY;
  };

  const handleTabKey = (event: ReactKeyboardEvent<HTMLDivElement>, index: number, path: string): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (path !== activePath) onActivate(path);
      return;
    }
    const nextIndex = event.key === "ArrowRight" ? Math.min(tabs.length - 1, index + 1)
      : event.key === "ArrowLeft" ? Math.max(0, index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? tabs.length - 1
            : undefined;
    if (nextIndex === undefined || nextIndex === index) return;
    const nextPath = tabs[nextIndex];
    if (nextPath === undefined) return;
    event.preventDefault();
    tabRefs.current.get(nextPath)?.focus({ preventScroll: true });
  };

  const contextMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')];
    const intent = resolveWorkspaceFileTabMenuKey({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      currentIndex: items.findIndex((item) => item === event.currentTarget.ownerDocument.activeElement),
      itemLabels: items.map((item) => item.textContent?.trim() ?? ""),
      typeahead: contextMenuTypeaheadRef.current.value
    });
    if (intent === null) return;
    if (intent.kind === "close") {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      closeContextMenu(true);
      return;
    }
    if (intent.kind === "typeahead") {
      contextMenuTypeaheadRef.current.value = intent.value;
      if (contextMenuTypeaheadRef.current.timer !== undefined) clearTimeout(contextMenuTypeaheadRef.current.timer);
      contextMenuTypeaheadRef.current.timer = event.currentTarget.ownerDocument.defaultView?.setTimeout(() => {
        contextMenuTypeaheadRef.current.value = "";
        contextMenuTypeaheadRef.current.timer = undefined;
      }, 500);
    }
    event.preventDefault();
    event.stopPropagation();
    if (intent.index !== undefined) items[intent.index]?.focus({ preventScroll: true });
  };

  const ownerDocument = rootRef.current?.ownerDocument;
  return <div ref={rootRef} className="workspace-file-tabs-bar">
    {onOpenNavigation !== undefined && !navigationOpen && <div className="workspace-file-tabs-bar__navigation-toggle">
      <IconButton label={labels.openNavigation ?? "Open navigation"} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>
    </div>}
    <div ref={scrollRef} className="workspace-file-tabs-bar__scroll" role="tablist" onWheel={wheel}>
      {tabs.map((path, index) => {
        const name = workspaceFileName(path);
        const Icon = workspaceFileIcon(name);
        const active = path === activePath;
        const indicatorBefore = insertAt === index && dragSource !== index;
        const indicatorAfter = insertAt === index + 1 && dragSource !== index && dragSource !== index + 1;
        return <div
          key={path}
          ref={(node) => { if (node === null) tabRefs.current.delete(path); else tabRefs.current.set(path, node); }}
          role="tab"
          aria-selected={active}
          tabIndex={active || (activePath === undefined && index === 0) ? 0 : -1}
          title={path}
          className={cx("workspace-file-tab", active && "is-active", dragSource === index && "is-dragging")}
          onMouseDown={(event) => beginDrag(event, index)}
          onClick={() => { if (!active) onActivate(path); }}
          onKeyDown={(event) => handleTabKey(event, index, path)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            contextMenuSourceRef.current = event.currentTarget;
            resetContextMenuTypeahead();
            const bounds = clampContextMenu(event.clientX, event.clientY, event.currentTarget.ownerDocument.defaultView);
            setContextMenu({ path, ...bounds });
          }}
        >
          {indicatorBefore && <i className="workspace-file-tab__insert is-before" aria-hidden="true" />}
          {indicatorAfter && <i className="workspace-file-tab__insert is-after" aria-hidden="true" />}
          <Icon aria-hidden="true" />
          <span>{name}</span>
          <IconButton label={labels.close(name)} onClick={(event) => {
            event.stopPropagation();
            void closeMany([path]);
          }}><X aria-hidden="true" /></IconButton>
        </div>;
      })}
    </div>
    {onToggleChat !== undefined && <div className="workspace-file-tabs-bar__rail-toggle">
      <IconButton
        label={chatCollapsed ? labels.expandChat : labels.collapseChat}
        aria-pressed={!chatCollapsed}
        onClick={onToggleChat}
      >{chatCollapsed ? <ChevronsLeft aria-hidden="true" /> : <ChevronsRight aria-hidden="true" />}</IconButton>
    </div>}
    {contextMenu !== undefined && ownerDocument !== undefined && createPortal(<WorkspaceFileTabMenu
      menuRef={contextMenuRef}
      state={contextMenu}
      tabs={tabs}
      labels={labels}
      onKeyDown={contextMenuKeyDown}
      onCopy={() => { closeContextMenu(false); void copyPath(contextMenu.path); }}
      onClose={(action) => {
        const paths = workspaceFileTabCloseSet(action, tabs, contextMenu.path);
        closeContextMenu(false);
        void closeMany(paths);
      }}
    />, ownerDocument.body)}
    {dragGhost !== undefined && ownerDocument !== undefined && createPortal(<div
      className="workspace-file-tab-ghost"
      aria-hidden="true"
      style={{ left: dragGhost.x + 12, top: dragGhost.y + 12 }}
    >{(() => { const Icon = workspaceFileIcon(dragGhost.path); return <Icon />; })()}<span>{workspaceFileName(dragGhost.path)}</span></div>, ownerDocument.body)}
  </div>;
}

function WorkspaceFileTabMenu({ menuRef, state, tabs, labels, onKeyDown, onCopy, onClose }: {
  readonly menuRef: RefObject<HTMLDivElement | null>;
  readonly state: ContextMenuState;
  readonly tabs: readonly string[];
  readonly labels: WorkspaceFileTabsLabels;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onCopy: () => void;
  readonly onClose: (action: CloseAction) => void;
}): JSX.Element | null {
  const index = tabs.indexOf(state.path);
  if (index < 0) return null;
  return <div
    ref={menuRef}
    role="menu"
    aria-orientation="vertical"
    tabIndex={-1}
    className="workspace-file-tab-menu"
    style={{ left: state.x, top: state.y }}
    onPointerDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.preventDefault()}
    onKeyDown={onKeyDown}
  >
    <button type="button" role="menuitem" tabIndex={-1} onClick={onCopy}><Clipboard aria-hidden="true" />{labels.copyPath}</button>
    <hr />
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => onClose("tab")}>{labels.closeTab}</button>
    <button type="button" role="menuitem" tabIndex={-1} disabled={tabs.length < 2} onClick={() => onClose("others")}>{labels.closeOthers}</button>
    <button type="button" role="menuitem" tabIndex={-1} disabled={index >= tabs.length - 1} onClick={() => onClose("right")}>{labels.closeRight}</button>
    <button type="button" role="menuitem" tabIndex={-1} disabled={index <= 0} onClick={() => onClose("left")}>{labels.closeLeft}</button>
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => onClose("all")}>{labels.closeAll}</button>
  </div>;
}

export function resolveWorkspaceFileTabMenuKey(input: WorkspaceFileTabMenuKeyInput): WorkspaceFileTabMenuKeyIntent {
  if (input.key === "Escape") return { kind: "close" };
  const itemCount = input.itemLabels.length;
  if (itemCount === 0) return null;
  const currentIndex = input.currentIndex >= 0 && input.currentIndex < itemCount ? input.currentIndex : -1;
  const targetIndex = input.key === "ArrowDown" ? (currentIndex < 0 ? 0 : (currentIndex + 1) % itemCount)
    : input.key === "ArrowUp" ? (currentIndex < 0 ? itemCount - 1 : (currentIndex - 1 + itemCount) % itemCount)
      : input.key === "Home" ? 0
        : input.key === "End" ? itemCount - 1
          : undefined;
  if (targetIndex !== undefined) return { kind: "focus", index: targetIndex };
  if (input.key.length !== 1 || input.key === " " || input.ctrlKey || input.metaKey || input.altKey) return null;

  const key = input.key.toLocaleLowerCase();
  const previous = input.typeahead.toLocaleLowerCase();
  const value = previous !== "" && [...previous].every((character) => character === key) ? key : `${previous}${key}`;
  const start = currentIndex < 0 ? 0 : currentIndex + 1;
  for (let offset = 0; offset < itemCount; offset += 1) {
    const index = (start + offset) % itemCount;
    if (input.itemLabels[index]?.trim().toLocaleLowerCase().startsWith(value) === true) {
      return { kind: "typeahead", value, index };
    }
  }
  return { kind: "typeahead", value };
}

export function workspaceFileTabCloseSet(action: CloseAction, tabs: readonly string[], path: string): readonly string[] {
  const index = tabs.indexOf(path);
  if (index < 0) return [];
  if (action === "tab") return [path];
  if (action === "others") return tabs.filter((candidate) => candidate !== path);
  if (action === "right") return tabs.slice(index + 1);
  if (action === "left") return tabs.slice(0, index);
  return [...tabs];
}

function workspaceFileName(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

function workspaceFileIcon(path: string): LucideIcon {
  const lower = path.toLowerCase();
  if (/\.(?:png|jpe?g|gif|webp|bmp|ico|svg)$/u.test(lower)) return FileImage;
  if (/\.(?:json|jsonc)$/u.test(lower)) return FileJson;
  if (/\.(?:md|mdx|txt|rst)$/u.test(lower)) return FileText;
  if (/\.(?:tsx?|jsx?|css|scss|less|html?|vue|svelte|py|rs|go|java|c|cc|cpp|h|hpp|cs|php|rb|swift|kt|kts|sql|sh|ps1)$/u.test(lower)) return FileCode2;
  if (/\.(?:ya?ml|toml|xml|drawio)$/u.test(lower)) return Braces;
  return File;
}

function clampContextMenu(x: number, y: number, ownerWindow: Window | null): { readonly x: number; readonly y: number } {
  if (ownerWindow === null) return { x: Math.max(8, x), y: Math.max(8, y) };
  return {
    x: Math.min(Math.max(8, x), Math.max(8, ownerWindow.innerWidth - 200)),
    y: Math.min(Math.max(8, y), Math.max(8, ownerWindow.innerHeight - 228))
  };
}
