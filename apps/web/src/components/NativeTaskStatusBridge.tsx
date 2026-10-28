import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { NativeRemoteTaskTracker, remoteEntryToken } from "@joko/contracts";
import type { AppController } from "../controller.js";
import { resolveNativeTaskStatusPermissionAction } from "../native-task-status-bridge.js";
import { composeNativeTaskStatusProjection, nativeTaskStatusRouteKey, nativeTaskStatusProfileKey, type NativeTaskStatusRoute } from "../native-task-status-projection.js";
import { selectedMachineProfileIds } from "../machine-federation.js";
import { executeNativeTaskStatusCompletion } from "../native-task-status-completion.js";
import type { WorktreeRemovalPreflightSummary } from "../worktree-removal-preflight.js";
import type { SessionView } from "../model.js";
import { ArchiveSessionDialog } from "./SessionDialogs.js";
import { translate } from "../i18n.js";

export function NativeTaskStatusBridge({ controller, ownsProjection, visibleSessionIds }: {
  readonly controller: AppController; readonly ownsProjection: boolean; readonly visibleSessionIds: readonly string[];
}): JSX.Element | null {
  const controllerRef = useRef(controller); controllerRef.current = controller;
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  const supported = desktop?.capabilities.includes("native.taskStatus") === true;
  const owner = useRef(`renderer:${crypto.randomUUID()}`);
  const revision = useRef(0n);
  const state = controller.state;
  const projection = useMemo(() => composeNativeTaskStatusProjection({
    ownerId: owner.current, revision: ++revision.current, locale: state.effectiveLocale,
    ...(state.connectionState === "connected" && state.activeProfile ? { primary: { profile: state.activeProfile, snapshot: state.snapshot, connectionGeneration: state.connectionGeneration } } : {}),
    remotes: (state.nativeTaskStatusLiveSources ?? []).filter(source => state.profiles.some(profile => profile.id === source.profile.id
      && profile.serverId === source.profile.serverId && profile.origin === source.profile.origin && profile.deviceId === source.profile.deviceId)),
    selectedProfileIds: new Set(selectedMachineProfileIds(state.preferences.machineSelection, state.profiles))
  }), [state.connectionState, state.connectionGeneration, state.activeProfile, state.effectiveLocale, state.snapshot, state.nativeTaskStatusLiveSources, state.preferences.machineSelection, state.profiles]);
  const projectionRef = useRef(projection); projectionRef.current = projection;
  const notificationTracker = useRef(new NativeRemoteTaskTracker());
  const pendingNotifications = useRef(new Map<string, string>());
  const [nativeEnabled, setNativeEnabled] = useState<boolean>();
  const pendingFocus = useRef<{ readonly sessionId: string; readonly token: string; readonly route: NativeTaskStatusRoute; readonly initialRoute: string } | undefined>(undefined);
  const [focusReceiptRevision, setFocusReceiptRevision] = useState(0);
  const [archivePrompt, setArchivePrompt] = useState<{ readonly session: SessionView;
    readonly summary: WorktreeRemovalPreflightSummary; readonly isCurrent: () => boolean;
    readonly resolve: (accepted: boolean) => void }>();
  const archivePromptRef = useRef(archivePrompt); archivePromptRef.current = archivePrompt;
  useEffect(() => {
    const prompt = archivePromptRef.current;
    if (prompt && !prompt.isCurrent()) { prompt.resolve(false); setArchivePrompt(undefined); }
  }, [projection]);
  useEffect(() => () => { archivePromptRef.current?.resolve(false); }, []);
  useEffect(() => {
    if (ownsProjection && supported) return;
    archivePromptRef.current?.resolve(false); archivePromptRef.current = undefined; setArchivePrompt(undefined);
  }, [ownsProjection, supported]);
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || !desktop) return;
    const route = state.route;
    if (route.kind === "session" && route.sessionId === pending.route.sessionId
      && (route.profileId ?? state.activeProfile?.id) === pending.route.profileId
      && (!pending.route.partnerId || route.partnerId === pending.route.partnerId)) {
      pendingFocus.current = undefined;
      void desktop.nativeTaskStatus.acknowledgeFocus?.(pending.sessionId, pending.token).catch(() => undefined);
    } else if (JSON.stringify(route) !== pending.initialRoute) pendingFocus.current = undefined;
  }, [state.route, state.activeProfile, focusReceiptRevision, desktop]);
  useEffect(() => {
    if (!supported || !desktop || !ownsProjection) return;
    let current = true;
    void desktop.nativeTaskStatus.getSettings().then(settings => { if (current) setNativeEnabled(settings.enabled); }).catch(() => undefined);
    const unsubscribe = desktop.nativeTaskStatus.onSettingsChanged(settings => setNativeEnabled(settings.enabled));
    return () => { current = false; unsubscribe(); };
  }, [desktop, supported, ownsProjection]);

  useEffect(() => {
    if (!supported || !desktop) return;
    const profile = state.activeProfile;
    const keys = profile ? visibleSessionIds.flatMap(sessionId => {
      const session = state.snapshot.sessions.find(value => value.id === sessionId);
      return session ? [nativeTaskStatusRouteKey({ profileId: profile.id, serverId: profile.serverId, sessionId,
        profileKey: nativeTaskStatusProfileKey(profile), connectionGeneration: state.connectionGeneration,
        generation: session.generation, sourceGeneration: state.snapshot.generation })] : [];
    }) : [];
    void desktop.nativeTaskStatus.setVisibleSessions(keys).catch(() => undefined);
  }, [desktop, supported, visibleSessionIds, state.activeProfile, state.snapshot.sessions, state.snapshot.generation, state.connectionGeneration]);
  useEffect(() => () => { if (supported && desktop) void desktop.nativeTaskStatus.setVisibleSessions([]).catch(() => undefined); }, [desktop, supported]);

  useEffect(() => {
    if (!ownsProjection || !supported || !desktop) return;
    void desktop.nativeTaskStatus.publish(projection.snapshot).catch(() => undefined);
    const observed = notificationTracker.current.observe(projection.snapshot.sessions);
    for (const event of observed.events) {
      const entry = projection.snapshot.sessions.find(session => session.sessionId === event.sessionId);
      if (entry) pendingNotifications.current.set(event.sessionId, remoteEntryToken(entry));
    }
    if (nativeEnabled === true || !state.preferences.sessionNotificationsEnabled || document.hasFocus()
      || !desktop.capabilities.includes("notifications.session")) { pendingNotifications.current.clear(); return; }
    if (nativeEnabled === undefined) return;
    const pending = [...pendingNotifications.current]; pendingNotifications.current.clear();
    for (const [sessionId, token] of pending) {
      const entry = projection.snapshot.sessions.find(session => session.sessionId === sessionId);
      const route = projection.routes.get(sessionId);
      if (entry && remoteEntryToken(entry) !== token) continue;
      if (!entry || !route) continue;
      const source = state.nativeTaskStatusLiveSources?.find(value => value.profile.id === route.profileId && value.epoch === route.epoch);
      if (!source) continue;
      const body = entry.phase === "completed" ? entry.detail || (state.effectiveLocale === "zh-CN" ? "任务已完成。" : "Task completed.")
        : entry.phase === "interaction" ? (state.effectiveLocale === "zh-CN" ? "任务需要你的回复。" : "Task needs your reply.")
          : (state.effectiveLocale === "zh-CN" ? "任务遇到问题。" : "Task needs attention.");
      void desktop.notify({ title: `${entry.title} · ${source.profile.name}`, body,
        navigation: { kind: "nativeTask", sessionId: entry.sessionId, entryToken: remoteEntryToken(entry) } }).catch(() => undefined);
    }
  }, [desktop, supported, ownsProjection, projection, nativeEnabled, state.preferences.sessionNotificationsEnabled]);

  useEffect(() => {
    if (!ownsProjection || !supported || !desktop) return;
    const settling = new Set<string>();
    const currentRoute = (route: NativeTaskStatusRoute): boolean => {
      const current = controllerRef.current.state;
      const profile = current.profiles.find(value => value.id === route.profileId && value.serverId === route.serverId);
      if (!profile) return false;
      if (route.profileKey !== nativeTaskStatusProfileKey(profile)
        || route.epoch === undefined && route.connectionGeneration !== current.connectionGeneration) return false;
      const source = route.epoch === undefined
        ? current.activeProfile?.id === route.profileId && current.connectionState === "connected" ? current.snapshot : undefined
        : current.nativeTaskStatusLiveSources?.find(value => value.profile.id === route.profileId && value.profile.serverId === route.serverId && value.epoch === route.epoch)?.snapshot;
      return source?.generation === route.sourceGeneration && source.sessions.some(session => session.id === route.sessionId && session.generation === route.generation && !session.hidden && !session.archived);
    };
    return desktop.nativeTaskStatus.onAction(action => {
      const published = projectionRef.current;
      const route = published.routes.get(action.sessionId);
      if (action.kind === "completion") {
        const settle = (accepted: boolean) => desktop.nativeTaskStatus.finishCompletion?.(action.sessionId, action.entryToken, accepted).catch(() => undefined);
        const entry = published.snapshot.sessions.find(value => value.sessionId === action.sessionId);
        if (!route || !currentRoute(route) || !entry || !["completed", "error"].includes(entry.phase)
          || remoteEntryToken(entry) !== action.entryToken || settling.has(action.sessionId)) { void settle(false); return; }
        const source = controllerRef.current.nativeTaskStatusCompletionSource?.(route);
        if (!source) { void settle(false); return; }
        settling.add(action.sessionId);
        void executeNativeTaskStatusCompletion(source, action.action, (session, summary) => new Promise<boolean>(resolve => {
          archivePromptRef.current?.resolve(false);
          const isCurrent = () => {
            const current = projectionRef.current.snapshot.sessions.find(value => value.sessionId === action.sessionId);
            return source.isCurrent() && current !== undefined && remoteEntryToken(current) === action.entryToken;
          };
          const prompt = { session, summary, isCurrent, resolve };
          archivePromptRef.current = prompt; setArchivePrompt(prompt);
        })).then(settle, () => settle(false)).finally(() => settling.delete(action.sessionId));
        return;
      }
      if (!route || !currentRoute(route)) return;
      if (action.kind === "focus") {
        if (route.epoch !== undefined && !action.entryToken) return;
        const entry = published.snapshot.sessions.find(session => session.sessionId === action.sessionId);
        if (action.entryToken && (!entry || action.entryToken !== remoteEntryToken(entry))) return;
        const pending = action.entryToken ? { sessionId: action.sessionId, token: action.entryToken, route, initialRoute: JSON.stringify(controllerRef.current.state.route) } : undefined;
        pendingFocus.current = pending;
        void (async () => {
          if (route.epoch === undefined) controllerRef.current.navigate({ kind: "session", sessionId: route.sessionId });
          else await controllerRef.current.openMachineSession(route.profileId, route.sessionId, { ...(route.partnerId ? { partnerId: route.partnerId } : {}) });
          if (pendingFocus.current === pending) setFocusReceiptRevision(value => value + 1);
        })().catch(() => { if (pendingFocus.current === pending) pendingFocus.current = undefined; });
        return;
      }
      if (route.epoch !== undefined) return;
      const key = `${action.sessionId}\u0000${action.interactionId}\u0000${action.generation}`;
      if (settling.has(key)) return; settling.add(key);
      void resolveNativeTaskStatusPermissionAction(controllerRef.current, { ...action, sessionId: route.sessionId })
        .catch(() => false).finally(() => settling.delete(key));
    });
  }, [desktop, ownsProjection, supported]);

  useEffect(() => () => {
    if (!ownsProjection || !supported || !desktop) return;
    void desktop.nativeTaskStatus.publish({ ownerId: "renderer-unmounted", revision: "0", locale: controllerRef.current.state.effectiveLocale, sessions: [] }).catch(() => undefined);
  }, [desktop, ownsProjection, supported]);
  return archivePrompt === undefined ? null : <ArchiveSessionDialog sessions={[archivePrompt.session]} preflight={archivePrompt.summary}
    t={(key, values) => translate(state.effectiveLocale, key, values)}
    onClose={() => { archivePrompt.resolve(false); archivePromptRef.current = undefined; setArchivePrompt(undefined); }}
    onArchive={() => { archivePrompt.resolve(archivePrompt.isCurrent()); archivePromptRef.current = undefined; setArchivePrompt(undefined); }} />;
}
