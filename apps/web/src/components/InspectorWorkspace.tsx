import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DragEvent, type JSX } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minus, MoreHorizontal, PanelRight, Plus, Square, SquareArrowOutUpRight, X } from "lucide-react";
import { Inspector, type InspectorProps } from "./Inspector.js";
import { InspectorDock, InspectorTabContribution, type InspectorDockTab } from "./inspector-layout-context.js";
import { INSPECTOR_EDGES, INSPECTOR_EXTENSION_OPEN_EVENT, INSPECTOR_TAB_DRAG_TYPE, inspectorDropEdge, inspectorExtensionIdentity,
  inspectorLayoutKey, readInspectorLayout, updateInspectorLayout, type InspectorEdge, type InspectorLayoutPreferences, type InspectorOpenMode } from "./inspector-layout.js";
import { detachedInspectorHostAlive, initializeDetachedInspectorHost, inspectorDetachAvailable, openDetachedInspectorWindow,
  syncDetachedInspectorDocument, type DetachedInspectorHost } from "./inspector-detach.js";
import { ExtensionMainViewPage, extensionMainViewReady } from "./ExtensionMainViewPage.js";
import { isExtensionApplicationWindow, openExtensionWindowFallback } from "../extension-window-navigation.js";
import type { AppShortcutOverrides } from "../app-shortcuts.js";
import { isSessionApplicationWindow } from "../session-window-navigation.js";
import { randomUuid } from "../web-crypto.js";
import { CLIENT_LAYOUT_RESET_EVENT } from "../client-layout-reset.js";
import { installCurrentWindowActivationClickGuard } from "../window-activation-click.js";
import { useAppShortcut } from "../use-app-shortcut.js";
import type { ExtensionCatalogEntryView } from "../model.js";
import type { Translator } from "./types.js";
import { IconButton, cx } from "./ui.js";
import "./inspector-dock.css";

type Props = Omit<InspectorProps, "session" | "dock"> & { readonly session?: InspectorProps["session"] };
interface TabWindow { readonly id: string; readonly host: DetachedInspectorHost; readonly occurrence: string; readonly order: string[];
  sessionId?: string; ready: boolean; closing: boolean; dispose: () => void }
interface Drag { readonly key: string; readonly nonce: string; cancelled: boolean }

export function InspectorWorkspace(props: Props): JSX.Element | null {
  const profile = props.controller.state.activeProfile;
  if (profile === undefined) return null;
  const owner = JSON.stringify([profile.id, profile.serverId, profile.origin, profile.endpointPublicKey]);
  return <Workspace key={`${owner}:${props.controller.state.connectionGeneration}`} {...props} owner={owner} />;
}

