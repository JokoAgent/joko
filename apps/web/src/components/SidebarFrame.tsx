import {
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type JSX,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import {
  CirclePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Unplug,
  X
} from "lucide-react";

import type { AppSnapshot } from "../model.js";
import type { NavigationMode } from "../navigation-layout.js";
import { DesktopUpdateBanner, DesktopUpdateRestoreButton } from "./DesktopUpdateBanner.js";
import type { Translator } from "./types.js";
import { Button, IconButton, StatusDot, cx } from "./ui.js";

const SIDEBAR_DRAWER_MEDIA_QUERY = "(max-width: 980px)";
const SIDEBAR_DRAWER_FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Joko-owned application navigation chrome. Feature routes may replace only
 * the expanded body and rail body; the brand lockup, Orchestrator footer, collapse
 * states, resize separator, focus treatment, and mobile drawer semantics stay
 * shared.
 */
export interface SidebarFrameProps {
  readonly server: AppSnapshot["server"];
  readonly open: boolean;
  readonly mode: NavigationMode;
  readonly width: number;
  readonly probeRuntimeActivity: () => Promise<boolean>;
  readonly t: Translator;
  readonly expandedBody: ReactNode;
  readonly railBody: ReactNode;
  readonly className?: string;
  readonly searchLabel?: string;
  readonly onHome: () => void;
  readonly onNewTask: () => void;
  readonly onSearch: () => void;
  readonly onCloseDrawer: () => void;
  readonly onHide: () => void;
  readonly onCollapse: () => void;
  readonly onExpand: () => void;
  readonly onResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onResizePointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onResizePointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onResizePointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onResetWidth: () => void;
  readonly onDisconnect: () => void;
  /** Optional feature-owned fallback used after a compact drawer closes. */
  readonly drawerRestoreFocus?: () => HTMLElement | null;
}

export function SidebarFrame(props: SidebarFrameProps): JSX.Element {
  const rootRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const drawerRestoreFocusRef = useRef(props.drawerRestoreFocus);
  drawerRestoreFocusRef.current = props.drawerRestoreFocus;
  const onCloseDrawerRef = useRef(props.onCloseDrawer);
  onCloseDrawerRef.current = props.onCloseDrawer;
  const focusOwnedBySidebarRef = useRef(false);
  const [compactDrawer, setCompactDrawer] = useState(false);
  const railPresentation = props.mode === "rail" && !compactDrawer;
  // Treat an initially-open compact shell as a drawer opening as well. The
  // The desktop window may launch at the 800px minimum with navigation
  // persisted open, and keyboard focus must not remain behind its scrim.
  const previousPresentationRef = useRef({ open: false, compact: false, mode: props.mode });

  useLayoutEffect(() => {
    const ownerWindow = rootRef.current?.ownerDocument.defaultView;
    if (ownerWindow?.matchMedia === undefined) return;
    const media = ownerWindow.matchMedia(SIDEBAR_DRAWER_MEDIA_QUERY);
    const changed = (event: MediaQueryListEvent): void => setCompactDrawer(event.matches);
    setCompactDrawer(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const ownerDocument = root?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (root === null || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;

    const previous = previousPresentationRef.current;
    previousPresentationRef.current = { open: props.open, compact: compactDrawer, mode: props.mode };
    const opening = compactDrawer && props.open && (!previous.open || !previous.compact);
    const closing = previous.open && !props.open;
    const leavingCompact = previous.compact && !compactDrawer && props.open;
    const changingPersistentMode = previous.open
      && props.open
      && !compactDrawer
      && previous.mode !== props.mode
      && previous.mode !== "hidden"
      && props.mode !== "hidden";

    if (opening) {
      const active = ownerDocument.activeElement;
      returnFocusRef.current = active instanceof ownerWindow.HTMLElement
        && active !== ownerDocument.body
        && !root.contains(active)
        ? active
        : null;
      root.querySelector<HTMLElement>(".sidebar__mobile-close")?.focus({ preventScroll: true });
    } else if (closing) {
      const active = ownerDocument.activeElement;
      const activeInsideSidebar = active instanceof ownerWindow.Node && root.contains(active);
      const activeFellBackToDocument = active === null || active === ownerDocument.body;
      const shouldRestoreFocus = activeInsideSidebar
        || (focusOwnedBySidebarRef.current && activeFellBackToDocument);
      const previousFocus = returnFocusRef.current;
      returnFocusRef.current = null;
      focusOwnedBySidebarRef.current = false;
      if (shouldRestoreFocus) {
        const candidates = [
          previousFocus,
          drawerRestoreFocusRef.current?.(),
          ownerDocument.getElementById("main-content")
        ];
        candidates.find((candidate) => isSafeSidebarFocusTarget(candidate, ownerDocument, root))
          ?.focus({ preventScroll: true });
      }
    } else if (leavingCompact || changingPersistentMode) {
      const active = ownerDocument.activeElement;
      const activeFellBackToDocument = active === null || active === ownerDocument.body;
      const activeWillBeHidden = active instanceof ownerWindow.Element
        && sidebarFocusTargetWillBeHidden(active, props.mode);
      if (activeWillBeHidden || (focusOwnedBySidebarRef.current && activeFellBackToDocument)) {
        const persistentTarget = props.mode === "rail"
          ? root.querySelector<HTMLElement>(".sidebar__rail-actions button")
          : root.querySelector<HTMLElement>(".sidebar__collapse");
        persistentTarget?.focus({ preventScroll: true });
      }
    }

    if (!compactDrawer || !props.open) return;

    const handleKey = (event: globalThis.KeyboardEvent): void => {
      if (event.isComposing || event.defaultPrevented || sidebarDrawerHasHigherPrioritySurface(ownerDocument)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseDrawerRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...root.querySelectorAll<HTMLElement>(SIDEBAR_DRAWER_FOCUSABLE)]
        .filter((element) => element.closest("[inert], [aria-hidden='true']") === null && element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        root.focus({ preventScroll: true });
      } else if (event.shiftKey && (ownerDocument.activeElement === root || ownerDocument.activeElement === first || !root.contains(ownerDocument.activeElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (ownerDocument.activeElement === root || ownerDocument.activeElement === last || !root.contains(ownerDocument.activeElement))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    ownerWindow.addEventListener("keydown", handleKey);
    return () => {
      ownerWindow.removeEventListener("keydown", handleKey);
    };
  }, [compactDrawer, props.mode, props.open]);

  const handleFocusCapture = (): void => {
    focusOwnedBySidebarRef.current = true;
  };
  const handleBlurCapture = (event: ReactFocusEvent<HTMLElement>): void => {
    const root = rootRef.current;
    const ownerWindow = root?.ownerDocument.defaultView;
    if (root === null || ownerWindow === null || ownerWindow === undefined) return;
    const next = event.relatedTarget;
    if (next instanceof ownerWindow.Node && root.contains(next)) return;
    // A null relatedTarget is what Chromium reports when an ancestor becomes
    // inert. Preserve ownership long enough for the close layout effect to
    // move focus to a safe target in this same document.
    if (next !== null) focusOwnedBySidebarRef.current = false;
  };

  return <aside
    ref={rootRef}
    className={cx("sidebar", props.open && "is-open", props.mode === "rail" && "is-rail", props.className)}
    aria-label={props.t("a11y.taskNavigation")}
    aria-hidden={!props.open}
    inert={!props.open}
    tabIndex={-1}
    onFocusCapture={handleFocusCapture}
    onBlurCapture={handleBlurCapture}
  >
    <header className="sidebar__header">
      <button className="brand-mark brand-mark--avatar sidebar-avatar" type="button" onClick={props.onHome} aria-label={props.t("a11y.appHome", { name: props.t("app.name") })} />
      <div className="sidebar__header-content">
        <div className="sidebar__brand-row">
          <button className="brand" type="button" onClick={props.onHome}>{props.t("app.name")}</button>
          <IconButton className="sidebar__mobile-close" label={props.t("a11y.closeNavigation")} onClick={props.onCloseDrawer}><X aria-hidden="true" /></IconButton>
          <IconButton className="sidebar__collapse" label={props.t("a11y.collapseNavigation")} onClick={props.onCollapse}><PanelLeftClose aria-hidden="true" /></IconButton>
        </div>
        <Button tone="primary" className="new-task-button" onClick={props.onNewTask}><CirclePlus aria-hidden="true" />{props.t("nav.newTask")}<kbd>⌘N</kbd></Button>
      </div>
    </header>

    <div className="sidebar__expanded-view">
      {props.expandedBody}
    </div>

    <div className="sidebar__rail-view">
      <div className="sidebar__rail-actions">
        <IconButton label={props.t("a11y.expandNavigation")} onClick={props.onExpand}><PanelLeftOpen aria-hidden="true" /></IconButton>
        <IconButton label={props.t("a11y.closeNavigation")} onClick={props.onHide}><X aria-hidden="true" /></IconButton>
        <IconButton label={props.t("nav.newTask")} onClick={props.onNewTask}><CirclePlus aria-hidden="true" /></IconButton>
        <IconButton label={props.searchLabel ?? props.t("nav.searchTasks")} onClick={props.onSearch}><Search aria-hidden="true" /></IconButton>
      </div>
      <div className="sidebar__rail-divider" aria-hidden="true" />
      {props.railBody}
    </div>

    <DesktopUpdateBanner collapsed={railPresentation} probeRuntimeActivity={props.probeRuntimeActivity} t={props.t} />
    {railPresentation
      ? <footer className="sidebar__rail-footer">
        <StatusDot state={props.server.health} label={`${props.server.name}: ${props.server.health}`} />
        <DesktopUpdateRestoreButton suppressBusy t={props.t} />
        <IconButton label={props.t("connection.disconnect")} onClick={props.onDisconnect}><Unplug aria-hidden="true" /></IconButton>
      </footer>
      : <SidebarOrchestratorFooter server={props.server} t={props.t} onDisconnect={props.onDisconnect} />}

    {props.mode !== "hidden" && <div
      className="sidebar__resize-handle"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={props.t("a11y.resizeNavigation")}
      aria-valuemin={78}
      aria-valuemax={480}
      aria-valuenow={Math.round(props.width)}
      aria-valuetext={`${Math.round(props.width)} px`}
      onPointerDown={props.onResizePointerDown}
      onPointerMove={props.onResizePointerMove}
      onPointerUp={props.onResizePointerUp}
      onPointerCancel={props.onResizePointerCancel}
      onLostPointerCapture={props.onResizePointerCancel}
      onKeyDown={props.onResizeKeyDown}
      onDoubleClick={props.onResetWidth}
    ><span aria-hidden="true" /></div>}
  </aside>;
}

function isSafeSidebarFocusTarget(
  candidate: HTMLElement | null | undefined,
  ownerDocument: Document,
  hiddenSidebar: HTMLElement
): candidate is HTMLElement {
  const ownerWindow = ownerDocument.defaultView;
  return ownerWindow !== null
    && candidate instanceof ownerWindow.HTMLElement
    && candidate.ownerDocument === ownerDocument
    && candidate.isConnected
    && !hiddenSidebar.contains(candidate)
    && candidate.closest("[inert], [aria-hidden='true']") === null
    && (!(candidate instanceof ownerWindow.HTMLButtonElement) || !candidate.disabled);
}

function sidebarFocusTargetWillBeHidden(active: Element, mode: NavigationMode): boolean {
  if (active.closest(".sidebar__mobile-close") !== null) return true;
  if (mode === "rail") {
    return active.closest(".sidebar__header-content, .sidebar__expanded-view, .sidebar__footer") !== null;
  }
  if (mode === "expanded") {
    return active.closest(".sidebar__rail-view, .sidebar__rail-footer") !== null;
  }
  return false;
}

function sidebarDrawerHasHigherPrioritySurface(ownerDocument: Document): boolean {
  return ownerDocument.body.classList.contains("modal-open")
    || ownerDocument.querySelector("[role='dialog'][aria-modal='true'], .workspace-files-context-menu, .workspace-files-dialog, .workspace-files-tree__inline-row, .workspace-image-lightbox, .workspace-mermaid-lightbox") !== null;
}

export function SidebarOrchestratorFooter({ server, t, onDisconnect }: {
  readonly server: AppSnapshot["server"];
  readonly t: Translator;
  readonly onDisconnect: () => void;
}): JSX.Element {
  return <footer className="sidebar__footer">
    <div className="server-summary">
      <StatusDot state={server.health} label={server.health} />
      <div><strong>{server.name}</strong><span>v{server.version || "—"}</span></div>
    </div>
    <DesktopUpdateRestoreButton t={t} />
    <IconButton label={t("connection.disconnect")} onClick={onDisconnect}><Unplug aria-hidden="true" /></IconButton>
  </footer>;
}
