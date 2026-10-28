import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DragEvent, type JSX } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minus, MoreHorizontal, PanelRight, Plus, Square, SquareArrowOutUpRight, X } from "lucide-react";
import { Inspector, type InspectorProps } from "./Inspector.js";
import { InspectorDock, InspectorTabContribution, moveInspectorMount, type InspectorDockTab } from "./inspector-layout-context.js";
import { INSPECTOR_EDGES, INSPECTOR_EXTENSION_OPEN_EVENT, INSPECTOR_TAB_DRAG_TYPE, inspectorDropEdge, inspectorExtensionIdentity,
  acknowledgeInspectorExtensionRequest, drainInspectorExtensionRequests, inspectorLayoutOwner, inspectorLayoutKey, readInspectorLayout, updateInspectorLayout, type InspectorEdge, type InspectorLayoutPreferences, type InspectorOpenMode } from "./inspector-layout.js";
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
import { PartnerConversationProvider, usePartnerConversation } from "./PartnerConversation.js";
import "./inspector-dock.css";

type Props = Omit<InspectorProps, "session" | "dock"> & { readonly session?: InspectorProps["session"] };
interface TabWindow { readonly id: string; readonly host: DetachedInspectorHost; readonly occurrence: string; readonly order: string[];
  sessionId?: string; sessionOwner?: string; ready: boolean; closing: boolean; userClosing: boolean; dispose: () => void }
interface Drag { readonly key: string; readonly nonce: string; cancelled: boolean }

export function InspectorWorkspace(props: Props): JSX.Element | null {
  const profile = props.controller.state.activeProfile;
  if (profile === undefined) return null;
  const owner = inspectorLayoutOwner(profile)!;
  return <Workspace key={`${owner}:${props.controller.state.connectionGeneration}`} {...props} owner={owner} />;
}