function Workspace({ owner, ...props }: Props & { readonly owner: string }): JSX.Element {
  const { controller, snapshot, session, t, open } = props;
  const [dock] = useState(() => new InspectorDock());
  const revision = useSyncExternalStore(dock.subscribe, dock.snapshot);
  const [preferences, setPreferences] = useState(() => readInspectorLayout(owner));
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  const [windows, setWindows] = useState<readonly TabWindow[]>([]);
  const windowsRef = useRef<readonly TabWindow[]>(windows); windowsRef.current = windows;
  const [dragEdge, setDragEdge] = useState<InspectorEdge>();
  const drag = useRef<Drag | undefined>(undefined), alive = useRef(true), parking = useRef<HTMLDivElement>(null);
  const attemptedWindows = useRef(new Set<string>());
  const pendingPlacements = useRef(new Map<string, { readonly edge?: InspectorEdge; readonly windowId?: string }>());
  const closeGuards = useRef(new Map<string, () => Promise<boolean>>());
  const lastSessionId = useRef(session?.id); if (session !== undefined) lastSessionId.current = session.id;
  const globalEnabled = !isSessionApplicationWindow(window.location) && !isExtensionApplicationWindow(window.location);
  const canDetach = globalEnabled && inspectorDetachAvailable(window.jokoDesktop);
  const current = useRef({ controller, snapshot, session, open, t }); current.current = { controller, snapshot, session, open, t };
  const commit = useCallback((change: (value: InspectorLayoutPreferences) => InspectorLayoutPreferences): void => {
    const next = updateInspectorLayout(owner, change); preferencesRef.current = next; setPreferences(next);
  }, [owner]);
  const refreshWindows = (): void => { setWindows([...windowsRef.current]); dock.changed(); };
  const plugin = (identity: string): ExtensionCatalogEntryView | undefined => current.current.snapshot.extensions.find(extension => inspectorExtensionIdentity(extension) === identity && extensionMainViewReady(extension));
  const visibleTabs = (): InspectorDockTab[] => [...dock.tabs.values()].filter(tab => tab.pluginIdentity !== undefined || open && tab.sessionId === session?.id);
  const edgeOf = (tab: InspectorDockTab): InspectorEdge => preferencesRef.current.groups[tab.key]
    ?? (tab.pluginIdentity === undefined ? "right" : preferencesRef.current.plugins[tab.pluginIdentity]?.edge ?? "right");
  const orderedTabs = (tabs: readonly InspectorDockTab[]): InspectorDockTab[] => {
    const order = Object.keys(preferencesRef.current.groups);
    return [...tabs].sort((a, b) => {
      const ai = order.indexOf(a.key), bi = order.indexOf(b.key);
      return ai < 0 && bi < 0 ? 0 : ai < 0 ? 1 : bi < 0 ? -1 : ai - bi;
    });
  };
  const setPluginMode = (tab: InspectorDockTab, mode: InspectorOpenMode, edge = edgeOf(tab)): void => {
    if (tab.pluginIdentity === undefined) return;
    const extension = plugin(tab.pluginIdentity); if (extension === undefined) return;
    commit(value => ({ ...value, plugins: { ...value.plugins, [tab.pluginIdentity!]: { extensionId: extension.id, mode, edge, open: true } } }));
  };
  const activate = (tab: InspectorDockTab, place: string): void => {
    dock.focusedGroup = place; dock.selected.set(place, tab.key); tab.onActivate(); dock.changed();
  };
  const move = (key: string, edge: InspectorEdge, before?: string): void => {
    const tab = dock.tabs.get(key); if (tab === undefined) return;
    dock.windows.delete(key); setPluginMode(tab, "sidebar", edge);
    commit(value => {
      const group = orderedTabs(visibleTabs().filter(candidate => !dock.windows.has(candidate.key) && edgeOf(candidate) === edge && candidate.key !== key));
      const keys = group.map(candidate => candidate.key), index = before === undefined ? -1 : keys.indexOf(before);
      keys.splice(index < 0 ? keys.length : index, 0, key);
      const groups = { ...value.groups }; for (const id of keys) delete groups[id];
      return { ...value, groups: { ...groups, ...Object.fromEntries(keys.map(id => [id, edge])) } };
    });
    activate(tab, edge); refreshWindows();
  };
  const returnWindow = (entry: TabWindow, closeNative = true): void => {
    if (!windowsRef.current.includes(entry)) return;
    for (const [key, id] of dock.windows) if (id === entry.id) dock.windows.delete(key);
    entry.dispose(); windowsRef.current = windowsRef.current.filter(candidate => candidate !== entry); refreshWindows();
    if (closeNative && !entry.host.window.closed) void entry.host.window.jokoInspectorDesktop?.window.close("user").catch(() => undefined);
  };
  const closeTabs = async (keys: readonly string[]): Promise<void> => {
    for (const key of keys) {
      const tab = dock.tabs.get(key); if (tab === undefined || !alive.current) continue;
      try { await tab.onClose(); } catch { /* Its original owner reports failure and retains the tab. */ }
    }
  };
  const createWindow = (keys: readonly string[], targetId?: string): void => {
    const tabs = keys.flatMap(key => { const tab = dock.tabs.get(key); return tab === undefined ? [] : [tab]; });
    if (!tabs.length) return;
    const nativeSessions = new Set(tabs.flatMap(tab => tab.sessionId === undefined ? [] : [tab.sessionId]));
    if (nativeSessions.size > 1) return;
    const taskId = nativeSessions.values().next().value as string | undefined;
    const target = windowsRef.current.find(entry => entry.id === targetId && detachedInspectorHostAlive(entry.host));
    if (target !== undefined && (taskId === undefined || target.sessionId === undefined || target.sessionId === taskId)) {
      if (taskId !== undefined) target.sessionId = taskId;
      for (const tab of tabs) { dock.windows.set(tab.key, target.id); if (!target.order.includes(tab.key)) target.order.push(tab.key); setPluginMode(tab, "window"); }
      activate(tabs[0]!, target.id); refreshWindows(); return;
    }
    if (!canDetach || windowsRef.current.length >= 8) return;
    const id = randomUuid().replaceAll("-", ""), child = openDetachedInspectorWindow(undefined, id);
    if (child === null) return;
    let host: DetachedInspectorHost;
    try { host = initializeDetachedInspectorHost(child, document, t("inspector.windowTitle")); }
    catch { child.close(); return; }
    void host.window.jokoInspectorDesktop!.window.identity().then(occurrence => {
      if (!alive.current || !/^[0-9a-f-]{36}$/u.test(occurrence) || tabs.some(tab => dock.tabs.get(tab.key)?.owner !== tab.owner)) {
        void host.window.jokoInspectorDesktop?.window.close("passive").catch(() => undefined); return;
      }
      const entry: TabWindow = { id, host, occurrence, order: tabs.map(tab => tab.key), sessionId: taskId, ready: false, closing: false, dispose: () => undefined };
      const stopGuard = installCurrentWindowActivationClickGuard(host.window);
      const stopClose = host.window.jokoInspectorDesktop?.window.onCloseRequested?.(() => { void closeTabs([...dock.windows].filter(([, value]) => value === id).map(([key]) => key)); });
      entry.dispose = () => { stopGuard(); stopClose?.(); };
      windowsRef.current = [...windowsRef.current, entry];
      for (const tab of tabs) { dock.windows.set(tab.key, id); setPluginMode(tab, "window"); }
      activate(tabs[0]!, id); refreshWindows();
    }).catch(() => { void host.window.jokoInspectorDesktop?.window.close("passive").catch(() => undefined); });
  };
  const handlePlugin = (extensionId: string, requested?: InspectorOpenMode | "reset"): void => {
    const extension = current.current.snapshot.extensions.find(candidate => candidate.id === extensionId && extensionMainViewReady(candidate));
    if (extension === undefined) return;
    const identity = inspectorExtensionIdentity(extension), old = preferencesRef.current.plugins[identity];
    if (requested === "reset") { commit(value => { const plugins = { ...value.plugins }; delete plugins[identity]; return { ...value, plugins }; }); return; }
    const mode = requested ?? old?.mode ?? extension.mainView?.open ?? "page", edge = old?.edge ?? extension.mainView?.side ?? "right";
    const existing = dock.tabs.get(`plugin:${identity}`);
    const apply = async (): Promise<void> => {
      if (mode === "page" && existing !== undefined && !extension.mainView?.multiple && !await (closeGuards.current.get(identity)?.() ?? Promise.resolve(true))) return;
      if (!alive.current) return;
      commit(value => ({ ...value, plugins: { ...value.plugins, [identity]: { extensionId, mode, edge, open: mode !== "page" } } }));
      if (mode === "page") {
        current.current.controller.navigate({ kind: "extensionMainView", extensionId }); return;
      }
      if (current.current.controller.state.route.kind === "extensionMainView" && current.current.controller.state.route.extensionId === extensionId && !extension.mainView?.multiple) {
        current.current.controller.navigate({ kind: "session", ...(lastSessionId.current === undefined ? {} : { sessionId: lastSessionId.current }) });
      }
      if (mode === "window") {
        attemptedWindows.current.delete(identity);
        if (existing !== undefined && dock.windows.has(existing.key)) {
          const target = windowsRef.current.find(entry => entry.id === dock.windows.get(existing.key));
          if (target !== undefined) void window.jokoDesktop?.inspectorWindow.activate(target.occurrence);
          attemptedWindows.current.add(identity);
        }
      } else if (existing !== undefined) move(existing.key, edge);
    };
    void apply();
  };
  useEffect(() => {
    const changed = (event: StorageEvent): void => { if (event.key === null || event.key === inspectorLayoutKey(owner)) setPreferences(readInspectorLayout(owner)); };
    const openPlugin = (event: Event): void => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.extensionId !== "string" || event.detail.mode !== undefined && !["page", "sidebar", "window", "reset"].includes(event.detail.mode)) return;
      handlePlugin(event.detail.extensionId, event.detail.mode);
    };
    const reset = (): void => { commit(() => ({ groups: {}, plugins: {} })); for (const entry of [...windowsRef.current]) returnWindow(entry); };
    window.addEventListener("storage", changed); window.addEventListener(INSPECTOR_EXTENSION_OPEN_EVENT, openPlugin); window.addEventListener(CLIENT_LAYOUT_RESET_EVENT, reset);
    return () => { window.removeEventListener("storage", changed); window.removeEventListener(INSPECTOR_EXTENSION_OPEN_EVENT, openPlugin); window.removeEventListener(CLIENT_LAYOUT_RESET_EVENT, reset); };
  });
  useEffect(() => window.jokoDesktop?.inspectorWindow.onClosed(event => {
    const entry = windowsRef.current.find(candidate => candidate.occurrence === event.occurrence);
    if (entry !== undefined) returnWindow(entry, false);
  }), []);
  useEffect(() => () => {
    alive.current = false;
    for (const entry of windowsRef.current) { entry.dispose(); void entry.host.window.jokoInspectorDesktop?.window.close("passive").catch(() => undefined); }
    windowsRef.current = [];
  }, []);
  useLayoutEffect(() => {
    for (const tab of dock.tabs.values()) if (!dock.windows.has(tab.key) && !visibleTabs().includes(tab) && parking.current !== null) {
      if (tab.node.parentNode !== parking.current) parking.current.append(tab.node); tab.node.hidden = true;
    }
    for (const entry of [...windowsRef.current]) {
      if (![...dock.windows].some(([key, id]) => id === entry.id && dock.tabs.has(key))) {
        entry.closing = true; returnWindow(entry); continue;
      }
      syncDetachedInspectorDocument(entry.host.window, document);
      if (!entry.ready) {
        entry.ready = true;
        window.requestAnimationFrame(() => {
          if (!alive.current || !windowsRef.current.includes(entry)) return;
          void entry.host.window.jokoInspectorDesktop?.window.ready().catch(() => returnWindow(entry));
        });
      }
    }
  }, [revision, windows, preferences, session?.id, open]);
  useEffect(() => {
    for (const tab of dock.tabs.values()) if (tab.pluginIdentity !== undefined && preferences.plugins[tab.pluginIdentity]?.mode === "window"
      && !dock.windows.has(tab.key) && !attemptedWindows.current.has(tab.pluginIdentity)) {
      attemptedWindows.current.add(tab.pluginIdentity);
      if (canDetach) createWindow([tab.key]);
      else {
        const profile = controller.state.activeProfile, extension = plugin(tab.pluginIdentity);
        if (profile !== undefined && extension !== undefined) {
          commit(value => ({ ...value, plugins: { ...value.plugins, [tab.pluginIdentity!]: { ...value.plugins[tab.pluginIdentity!]!, open: false } } }));
          if (window.jokoDesktop?.capabilities.includes("extension.windows")) void window.jokoDesktop.extensionWindows.open({ extensionId: extension.id, profileId: profile.id, serverId: profile.serverId }).catch(() => undefined);
          else openExtensionWindowFallback(window.location, extension.id, { profileId: profile.id, serverId: profile.serverId });
        }
      }
    }
  }, [revision, preferences]);
  useEffect(() => {
    const allowed = new Set(snapshot.extensions.filter(extensionMainViewReady).map(inspectorExtensionIdentity));
    const stale = Object.keys(preferencesRef.current.plugins).filter(identity => !allowed.has(identity));
    if (stale.length) commit(value => ({ ...value, plugins: Object.fromEntries(Object.entries(value.plugins).filter(([identity]) => allowed.has(identity))) }));
  }, [snapshot.extensions, commit]);
  const drop = (event: DragEvent, edge?: InspectorEdge, windowId?: string, before?: string): void => {
    event.preventDefault(); event.stopPropagation();
    let value: unknown;
    try { value = JSON.parse(event.dataTransfer.getData(INSPECTOR_TAB_DRAG_TYPE)); } catch { return; }
    const captured = drag.current;
    if (!captured || captured.cancelled || value === null || typeof value !== "object" || Reflect.get(value, "owner") !== owner
      || Reflect.get(value, "key") !== captured.key || Reflect.get(value, "nonce") !== captured.nonce || !dock.tabs.has(captured.key)) return;
    drag.current = undefined; setDragEdge(undefined);
    if (windowId !== undefined) createWindow([captured.key], windowId); else if (edge !== undefined) move(captured.key, edge, before);
  };
  useEffect(() => {
    const over = (event: globalThis.DragEvent): void => {
      const surface = document.getElementById("main-content"), target = event.target instanceof Element ? event.target : null;
      if (!drag.current || !surface || target?.closest(".inspector-dock-group") || !surface.contains(target)) return;
      event.preventDefault(); setDragEdge(inspectorDropEdge(surface.getBoundingClientRect(), event.clientX, event.clientY));
    };
    const dropped = (event: globalThis.DragEvent): void => {
      if (dragEdge !== undefined) drop(event as unknown as DragEvent, dragEdge);
    };
    const cancel = (event: KeyboardEvent): void => { if (event.key === "Escape" && drag.current) { drag.current.cancelled = true; setDragEdge(undefined); } };
    document.addEventListener("dragover", over); document.addEventListener("drop", dropped); document.addEventListener("keydown", cancel, true);
    return () => { document.removeEventListener("dragover", over); document.removeEventListener("drop", dropped); document.removeEventListener("keydown", cancel, true); };
  }, [dragEdge]);
  dock.onTabAdded = tab => {
    const placement = pendingPlacements.current.get(tab.owner); if (placement === undefined) return;
    pendingPlacements.current.delete(tab.owner);
    queueMicrotask(() => {
      if (!alive.current || dock.tabs.get(tab.key)?.owner !== tab.owner) return;
      if (placement.windowId !== undefined) createWindow([tab.key], placement.windowId);
      else if (placement.edge !== undefined) move(tab.key, placement.edge);
    });
  };
  const nativeSessionIds = new Set([...windows.flatMap(entry => entry.sessionId === undefined ? [] : [entry.sessionId]), ...(session === undefined ? [] : [session.id])]);
  const group = (place: string, tabs: readonly InspectorDockTab[], edge?: InspectorEdge, entry?: TabWindow): JSX.Element => <DockGroup
    key={place} {...{ dock, place, tabs, edge, entry, t, activate, drop, canDetach }}
    onMove={move} onWindow={createWindow} onClose={keys => { void closeTabs(keys); }}
    onMerge={entry === undefined ? undefined : () => returnWindow(entry)}
    onAdd={action => { const nativeOwner = dock.sessionOwners.get(entry?.sessionId ?? session?.id ?? "");
      if (nativeOwner === undefined) return;
      pendingPlacements.current.set(nativeOwner, entry === undefined ? { edge } : { windowId: entry.id });
      action(); }}
    actions={[...(dock.actions.get(dock.sessionOwners.get(entry?.sessionId ?? session?.id ?? "") ?? "") ?? [])]}
    shortcutOverrides={controller.state.preferences.appShortcutOverrides}
    windows={windows}
    onDragStart={(event, key) => { const nonce = randomUuid(); drag.current = { key, nonce, cancelled: false }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(INSPECTOR_TAB_DRAG_TYPE, JSON.stringify({ owner, key, nonce })); }}
    onDragEnd={event => {
      const captured = drag.current; drag.current = undefined; setDragEdge(undefined);
      if (!captured || captured.cancelled || event.dataTransfer.dropEffect !== "none" || event.screenX === 0 && event.screenY === 0) return;
      const hosts = [window, ...windowsRef.current.map(item => item.host.window)];
      if (hosts.some(host => !host.closed && event.screenX >= host.screenX && event.screenX < host.screenX + host.outerWidth && event.screenY >= host.screenY && event.screenY < host.screenY + host.outerHeight)) return;
      createWindow([captured.key]);
    }} />;
  return <div className="inspector-dock-layout">
    <div ref={parking} hidden />
    {[...nativeSessionIds].map(id => {
      const candidate = snapshot.sessions.find(item => item.id === id); if (candidate === undefined) return null;
      const selected = id === session?.id, target = snapshot.targets.find(item => item.id === candidate.targetId);
      const workspaceId = candidate.localWorkspace?.workspaceId ?? (candidate.worktree?.state === "active" ? candidate.worktree.workspaceId : candidate.worktree === undefined ? target?.workspaceId : undefined);
      return <Inspector key={`${id}:${candidate.generation}`} {...props} dock={dock} session={candidate}
        open={selected ? open : true} onDetachedChange={undefined} onClose={selected ? props.onClose : () => undefined}
        timeline={selected ? props.timeline : snapshot.timelineBySession.get(id) ?? []}
        workspace={selected ? props.workspace : snapshot.workspaces.find(item => item.id === workspaceId)}
        subagentFocusRequest={selected ? props.subagentFocusRequest : undefined} turnReviewFocusRequest={selected ? props.turnReviewFocusRequest : undefined}
        browserFocusRequest={selected ? props.browserFocusRequest : undefined} gamepadRequest={selected ? props.gamepadRequest : undefined} />;
    })}
    {globalEnabled && snapshot.extensions.filter(extensionMainViewReady).map(extension => {
      const identity = inspectorExtensionIdentity(extension), placement = preferences.plugins[identity];
      if (!placement?.open || placement.mode === "page") return null;
      const key = `plugin:${identity}`;
      return <InspectorTabContribution key={identity} dock={dock} owner={identity}
        tabs={[{ key, pluginIdentity: identity, label: extension.mainView?.title ?? extension.name, kind: "extension", onActivate: () => undefined,
          onClose: async () => { if (!await (closeGuards.current.get(identity)?.() ?? Promise.resolve(true)) || !alive.current) return;
            commit(value => ({ ...value, plugins: { ...value.plugins, [identity]: { ...value.plugins[identity]!, open: false } } })); } }]}
        render={(_key, _active, ownerDocument) => <ExtensionMainViewPage controller={controller} extensionId={extension.id} t={t} embedded ownerDocument={ownerDocument}
          navigationOpen onOpenNavigation={() => undefined} onOpenIndependent={() => createWindow([key])}
          registerCloseGuard={guard => { closeGuards.current.set(identity, guard); return () => { if (closeGuards.current.get(identity) === guard) closeGuards.current.delete(identity); }; }} />}
      />;
    })}
    {INSPECTOR_EDGES.map(edge => { const tabs = orderedTabs(visibleTabs().filter(tab => !dock.windows.has(tab.key) && edgeOf(tab) === edge)); return tabs.length || edge === "right" && open && session !== undefined && ![...dock.tabs.values()].some(tab => tab.sessionId === session.id) ? group(edge, tabs, edge) : null; })}
    {windows.map(entry => createPortal(<div className="inspector-window-shell inspector-dock-window">
      <header className="inspector-window-titlebar"><PanelRight aria-hidden="true" /><span>{t("inspector.windowLabel")}</span><IconButton label={t("inspector.mergeBack")} onClick={() => returnWindow(entry)}><PanelRight /></IconButton></header>
      {group(entry.id, entry.order.flatMap(key => dock.windows.get(key) === entry.id && dock.tabs.has(key) ? [dock.tabs.get(key)!] : []), undefined, entry)}
      {entry.host.window.jokoInspectorDesktop?.platform !== "darwin" && <div className="inspector-window-controls"><IconButton label={t("desktop.minimize")} onClick={() => { void entry.host.window.jokoInspectorDesktop?.window.minimize(); }}><Minus /></IconButton><IconButton label={t("desktop.maximizeOrRestore")} onClick={() => { void entry.host.window.jokoInspectorDesktop?.window.toggleMaximize(); }}><Square /></IconButton><IconButton label={t("desktop.close")} onClick={() => { void closeTabs([...dock.windows].filter(([, id]) => id === entry.id).map(([key]) => key)); }}><X /></IconButton></div>}
    </div>, entry.host.root, entry.id))}
    {dragEdge !== undefined && <div className={`inspector-dock-drop-preview is-${dragEdge}`} aria-hidden="true" />}
  </div>;
}

