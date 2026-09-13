import {
  useEffect,
  useRef,
  useState,
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
  const [compactDrawer, setCompactDrawer] = useState(() => browserMatchesSidebarDrawer());
  const railPresentation = props.mode === "rail" && !compactDrawer;
  // Treat an initially-open compact shell as a drawer opening as well. The
  // The desktop window may launch at the 800px minimum with navigation
  // persisted open, and keyboard focus must not remain behind its scrim.
  const previousDrawerRef = useRef({ open: false, compact: false });

  useEffect(() => {
    const ownerWindow = rootRef.current?.ownerDocument.defaultView;
    if (ownerWindow?.matchMedia === undefined) return;
    const media = ownerWindow.matchMedia(SIDEBAR_DRAWER_MEDIA_QUERY);
    const changed = (event: MediaQueryListEvent): void => setCompactDrawer(event.matches);
    setCompactDrawer(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const ownerDocument = root?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (root === null || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;

    const previous = previousDrawerRef.current;
    previousDrawerRef.current = { open: props.open, compact: compactDrawer };
    const opening = compactDrawer && props.open && (!previous.open || !previous.compact);
    const closing = previous.compact && previous.open && !props.open;

    if (opening) {
      const active = ownerDocument.activeElement;
      if (active instanceof ownerWindow.HTMLElement && active !== ownerDocument.body && !root.contains(active)) {
        returnFocusRef.current = active;
      }
      root.querySelector<HTMLElement>(".sidebar__mobile-close")?.focus({ preventScroll: true });
    } else if (closing) {
      const previousFocus = returnFocusRef.current;
      returnFocusRef.current = null;
      const safePrevious = previousFocus?.isConnected === true
        && previousFocus.closest("[inert], [aria-hidden='true']") === null
        ? previousFocus
        : null;
      (safePrevious ?? drawerRestoreFocusRef.current?.() ?? ownerDocument.getElementById("main-content"))?.focus({ preventScroll: true });
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
  }, [compactDrawer, props.open]);

  return <aside
    ref={rootRef}
    className={cx("sidebar", props.open && "is-open", props.mode === "rail" && "is-rail", props.className)}
    aria-label={props.t("a11y.taskNavigation")}
    aria-hidden={!props.open}
    inert={!props.open}
    tabIndex={-1}
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

function browserMatchesSidebarDrawer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(SIDEBAR_DRAWER_MEDIA_QUERY).matches === true;
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