function Workspace({ owner, ...props }: Props & { readonly owner: string }): JSX.Element {
  const { controller, snapshot, session, t, open } = props;
  const sourceConversation = usePartnerConversation();
  const [defaultSide, setDefaultSide] = useState<InspectorEdge>(() => { try { return window.localStorage.getItem("joko.session.inspectorSide") === "left" ? "left" : "right"; } catch { return "right"; } });
  const [dock] = useState(() => { const value = new InspectorDock(); value.focusedGroup = defaultSide; return value; });
  const revision = useSyncExternalStore(dock.subscribe, dock.snapshot);
  const [preferences, setPreferences] = useState(() => readInspectorLayout(owner));
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  const [windows, setWindows] = useState<readonly TabWindow[]>([]);
  const windowsRef = useRef<readonly TabWindow[]>(windows); windowsRef.current = windows;
  const [dragEdge, setDragEdge] = useState<InspectorEdge>();
  const drag = useRef<Drag | undefined>(undefined), alive = useRef(true), parking = useRef<HTMLDivElement>(null);
  const attemptedWindows = useRef(new Set<string>());
  const pendingWindowKeys = useRef(new Set<string>());
  const retainedSessions = useRef(new Map<string, string>());
  const pluginRequests = useRef(new Map<string, object>());
  const pendingPlacements = useRef(new Map<string, { readonly edge?: InspectorEdge; readonly windowId?: string }>());
  const closeGuards = useRef(new Map<string, () => Promise<boolean>>());
  const lastSessionId = useRef(session?.id); if (session !== undefined) lastSessionId.current = session.id;
  const globalEnabled = !isSessionApplicationWindow(window.location) && !isExtensionApplicationWindow(window.location);
  const canDetach = globalEnabled && inspectorDetachAvailable(window.jokoDesktop) && window.jokoDesktop?.capabilities.includes("inspector.tabs") === true;
  const current = useRef({ controller, snapshot, session, open, t }); current.current = { controller, snapshot, session, open, t };
  const commit = useCallback((change: (value: InspectorLayoutPreferences) => InspectorLayoutPreferences): void => {
    const next = updateInspectorLayout(owner, change); preferencesRef.current = next; setPreferences(next);
  }, [owner]);
  const refreshWindows = (): void => { setWindows([...windowsRef.current]); dock.changed(); };
  const plugin = (identity: string): ExtensionCatalogEntryView | undefined => current.current.snapshot.extensions.find(extension => inspectorExtensionIdentity(extension) === identity && extensionMainViewReady(extension));
  const visibleTabs = (): InspectorDockTab[] => [...dock.tabs.values()].filter(tab => tab.pluginIdentity !== undefined || open && tab.sessionId === session?.id);
  const edgeOf = (tab: InspectorDockTab): InspectorEdge => preferencesRef.current.groups[tab.key]
    ?? (tab.pluginIdentity === undefined ? defaultSide : preferencesRef.current.plugins[tab.pluginIdentity]?.edge ?? "right");
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
    dock.focusedGroup = place; dock.selected.set(place, tab.key); dock.tabs.get(tab.key)?.onActivate(); dock.changed();
  };
  dock.revealTab = key => {
    const tab = dock.tabs.get(key); if (tab === undefined) return;
    const windowId = dock.windows.get(key), place = windowId ?? edgeOf(tab);
    dock.focusedGroup = place; dock.selected.set(place, key); dock.changed();
    const entry = windowsRef.current.find(candidate => candidate.id === windowId);
    if (entry !== undefined) void window.jokoDesktop?.inspectorWindow.activate(entry.occurrence).catch(() => undefined);
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
  const returnWindow = (entry: TabWindow, closeNative = true, closeKind: "user" | "passive" = "user"): void => {
    if (!windowsRef.current.includes(entry)) return;
    for (const [key, id] of dock.windows) if (id === entry.id) dock.windows.delete(key);
    if (dock.focusedGroup === entry.id) dock.focusedGroup = defaultSide;
    entry.dispose(); windowsRef.current = windowsRef.current.filter(candidate => candidate !== entry); refreshWindows();
    if (closeNative && !entry.host.window.closed) void entry.host.window.jokoInspectorDesktop?.window.close(closeKind).catch(() => undefined);
  };
  const closeTabs = async (keys: readonly string[]): Promise<void> => {
    for (const entry of windowsRef.current) if (keys.some(key => dock.windows.get(key) === entry.id)) entry.userClosing = true;
    for (const key of keys) {
      const tab = dock.tabs.get(key); if (tab === undefined || !alive.current) continue;
      try { await tab.onClose(); } catch { /* Its original owner reports failure and retains the tab. */ }
    }
  };
  const createWindow = (keys: readonly string[], targetId?: string, before?: string): void => {
    const tabs = keys.flatMap(key => { const tab = dock.tabs.get(key); return tab === undefined ? [] : [tab]; });
    if (!tabs.length) return;
    const nativeSessions = new Set(tabs.flatMap(tab => tab.sessionId === undefined ? [] : [tab.sessionId]));
    if (nativeSessions.size > 1) return;
    const taskId = nativeSessions.values().next().value as string | undefined;
    const source = taskId === undefined ? undefined : current.current.snapshot.sessions.find(candidate => candidate.id === taskId);
    if (taskId !== undefined && (source === undefined || !retainedSessions.current.has(taskId) && retainedSessions.current.size >= 200)) return;
    const rememberSource = (): void => { if (source !== undefined) retainedSessions.current.set(source.id, JSON.stringify([source.backendId, source.targetId, source.generation.toString()])); };
    const target = windowsRef.current.find(entry => entry.id === targetId && detachedInspectorHostAlive(entry.host));
    if (target !== undefined && (taskId === undefined || target.sessionId === undefined || target.sessionId === taskId)) {
      if (taskId !== undefined) { target.sessionId = taskId; target.sessionOwner = source === undefined ? undefined : JSON.stringify([source.backendId, source.targetId, source.generation.toString()]); }
      rememberSource();
      for (const tab of tabs) {
        dock.windows.set(tab.key, target.id);
        const oldIndex = target.order.indexOf(tab.key); if (oldIndex >= 0) target.order.splice(oldIndex, 1);
        const index = before === undefined ? -1 : target.order.indexOf(before); target.order.splice(index < 0 ? target.order.length : index, 0, tab.key);
        setPluginMode(tab, "window");
      }
      activate(tabs[0]!, target.id); refreshWindows(); return;
    }
    if (!canDetach || windowsRef.current.length + pendingWindowKeys.current.size >= 8 || tabs.some(tab => pendingWindowKeys.current.has(tab.key))) return;
    for (const tab of tabs) pendingWindowKeys.current.add(tab.key);
    const releasePending = (): void => { for (const tab of tabs) pendingWindowKeys.current.delete(tab.key); };
    const id = randomUuid().replaceAll("-", ""), child = openDetachedInspectorWindow(undefined, id);
    if (child === null) { releasePending(); return; }
    let host: DetachedInspectorHost;
    try { host = initializeDetachedInspectorHost(child, document, t("inspector.windowTitle")); }
    catch { releasePending(); child.close(); return; }
    void host.window.jokoInspectorDesktop!.window.identity().then(occurrence => {
      if (!alive.current || !/^[0-9a-f-]{36}$/u.test(occurrence) || tabs.some(tab => dock.tabs.get(tab.key)?.owner !== tab.owner)) {
        void host.window.jokoInspectorDesktop?.window.close("passive").catch(() => undefined); return;
      }
      const entry: TabWindow = { id, host, occurrence, order: tabs.map(tab => tab.key), sessionId: taskId,
        sessionOwner: source === undefined ? undefined : JSON.stringify([source.backendId, source.targetId, source.generation.toString()]), ready: false, closing: false, userClosing: false, dispose: () => undefined };
      rememberSource();
      const stopGuard = installCurrentWindowActivationClickGuard(host.window);
      const stopClose = host.window.jokoInspectorDesktop?.window.onCloseRequested?.(() => { void closeTabs([...dock.windows].filter(([, value]) => value === id).map(([key]) => key)); });
      entry.dispose = () => { stopGuard(); stopClose?.(); };
      windowsRef.current = [...windowsRef.current, entry];
      for (const tab of tabs) { dock.windows.set(tab.key, id); setPluginMode(tab, "window"); }
      activate(tabs[0]!, id); refreshWindows();
    }).catch(() => { void host.window.jokoInspectorDesktop?.window.close("passive").catch(() => undefined); }).finally(releasePending);
  };
  const guardedPlacement = (keys: readonly string[], action: () => void): void => {
    const captured = keys.flatMap(key => { const tab = dock.tabs.get(key); return tab ? [tab] : []; });
    const guards = captured.flatMap(tab => tab.pluginIdentity === undefined ? [] : closeGuards.current.get(tab.pluginIdentity) ?? []);
    if (!guards.length) { action(); return; }
    void (async () => {
      for (const guard of guards) if (!await guard()) return;
      if (alive.current && captured.every(tab => dock.tabs.get(tab.key)?.owner === tab.owner)) action();
    })();
  };
  const handlePlugin = (extensionId: string, requested?: InspectorOpenMode | "reset"): void => {
    const extension = current.current.snapshot.extensions.find(candidate => candidate.id === extensionId && extensionMainViewReady(candidate));
    if (extension === undefined) return;
    if (!globalEnabled && requested !== "reset") {
      const profile = controller.state.activeProfile;
      if (requested === "window" && profile !== undefined) {
        if (window.jokoDesktop?.capabilities.includes("extension.windows")) void window.jokoDesktop.extensionWindows.open({ extensionId, profileId: profile.id, serverId: profile.serverId }).catch(() => undefined);
        else openExtensionWindowFallback(window.location, extensionId, { profileId: profile.id, serverId: profile.serverId });
      } else controller.navigate({ kind: "extensionMainView", extensionId });
      return;
    }
    const identity = inspectorExtensionIdentity(extension), old = preferencesRef.current.plugins[identity];
    if (requested === "reset") {
      const key = `plugin:${identity}`;
      guardedPlacement([key], () => {
        dock.windows.delete(key); attemptedWindows.current.add(identity);
        commit(value => { const groups = { ...value.groups }; delete groups[key];
          return { ...value, groups, plugins: { ...value.plugins, [identity]: { extensionId, mode: extension.mainView?.open ?? "page", edge: extension.mainView?.side ?? "right", open: old?.open === true } } }; });
        refreshWindows();
      }); return;
    }
    const mode = requested ?? old?.mode ?? extension.mainView?.open ?? "page", edge = old?.edge ?? extension.mainView?.side ?? "right";
    const existing = dock.tabs.get(`plugin:${identity}`);
    const request = {}; pluginRequests.current.set(identity, request);
    const requestCurrent = (): boolean => alive.current && pluginRequests.current.get(identity) === request && plugin(identity) !== undefined;
    const navigate = async (route: Parameters<typeof controller.navigate>[0]): Promise<boolean> => {
      const before = current.current.controller.state.navigationRevision ?? 0;
      current.current.controller.navigate(route);
      const deadline = Date.now() + 12_000;
      while (requestCurrent() && Date.now() < deadline) {
        const state = current.current.controller.state, actual = state.route;
        const matched = actual.kind === route.kind && (route.kind !== "extensionMainView" || actual.kind === "extensionMainView" && actual.extensionId === route.extensionId)
          && (route.kind !== "session" || actual.kind === "session" && (route.sessionId === undefined || actual.sessionId === route.sessionId));
        if (matched) return true;
        if ((state.navigationRevision ?? 0) !== before) return false;
        await new Promise<void>(resolve => setTimeout(resolve, 40));
      }
      return false;
    };
    const apply = async (): Promise<void> => {
      if (mode === "page" && existing !== undefined && !extension.mainView?.multiple && !await (closeGuards.current.get(identity)?.() ?? Promise.resolve(true))) return;
      if (mode === "page") {
        if (!await navigate({ kind: "extensionMainView", extensionId }) || !requestCurrent()) return;
        commit(value => ({ ...value, plugins: { ...value.plugins, [identity]: { extensionId, mode, edge, open: extension.mainView?.multiple === true && old?.open === true } } })); return;
      }
      if (current.current.controller.state.route.kind === "extensionMainView" && current.current.controller.state.route.extensionId === extensionId && !extension.mainView?.multiple) {
        if (!await navigate({ kind: "session", ...(lastSessionId.current === undefined ? {} : { sessionId: lastSessionId.current }) })) return;
      }
      if (existing !== undefined && (mode === "window" && !dock.windows.has(existing.key) || mode === "sidebar" && dock.windows.has(existing.key))) {
        const guard = closeGuards.current.get(identity); if (guard !== undefined && !await guard()) return;
      }
      if (!requestCurrent()) return;
      commit(value => ({ ...value, plugins: { ...value.plugins, [identity]: { extensionId, mode, edge, open: true } } }));
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
      if (event.detail.owner !== undefined && event.detail.owner !== owner) return;
      acknowledgeInspectorExtensionRequest(event.detail.id);
      handlePlugin(event.detail.extensionId, event.detail.mode);
    };
    const reset = (): void => guardedPlacement([...dock.windows.keys()], () => {
      setDefaultSide("right");
      for (const identity of Object.keys(preferencesRef.current.plugins)) attemptedWindows.current.add(identity);
      commit(value => ({ groups: {}, plugins: Object.fromEntries(Object.entries(value.plugins).map(([identity, placement]) => {
        const extension = plugin(identity);
        return [identity, { ...placement, mode: extension?.mainView?.open ?? "page", edge: extension?.mainView?.side ?? "right" }];
      })) }));
      for (const entry of [...windowsRef.current]) returnWindow(entry);
    });
    window.addEventListener("storage", changed); window.addEventListener(INSPECTOR_EXTENSION_OPEN_EVENT, openPlugin); window.addEventListener(CLIENT_LAYOUT_RESET_EVENT, reset);
    drainInspectorExtensionRequests(owner, handlePlugin);
    return () => { window.removeEventListener("storage", changed); window.removeEventListener(INSPECTOR_EXTENSION_OPEN_EVENT, openPlugin); window.removeEventListener(CLIENT_LAYOUT_RESET_EVENT, reset); };
  });
  useEffect(() => {
    const desktop = window.jokoDesktop;
    if (!canDetach || desktop === undefined) return;
    return desktop.inspectorWindow.onClosed(event => {
      const entry = windowsRef.current.find(candidate => candidate.occurrence === event.occurrence);
      if (entry !== undefined) returnWindow(entry, false);
    });
  }, [canDetach]);
  useEffect(() => () => {
    alive.current = false;
    for (const entry of windowsRef.current) { entry.dispose(); void entry.host.window.jokoInspectorDesktop?.window.close("passive").catch(() => undefined); }
    windowsRef.current = [];
  }, []);
  useLayoutEffect(() => {
    const app = document.querySelector<HTMLElement>(".app"); if (app === null) return;
    for (const edge of INSPECTOR_EDGES) {
      const value = preferences.sizes?.[edge];
      if (value === undefined) app.style.removeProperty(`--joko-dock-${edge}-size`);
      else app.style.setProperty(`--joko-dock-${edge}-size`, `${value}px`);
    }
    return () => { for (const edge of INSPECTOR_EDGES) app.style.removeProperty(`--joko-dock-${edge}-size`); };
  }, [preferences.sizes]);
  useLayoutEffect(() => {
    let moved = false;
    for (const tab of dock.tabs.values()) if (!dock.windows.has(tab.key) && !visibleTabs().includes(tab) && parking.current !== null) {
      if (tab.node.parentNode !== parking.current) { moveInspectorMount(parking.current, tab.node); moved = true; }
      if (!tab.node.hidden) { tab.node.hidden = true; moved = true; }
    }
    for (const entry of [...windowsRef.current]) {
      if (![...dock.windows].some(([key, id]) => id === entry.id && dock.tabs.has(key))) {
        const source = entry.sessionId === undefined ? undefined : snapshot.sessions.find(candidate => candidate.id === entry.sessionId);
        const sourceCurrent = entry.sessionId === undefined || source !== undefined && entry.sessionOwner === JSON.stringify([source.backendId, source.targetId, source.generation.toString()]);
        const pluginSourcesCurrent = entry.order.filter(key => key.startsWith("plugin:")).every(key => plugin(key.slice("plugin:".length)) !== undefined || preferences.plugins[key.slice("plugin:".length)]?.open === false);
        entry.closing = true; returnWindow(entry, true, entry.userClosing && sourceCurrent && pluginSourcesCurrent ? "user" : "passive"); continue;
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
    if (moved) dock.changed();
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
    const allowed = new Set(snapshot.extensions.filter(extension => extension.installed && extension.mainView !== undefined).map(inspectorExtensionIdentity));
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
    guardedPlacement([captured.key], () => { if (windowId !== undefined) createWindow([captured.key], windowId, before); else if (edge !== undefined) move(captured.key, edge, before); });
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
  for (const [id, source] of retainedSessions.current) {
    const candidate = snapshot.sessions.find(item => item.id === id);
    if (candidate === undefined || source !== JSON.stringify([candidate.backendId, candidate.targetId, candidate.generation.toString()])) retainedSessions.current.delete(id);
  }
  const nativeSessionIds = new Set([...retainedSessions.current.keys(), ...(session === undefined ? [] : [session.id])]);
  const group = (place: string, tabs: readonly InspectorDockTab[], edge?: InspectorEdge, entry?: TabWindow): JSX.Element => <DockGroup
    key={place} {...{ dock, place, tabs, edge, entry, t, activate, drop, canDetach }}
    onMove={(key, side, before) => guardedPlacement([key], () => move(key, side, before))} onWindow={(keys, target, before) => guardedPlacement(keys, () => createWindow(keys, target, before))} onClose={keys => { void closeTabs(keys); }}
    onMerge={entry === undefined ? undefined : () => guardedPlacement(entry.order, () => returnWindow(entry))}
    onAdd={action => { const nativeOwner = dock.sessionOwners.get(entry?.sessionId ?? session?.id ?? "");
      if (nativeOwner === undefined) return;
      pendingPlacements.current.set(nativeOwner, entry === undefined ? { edge } : { windowId: entry.id });
      action(); }}
    actions={[...(dock.actions.get(dock.sessionOwners.get(entry?.sessionId ?? session?.id ?? "") ?? "") ?? [])]}
    shortcutOverrides={controller.state.preferences.appShortcutOverrides}
    onResize={(side, size) => commit(value => ({ ...value, sizes: { ...value.sizes, [side]: size } }))}
    windows={windows}
    onDragStart={(event, key) => { const nonce = randomUuid(); drag.current = { key, nonce, cancelled: false }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(INSPECTOR_TAB_DRAG_TYPE, JSON.stringify({ owner, key, nonce })); }}
    onDragEnd={event => {
      const captured = drag.current; drag.current = undefined; setDragEdge(undefined);
      if (!captured || captured.cancelled || event.dataTransfer.dropEffect !== "none" || event.screenX === 0 && event.screenY === 0) return;
      const hosts = [window, ...windowsRef.current.map(item => item.host.window)];
      if (hosts.some(host => !host.closed && event.screenX >= host.screenX && event.screenX < host.screenX + host.outerWidth && event.screenY >= host.screenY && event.screenY < host.screenY + host.outerHeight)) return;
      guardedPlacement([captured.key], () => createWindow([captured.key]));
    }} />;
  return <div className="inspector-dock-layout">
    <div ref={parking} hidden />
    {[...nativeSessionIds].map(id => {
      const candidate = snapshot.sessions.find(item => item.id === id); if (candidate === undefined) return null;
      const selected = id === session?.id, target = snapshot.targets.find(item => item.id === candidate.targetId);
      const workspaceId = candidate.localWorkspace?.workspaceId ?? (candidate.worktree?.state === "active" ? candidate.worktree.workspaceId : candidate.worktree === undefined ? target?.workspaceId : undefined);
      return <PartnerConversationProvider key={`${id}:${candidate.generation}`} controller={controller} session={candidate} active={selected ? open : true} t={t}><Inspector {...props} dock={dock} session={candidate}
        open={selected ? open : true} onDetachedChange={undefined} onClose={selected ? props.onClose : () => undefined}
        timeline={selected ? props.timeline : snapshot.timelineBySession.get(id) ?? []}
        workspace={selected ? props.workspace : snapshot.workspaces.find(item => item.id === workspaceId)}
        subagentFocusRequest={selected ? props.subagentFocusRequest : undefined} turnReviewFocusRequest={selected ? props.turnReviewFocusRequest : undefined}
        browserFocusRequest={selected ? props.browserFocusRequest : undefined} gamepadRequest={selected ? props.gamepadRequest : undefined}
        workbenchFocusRequest={sourceConversation?.sessionId === candidate.id ? sourceConversation.workbenchRequest : undefined} /></PartnerConversationProvider>;
    })}
    {globalEnabled && snapshot.extensions.filter(extensionMainViewReady).map(extension => {
      const identity = inspectorExtensionIdentity(extension), placement = preferences.plugins[identity];
      if (!placement?.open) return null;
      const key = `plugin:${identity}`;
      return <InspectorTabContribution key={identity} dock={dock} owner={identity}
        tabs={[{ key, pluginIdentity: identity, label: extension.mainView?.title ?? extension.name, kind: "extension", onActivate: () => undefined,
          onClose: async () => { if (!await (closeGuards.current.get(identity)?.() ?? Promise.resolve(true)) || !alive.current) return;
            commit(value => ({ ...value, plugins: { ...value.plugins, [identity]: { ...value.plugins[identity]!, open: false } } })); } }]}
        render={(_key, _active, ownerDocument) => <section id={`inspector-panel-${key}`} role="tabpanel" aria-labelledby={`inspector-tab-${key}`} className="inspector-dock-plugin"><ExtensionMainViewPage controller={controller} extensionId={extension.id} t={t} embedded ownerDocument={ownerDocument}
          navigationOpen onOpenNavigation={() => undefined} onOpenIndependent={() => createWindow([key])}
          registerCloseGuard={guard => { closeGuards.current.set(identity, guard); return () => { if (closeGuards.current.get(identity) === guard) closeGuards.current.delete(identity); }; }} /></section>}
      />;
    })}
    {INSPECTOR_EDGES.map(edge => { const tabs = orderedTabs(visibleTabs().filter(tab => !dock.windows.has(tab.key) && edgeOf(tab) === edge)); return tabs.length || edge === defaultSide && open && session !== undefined && ![...dock.tabs.values()].some(tab => tab.sessionId === session.id) ? group(edge, tabs, edge) : null; })}
    {windows.map(entry => createPortal(<div className="inspector-window-shell inspector-dock-window">
      <header className="inspector-window-titlebar"><PanelRight aria-hidden="true" /><span>{t("inspector.windowLabel")}</span><IconButton label={t("inspector.mergeBack")} onClick={() => guardedPlacement(entry.order, () => returnWindow(entry))}><PanelRight /></IconButton></header>
      {group(entry.id, entry.order.flatMap(key => dock.windows.get(key) === entry.id && dock.tabs.has(key) ? [dock.tabs.get(key)!] : []), undefined, entry)}
      {entry.host.window.jokoInspectorDesktop?.platform !== "darwin" && <div className="inspector-window-controls"><IconButton label={t("desktop.minimize")} onClick={() => { void entry.host.window.jokoInspectorDesktop?.window.minimize(); }}><Minus /></IconButton><IconButton label={t("desktop.maximizeOrRestore")} onClick={() => { void entry.host.window.jokoInspectorDesktop?.window.toggleMaximize(); }}><Square /></IconButton><IconButton label={t("desktop.close")} onClick={() => { void closeTabs([...dock.windows].filter(([, id]) => id === entry.id).map(([key]) => key)); }}><X /></IconButton></div>}
    </div>, entry.host.root, entry.id))}
    {dragEdge !== undefined && <div className={`inspector-dock-drop-preview is-${dragEdge}`} aria-hidden="true" />}
  </div>;
}

function DockGroup({ dock, place, tabs, edge, entry, t, activate, drop, canDetach, onMove, onWindow, onClose, onMerge, onAdd, actions, windows, onDragStart, onDragEnd, shortcutOverrides, onResize }: {
  readonly dock: InspectorDock; readonly place: string; readonly tabs: readonly InspectorDockTab[]; readonly edge?: InspectorEdge; readonly entry?: TabWindow; readonly t: Translator;
  readonly activate: (tab: InspectorDockTab, place: string) => void; readonly drop: (event: DragEvent, edge?: InspectorEdge, windowId?: string, before?: string) => void;
  readonly canDetach: boolean; readonly onMove: (key: string, edge: InspectorEdge, before?: string) => void; readonly onWindow: (keys: readonly string[], target?: string, before?: string) => void;
  readonly onClose: (keys: readonly string[]) => void; readonly onMerge?: () => void; readonly onAdd: (action: () => void) => void;
  readonly actions: readonly { readonly id: string; readonly label: string; readonly disabled?: boolean; readonly run: () => void }[]; readonly windows: readonly TabWindow[];
  readonly onDragStart: (event: DragEvent, key: string) => void; readonly onDragEnd: (event: DragEvent) => void;
  readonly shortcutOverrides?: AppShortcutOverrides;
  readonly onResize: (edge: InspectorEdge, size: number) => void;
}): JSX.Element {
  const body = useRef<HTMLDivElement>(null), root = useRef<HTMLElement>(null);
  const resizeCleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => resizeCleanup.current?.(), []);
  const [menu, setMenu] = useState(false), [adding, setAdding] = useState(false), [maximized, setMaximized] = useState(false);
  const selected = dock.selected.get(place), active = tabs.find(tab => tab.key === selected) ?? tabs[0];
  useEffect(() => {
    if (!menu && !adding) return;
    const owner = entry?.host.window.document ?? document;
    const clicked = (event: MouseEvent): void => { const node = event.target as Node | null; if (node && !root.current?.querySelector(".inspector-menu:has([aria-expanded='true'])")?.contains(node)) { setMenu(false); setAdding(false); } };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { setMenu(false); setAdding(false); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
      if (!buttons.length) return;
      event.preventDefault(); const index = buttons.indexOf(owner.activeElement as HTMLButtonElement);
      buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    };
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    owner.addEventListener("mousedown", clicked, true); owner.addEventListener("keydown", key, true);
    return () => { owner.removeEventListener("mousedown", clicked, true); owner.removeEventListener("keydown", key, true); };
  }, [menu, adding, entry]);
  const resize = (size: number): void => {
    if (edge === undefined) return;
    const limit = (edge === "left" || edge === "right" ? window.innerWidth : window.innerHeight) * 0.48;
    onResize(edge, Math.max(100, Math.min(2_048, limit, size)));
  };
  useLayoutEffect(() => {
    if (body.current === null) return;
    let changed = false;
    for (const tab of tabs) {
      if (tab.node.parentNode !== body.current) { moveInspectorMount(body.current, tab.node); changed = true; }
      const hidden = tab !== active;
      if (tab.node.hidden !== hidden) { tab.node.hidden = hidden; changed = true; }
    }
    if (changed) dock.changed();
  });
  const cycle = (direction: number): boolean => {
    if (dock.focusedGroup !== place || !tabs.length) return false;
    const index = active === undefined ? 0 : tabs.indexOf(active), next = tabs[(index + direction + tabs.length) % tabs.length]!;
    activate(next, place);
    queueMicrotask(() => { const button = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])].find(candidate => candidate.dataset["dockKey"] === next.key); button?.focus(); });
    return true;
  };
  const target = entry?.host.window ?? window;
  useAppShortcut("right-tab-prev", shortcutOverrides, () => cycle(-1), { target, stopImmediate: true });
  useAppShortcut("right-tab-next", shortcutOverrides, () => cycle(1), { target, stopImmediate: true });
  useAppShortcut("close-tab-or-window", shortcutOverrides, () => { if (dock.focusedGroup !== place || active === undefined || target.document.activeElement !== target.document.body && !root.current?.contains(target.document.activeElement)) return false; onClose([active.key]); return true; }, { target });
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
          <button type="button" role="tab" id={`inspector-tab-${tab.key}`} data-dock-key={tab.key} aria-controls={`inspector-panel-${tab.key}`} aria-selected={tab === active} tabIndex={tab === active ? 0 : -1}
            onClick={() => activate(tab, place)} onKeyDown={event => {
              if (event.key === "Delete") { event.preventDefault(); onClose([tab.key]); return; }
              if (event.key === "Home" || event.key === "End") { event.preventDefault(); const next = event.key === "Home" ? tabs[0] : tabs.at(-1); if (next) activate(next, place); return; }
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              if (!event.shiftKey) { cycle(event.key === "ArrowLeft" ? -1 : 1); return; }
              const index = tabs.indexOf(tab), direction = event.key === "ArrowLeft" ? -1 : 1;
              if (index + direction < 0 || index + direction >= tabs.length) return;
              const before = tabs[index + (direction < 0 ? -1 : 2)]?.key;
              if (entry !== undefined) onWindow([tab.key], entry.id, before); else if (edge !== undefined) onMove(tab.key, edge, before);
            }}><span>{tab.label}</span></button>
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
    {edge !== undefined && !maximized && <div className="inspector-dock-resize" role="separator" tabIndex={0} aria-label={t("a11y.resizeInspector")}
      aria-orientation={edge === "left" || edge === "right" ? "vertical" : "horizontal"}
      onPointerDown={event => {
        if (event.button !== 0 || root.current === null) return; event.preventDefault();
        const horizontal = edge === "left" || edge === "right", sign = edge === "left" || edge === "top" ? 1 : -1;
        const origin = horizontal ? event.clientX : event.clientY, bounds = root.current.getBoundingClientRect(), initial = horizontal ? bounds.width : bounds.height;
        const owner = root.current.ownerDocument, app = document.querySelector<HTMLElement>(".app"); let last = initial;
        const move = (pointer: PointerEvent): void => { last = Math.max(100, Math.min(2_048, (horizontal ? window.innerWidth : window.innerHeight) * 0.48,
          initial + sign * ((horizontal ? pointer.clientX : pointer.clientY) - origin))); app?.style.setProperty(`--joko-dock-${edge}-size`, `${last}px`); };
        const cleanup = (): void => { owner.removeEventListener("pointermove", move); owner.removeEventListener("pointerup", done); owner.removeEventListener("pointercancel", done); };
        const done = (): void => { cleanup(); resizeCleanup.current = undefined; if (root.current?.isConnected) resize(last); };
        resizeCleanup.current?.(); resizeCleanup.current = cleanup;
        owner.addEventListener("pointermove", move); owner.addEventListener("pointerup", done, { once: true }); owner.addEventListener("pointercancel", done, { once: true });
      }}
      onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); const bounds = root.current?.getBoundingClientRect(); if (bounds) resize((edge === "left" || edge === "right" ? bounds.width : bounds.height) + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -16 : 16)); } }} />}
  </aside>;
}