function DockGroup({ dock, place, tabs, edge, entry, t, activate, drop, canDetach, onMove, onWindow, onClose, onMerge, onAdd, actions, windows, onDragStart, onDragEnd, shortcutOverrides }: {
  readonly dock: InspectorDock; readonly place: string; readonly tabs: readonly InspectorDockTab[]; readonly edge?: InspectorEdge; readonly entry?: TabWindow; readonly t: Translator;
  readonly activate: (tab: InspectorDockTab, place: string) => void; readonly drop: (event: DragEvent, edge?: InspectorEdge, windowId?: string, before?: string) => void;
  readonly canDetach: boolean; readonly onMove: (key: string, edge: InspectorEdge, before?: string) => void; readonly onWindow: (keys: readonly string[], target?: string) => void;
  readonly onClose: (keys: readonly string[]) => void; readonly onMerge?: () => void; readonly onAdd: (action: () => void) => void;
  readonly actions: readonly { readonly id: string; readonly label: string; readonly disabled?: boolean; readonly run: () => void }[]; readonly windows: readonly TabWindow[];
  readonly onDragStart: (event: DragEvent, key: string) => void; readonly onDragEnd: (event: DragEvent) => void;
  readonly shortcutOverrides?: AppShortcutOverrides;
}): JSX.Element {
  const body = useRef<HTMLDivElement>(null), root = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState(false), [adding, setAdding] = useState(false), [maximized, setMaximized] = useState(false);
  const selected = dock.selected.get(place), active = tabs.find(tab => tab.key === selected) ?? tabs[0];
  useLayoutEffect(() => {
    if (body.current === null) return;
    let changed = false;
    for (const tab of tabs) {
      if (tab.node.parentNode !== body.current) { body.current.append(tab.node); changed = true; }
      const hidden = tab !== active;
      if (tab.node.hidden !== hidden) { tab.node.hidden = hidden; changed = true; }
    }
    if (changed) dock.changed();
  });
  const cycle = (direction: number): boolean => {
    if (dock.focusedGroup !== place || !tabs.length) return false;
    const index = active === undefined ? 0 : tabs.indexOf(active); activate(tabs[(index + direction + tabs.length) % tabs.length]!, place); return true;
  };
  const target = entry?.host.window ?? window;
  useAppShortcut("right-tab-prev", shortcutOverrides, () => cycle(-1), { target, stopImmediate: true });
  useAppShortcut("right-tab-next", shortcutOverrides, () => cycle(1), { target, stopImmediate: true });
  useAppShortcut("close-tab-or-window", shortcutOverrides, () => { if (dock.focusedGroup !== place || active === undefined) return false; onClose([active.key]); return true; }, { target });
  useAppShortcut("open-terminal", shortcutOverrides, () => { const action = actions.find(item => item.id === "terminal"); if (dock.focusedGroup !== place || !action || action.disabled) return false; onAdd(action.run); return true; }, { target, stopImmediate: true });
  return <aside ref={root} className={cx("inspector-dock-group", maximized && "is-maximized")} data-edge={edge}
    aria-label={t("a11y.inspectorTabs")} onFocusCapture={() => { dock.focusedGroup = place; }} onPointerDown={() => { dock.focusedGroup = place; }}
    onDragOver={event => { if (event.dataTransfer.types.includes(INSPECTOR_TAB_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
    onDrop={event => drop(event, edge, entry?.id)}>
    <header className="inspector-dock-group__header">
      <div className="inspector-tabs" role="tablist" aria-label={t("a11y.inspectorTabs")}>
        {tabs.map(tab => <div key={tab.key} className={cx("inspector-tab", tab === active && "is-active")} draggable
          onDragStart={event => onDragStart(event, tab.key)} onDragEnd={onDragEnd}
          onDrop={event => drop(event, edge, entry?.id, tab.key)}>
          <button type="button" role="tab" id={`inspector-tab-${tab.sessionId === undefined ? tab.key : JSON.parse(tab.key)[2]}`} aria-selected={tab === active} tabIndex={tab === active ? 0 : -1}
            onClick={() => activate(tab, place)} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); cycle(event.key === "ArrowLeft" ? -1 : 1); } }}><span>{tab.label}</span></button>
          <IconButton className="inspector-tab__close" label={t("inspector.closeNamedTab", { name: tab.label })} onClick={() => onClose([tab.key])}><X /></IconButton>
        </div>)}
      </div>
      {actions.length > 0 && <div className="inspector-menu"><IconButton label={t("inspector.addTab")} aria-haspopup="menu" aria-expanded={adding} onClick={() => { setAdding(!adding); setMenu(false); }}><Plus /></IconButton>
        {adding && <div className="inspector-menu__popover" role="menu">{actions.map(action => <button type="button" role="menuitem" key={action.id} disabled={action.disabled} onClick={() => { setAdding(false); onAdd(action.run); }}>{action.label}</button>)}</div>}</div>}
      <div className="inspector-menu"><IconButton label={t("a11y.inspectorTabActions")} aria-haspopup="menu" aria-expanded={menu} onClick={() => { setMenu(!menu); setAdding(false); }}><MoreHorizontal /></IconButton>
        {menu && <div className="inspector-menu__popover inspector-menu__popover--right" role="menu">
          {active !== undefined && INSPECTOR_EDGES.map(side => <button type="button" role="menuitem" key={side} onClick={() => { setMenu(false); onMove(active.key, side); }}>{t(`inspector.group.${side}`)}</button>)}
          {canDetach && active !== undefined && <button type="button" role="menuitem" onClick={() => { setMenu(false); onWindow([active.key]); }}><SquareArrowOutUpRight />{t("inspector.detachTab")}</button>}
          {canDetach && entry === undefined && <button type="button" role="menuitem" onClick={() => { setMenu(false); onWindow(tabs.map(tab => tab.key)); }}>{t("inspector.detachGroup")}</button>}
          {active !== undefined && windows.filter(item => item !== entry && (active.sessionId === undefined || item.sessionId === undefined || active.sessionId === item.sessionId)).map(item => <button type="button" role="menuitem" key={item.id} onClick={() => { setMenu(false); onWindow([active.key], item.id); }}>{t("inspector.moveToWindow", { name: item.order.flatMap(key => dock.tabs.get(key)?.label ?? []).join(", ") })}</button>)}
          {onMerge !== undefined && <button type="button" role="menuitem" onClick={onMerge}>{t("inspector.mergeBack")}</button>}
          <button type="button" role="menuitem" onClick={() => { setMenu(false); setMaximized(!maximized); }}><Maximize2 />{t(maximized ? "inspector.restore" : "inspector.maximize")}</button>
          {active !== undefined && <button type="button" role="menuitem" onClick={() => { setMenu(false); onClose(tabs.filter(tab => tab !== active).map(tab => tab.key)); }}>{t("inspector.closeOtherTabs")}</button>}
          <button type="button" role="menuitem" onClick={() => { setMenu(false); onClose(tabs.map(tab => tab.key)); }}>{t("inspector.closeAllTabs")}</button>
        </div>}
      </div>
    </header>
    <div className="inspector-dock-group__body" ref={body} />
  </aside>;
}
