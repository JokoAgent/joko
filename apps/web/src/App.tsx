import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { AlertTriangle, Bell, CircleAlert, CirclePlus, Info, Menu, RefreshCcw, ServerCrash, Sparkles, X } from "lucide-react";
import { appRouteHash, useAppController } from "./controller.js";
import type { AppController } from "./controller.js";
import { translate } from "./i18n.js";
import type { ComposerDraft, ComposerFileSelectionQuoteDraft, InteractionView, SessionMessageSearchMatchView, SessionView, TargetView, TimelineHistoryCursorView, TimelineItemView } from "./model.js";
import { fileAttachmentInsertionFor, type FileAttachmentInsertion } from "./file-attachment-insertion.js";
import { fileSelectionQuoteInsertionFor, type FileSelectionQuoteInsertion } from "./file-selection-quote-insertion.js";
import { ConnectionScreen } from "./components/ConnectionScreen.js";
import { AppErrorBoundary, routeErrorBoundaryKey } from "./components/ErrorBoundary.js";
import { resolveComposerAttachmentPolicy } from "./components/composer-behavior.js";
import { reviewRunForReviewerSession } from "./components/reviewer-session.js";
import { mergeTimelineWindows } from "./components/timeline-behavior.js";
import {
  clampNavigationDragWidth,
  finalizeNavigationDrag,
  NAVIGATION_DEFAULT_WIDTH,
  navigationLayoutForResizeKey,
  navigationModeForDragWidth,
  navigationVisualWidth,
  type NavigationMode
} from "./navigation-layout.js";
import { BulkDeleteSessionDialog, DeleteSessionDialog, RenameSessionDialog } from "./components/SessionDialogs.js";
import { NewSessionPage } from "./components/NewSessionPage.js";
import { DesktopWindowControls } from "./components/DesktopWindowControls.js";
import { DesktopPageSearchBar } from "./components/DesktopPageSearchBar.js";
import { StartupUpdateOverlay } from "./components/StartupUpdateOverlay.js";
import { NativeTaskStatusBridge } from "./components/NativeTaskStatusBridge.js";
import { DesktopGlobalVoiceBridge } from "./components/DesktopGlobalVoiceBridge.js";
import { RuntimeProcessMonitorWindow } from "./components/RuntimeProcessMonitorWindow.js";
import { VisionBridgeToasts } from "./components/VisionBridgeToasts.js";
import { Sidebar } from "./components/Sidebar.js";
import { PortableSessionDialogHost, type PortableSessionImportRequest } from "./components/PortableSessionDialogHost.js";
import { PortableSessionDropTarget } from "./components/PortableSessionDropTarget.js";
import { SessionSplitView } from "./components/SessionSplitView.js";
import { WorkspaceFilesRoute } from "./components/WorkspaceFilesRoute.js";
import { createInspectorTurnReviewRequest, type InspectorTurnReviewRequest } from "./components/inspector-review-focus.js";
import { requestWorkspaceDocumentLeave } from "./workspace-document-lifecycle.js";
import { createDelayedSessionFromFirstInput, type DelayedNewSessionDraft } from "./new-session-flow.js";
import { currentAppShortcutPlatform, type AppShortcutId, type AppShortcutOverrides } from "./app-shortcuts.js";
import {
  createDesktopApplicationMenuCommandQueue,
  desktopApplicationMenuAccelerators,
  desktopUpdateCheckNotice,
  type DesktopUpdateCheckNotice,
  type DesktopApplicationMenuPreferenceView
} from "./desktop-application-menu.js";
import { useAppShortcut } from "./use-app-shortcut.js";
import { isStartupUpdateInteractionBlocked } from "./startup-update-interaction.js";
import { promptRecommendationOwnerKey, promptRecommendationStore } from "./prompt-recommendation-store.js";
import { visionBridgeToastStore } from "./vision-bridge-toast-store.js";
import { deleteScheduleWithGeneratedSessions, prepareScheduleDeletion } from "./schedule-deletion.js";
import { SessionNotificationTracker, shouldDispatchSessionNotifications } from "./session-notifications.js";
import { ScheduleNotificationTracker } from "./schedule-notifications.js";
import {
  reconcileSessionAttentionBadgeProjection,
  type SessionAttentionBadgeKey
} from "./session-attention-badge.js";
import {
  SessionAttentionAcknowledgementRetryTracker,
  sidebarOwnerLayoutFor,
  viewerAttentionCursorWhenHistoryReady
} from "./sidebar-layout.js";
import type { RunAction } from "./components/types.js";
import {
  browserFileFromDesktopFile,
  portableSessionTargetOptions,
  portableSessionWorktreeProbeTargetIds
} from "./portable-session-ui.js";
import { Button, EmptyState, ErrorBanner, IconButton, Spinner, cx } from "./components/ui.js";
import {
  MAXIMUM_SESSION_SPLIT_PANES,
  addSessionSplit,
  readSessionSplitLayout,
  reconcileSessionSplit,
  removeSessionSplit,
  replaceSessionSplit,
  sessionSplitPanes,
  writeSessionSplitLayout,
  type SessionSplitLayout,
  type SessionSplitSide
} from "./session-split-layout.js";
import { desktopSessionTaskLink, isSessionApplicationWindow, openSessionWindowFallback, sessionTaskLink } from "./session-window-navigation.js";
import { desktopDeepLinkRouteHash } from "./desktop-deep-link-navigation.js";
import { CLIENT_LAYOUT_RESET_EVENT } from "./client-layout-reset.js";
import {
  applySessionProjectOverrides,
  reconcileSessionProjectOverrides,
  rollbackSessionProjectOverride,
  sameSessionProjectPlacement,
  sessionProjectMoveBlock,
  type SessionProjectNavigationPlacement
} from "./session-project-navigation.js";
import { isRuntimeProcessMonitorWindow } from "./runtime-process-monitor-window.js";
import { createProviderModelRefreshLifecycle } from "./provider-model-refresh-lifecycle.js";

const SessionPane = lazy(async () => ({ default: (await import("./components/SessionPane.js")).SessionPane }));
const Inspector = lazy(async () => ({ default: (await import("./components/Inspector.js")).Inspector }));
const SchedulesPage = lazy(async () => ({ default: (await import("./components/SchedulesPage.js")).SchedulesPage }));
const ProjectsPage = lazy(async () => ({ default: (await import("./components/ProjectsPage.js")).ProjectsPage }));
const SettingsPage = lazy(async () => ({ default: (await import("./components/SettingsPage.js")).SettingsPage }));
const StandaloneAboutPage = lazy(async () => ({ default: (await import("./components/SettingsPage.js")).StandaloneAboutPage }));
const ToolsPage = lazy(async () => ({ default: (await import("./components/ToolsPage.js")).ToolsPage }));
const EMPTY_TIMELINE: readonly TimelineItemView[] = [];

interface ActiveTimelineHistory {
  readonly sessionId: string;
  readonly generation: bigint;
  readonly items: readonly TimelineItemView[];
  readonly nextBeforeCursor?: TimelineHistoryCursorView;
  readonly initialized: boolean;
  readonly loading: boolean;
  readonly error?: string;
}

interface NavigationDragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  readonly visualWidth: number;
  readonly mode: Exclude<NavigationMode, "hidden">;
}

interface DesktopApplicationMenuActionTarget {
  readonly preferences: DesktopApplicationMenuPreferenceView;
  readonly openAbout: () => Promise<void>;
  readonly openNewSession: () => Promise<void>;
  readonly openSettings: () => Promise<void>;
  readonly openTaskStatusSettings: () => Promise<void>;
  readonly checkForUpdates: () => Promise<void>;
  readonly setNavigationOpen: (open: boolean) => Promise<void>;
  readonly setWindowZoom: (zoom: number) => Promise<void>;
  readonly onError: (error: unknown) => void;
}

export function App(): JSX.Element {
  return (
    <AppErrorBoundary
      scope="app"
      resetAfterNavigation
      onBackToTasks={() => { window.location.hash = "#/tasks/"; }}
      onOpenSettings={() => { window.location.hash = "#/settings"; }}
    >
      <AppControllerRoot />
    </AppErrorBoundary>
  );
}

function AppControllerRoot(): JSX.Element {
  const controller = useAppController();
  const t = useCallback((key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate(controller.state.preferences.locale, key, values), [controller.state.preferences.locale]);
  const runtimeProcessMonitor = typeof window !== "undefined" && isRuntimeProcessMonitorWindow(window.location);
  if (runtimeProcessMonitor) return <><RuntimeProcessMonitorWindow controller={controller} t={t} /><DesktopWindowControls t={t} /></>;
  const applicationWindowOwner = typeof window !== "undefined" && !isSessionApplicationWindow(window.location);
  return <><StartupUpdateOverlay t={t} />{applicationWindowOwner && <DesktopGlobalVoiceBridge controller={controller} />}<AppWithController controller={controller} /><DesktopWindowControls t={t} /></>;
}

/** Injectable application shell used by deterministic development harnesses. */
export function AppWithController({ controller, initialInspectorSubagentFocusRequest }: {
  readonly controller: AppController;
  /** Development/test bootstrap only; ordinary product navigation sets this from a timeline action. */
  readonly initialInspectorSubagentFocusRequest?: { readonly sessionId: string; readonly runId: string; readonly requestId: number };
}): JSX.Element {
  const { state } = controller;
  const sessionApplicationWindow = typeof window !== "undefined" && isSessionApplicationWindow(window.location);
  const t = useCallback((key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate(state.preferences.locale, key, values), [state.preferences.locale]);
  const [renameSession, setRenameSession] = useState<SessionView>();
  const [deleteSession, setDeleteSession] = useState<SessionView>();
  const [bulkDeleteSessions, setBulkDeleteSessions] = useState<readonly SessionView[]>([]);
  const [actionError, setActionError] = useState<string>();
  const [applicationMenuNotice, setApplicationMenuNotice] = useState<(DesktopUpdateCheckNotice & { readonly id: number })>();
  const [busyAction, setBusyAction] = useState<string>();
  const [layoutNotice, setLayoutNotice] = useState<string>();
  const [sessionProjectOverrides, setSessionProjectOverrides] = useState<ReadonlyMap<string, SessionProjectNavigationPlacement>>(() => new Map());
  const [movingSessionProjectIds, setMovingSessionProjectIds] = useState<ReadonlySet<string>>(() => new Set());
  const movingSessionProjectIdsRef = useRef<ReadonlySet<string>>(movingSessionProjectIds);
  movingSessionProjectIdsRef.current = movingSessionProjectIds;
  const [sessionSplitLayout, setSessionSplitLayout] = useState<SessionSplitLayout>({});
  const [focusedSplitSessionId, setFocusedSplitSessionId] = useState<string>();
  const [bootConnectionProfileId, setBootConnectionProfileId] = useState<string>();
  const [portableExportSession, setPortableExportSession] = useState<SessionView>();
  const [portableImportRequest, setPortableImportRequest] = useState<PortableSessionImportRequest>();
  const [portableWorktreeTargetIds, setPortableWorktreeTargetIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sessionWindowNavigation, setSessionWindowNavigation] = useState(() => ({
    mode: "hidden" as NavigationMode,
    width: NAVIGATION_DEFAULT_WIDTH
  }));
  const setWindowNavigationLayout = useCallback((layout: { readonly mode: NavigationMode; readonly width: number }): void => {
    if (sessionApplicationWindow) {
      setSessionWindowNavigation(layout);
      return;
    }
    void controller.setNavigationLayout(layout);
  }, [controller, sessionApplicationWindow]);
  const setWindowNavigationOpen = useCallback((open: boolean): void => {
    if (sessionApplicationWindow) {
      setSessionWindowNavigation((current) => ({ ...current, mode: open ? "expanded" : "hidden" }));
      return;
    }
    void controller.setNavigationOpen(open);
  }, [controller, sessionApplicationWindow]);
  const effectiveNavigationOpen = sessionApplicationWindow
    ? sessionWindowNavigation.mode !== "hidden"
    : state.preferences.navigationOpen;
  const [searchTimelineWindow, setSearchTimelineWindow] = useState<{ readonly sessionId: string; readonly items: readonly TimelineItemView[] }>();
  const [timelineHistory, setTimelineHistory] = useState<ActiveTimelineHistory>();
  const promptRecommendationOwnerRef = useRef<{ readonly initialized: boolean; readonly key?: string }>({ initialized: false });
  const promptRecommendationOwner = promptRecommendationOwnerKey(state.activeProfile);
  useEffect(() => {
    if (!promptRecommendationOwnerRef.current.initialized) {
      promptRecommendationOwnerRef.current = {
        initialized: true,
        ...(promptRecommendationOwner === undefined ? {} : { key: promptRecommendationOwner })
      };
    } else if (promptRecommendationOwnerRef.current.key !== promptRecommendationOwner) {
      promptRecommendationStore.reset();
      visionBridgeToastStore.reset();
      promptRecommendationOwnerRef.current = {
        initialized: true,
        ...(promptRecommendationOwner === undefined ? {} : { key: promptRecommendationOwner })
      };
      // connect() intentionally retains the previous owner's Snapshot while
      // the new transport is connecting. Never seed the new owner store from
      // that stale running edge; the next authoritative Snapshot observes it.
      return;
    }
    promptRecommendationStore.observe(
      state.snapshot.sessions,
      state.snapshot.settings.promptRecommendation,
      state.snapshot.backgroundTasks
    );
  }, [promptRecommendationOwner, state.snapshot.backgroundTasks, state.snapshot.sessions, state.snapshot.settings.promptRecommendation.available, state.snapshot.settings.promptRecommendation.enabled]);
  // AppController is a state-bearing facade and may receive a fresh identity
  // for one snapshot push. Reset only when this application owner unmounts.
  useEffect(() => () => {
    promptRecommendationStore.reset();
    visionBridgeToastStore.reset();
  }, []);
  const [timelineFocusRequest, setTimelineFocusRequest] = useState<{ readonly sessionId: string; readonly itemId: string; readonly requestId: number }>();
  const [inspectorSubagentFocusRequest, setInspectorSubagentFocusRequest] = useState(initialInspectorSubagentFocusRequest);
  const [inspectorTurnReviewFocusRequest, setInspectorTurnReviewFocusRequest] = useState<InspectorTurnReviewRequest>();
  const [navigationDrag, setNavigationDrag] = useState<NavigationDragState>();
  const navigationDragRef = useRef<NavigationDragState | undefined>(undefined);
  const [inspectorDetached, setInspectorDetached] = useState(false);
  const [fileSelectionQuoteInsertion, setFileSelectionQuoteInsertion] = useState<FileSelectionQuoteInsertion>();
  const [fileAttachmentInsertion, setFileAttachmentInsertion] = useState<FileAttachmentInsertion>();
  const timelineFocusRequestIdRef = useRef(0);
  const inspectorSubagentFocusRequestIdRef = useRef(0);
  const inspectorTurnReviewFocusRequestIdRef = useRef(0);
  const fileSelectionQuoteInsertionIdRef = useRef(0);
  const fileAttachmentInsertionIdRef = useRef(0);
  const applicationMenuNoticeIdRef = useRef(0);
  const timelineHistoryRequestIdRef = useRef(0);
  const messageJumpGenerationRef = useRef(0);
  const handledMessageDeepLinkRef = useRef<string | undefined>(undefined);
  const loadingMessageDeepLinkRef = useRef<string | undefined>(undefined);
  const currentMessageDeepLinkRef = useRef<string | undefined>(undefined);
  const portableImportRequestIdRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const providerModelRefreshLifecycleRef = useRef<ReturnType<typeof createProviderModelRefreshLifecycle> | undefined>(undefined);
  providerModelRefreshLifecycleRef.current ??= createProviderModelRefreshLifecycle({
    refresh: async () => {
      const backendIds = new Set(controllerRef.current.state.snapshot.providers
        .filter((provider) => provider.ownerManaged)
        .map((provider) => provider.backendId));
      await Promise.all([...backendIds].map((backendId) =>
        controllerRef.current.refreshProviderModels(backendId, undefined, true)));
    }
  });
  const providerModelRefreshOwnerKey = state.activeProfile?.id;
  const providerModelRefreshLifecycleAvailable = !sessionApplicationWindow &&
    window.jokoDesktop?.capabilities.includes("provider.modelCatalogLifecycle") === true;
  useEffect(() => {
    providerModelRefreshLifecycleRef.current?.syncConnection({
      connected: providerModelRefreshLifecycleAvailable && state.connectionState === "connected",
      ...(providerModelRefreshOwnerKey === undefined ? {} : { ownerKey: providerModelRefreshOwnerKey })
    });
  }, [providerModelRefreshLifecycleAvailable, providerModelRefreshOwnerKey, state.connectionState]);
  useEffect(() => {
    if (!providerModelRefreshLifecycleAvailable) return;
    return window.jokoDesktop?.modelCatalog.onRefreshLifecycle((hint) => {
      providerModelRefreshLifecycleRef.current?.request(hint);
    });
  }, [providerModelRefreshLifecycleAvailable]);
  const portableImportTargets = useMemo(() => portableSessionTargetOptions(state.snapshot), [state.snapshot]);
  const portableWorktreeProbeTargetKey = portableSessionWorktreeProbeTargetIds(state.snapshot).join("\u0000");
  useEffect(() => {
    if (portableImportRequest === undefined) {
      setPortableWorktreeTargetIds((current) => current.size === 0 ? current : new Set());
      return;
    }
    const targetIds = portableWorktreeProbeTargetKey === "" ? [] : portableWorktreeProbeTargetKey.split("\u0000");
    const abort = new AbortController();
    setPortableWorktreeTargetIds(new Set());
    void Promise.all(targetIds.map(async (targetId) => {
      try {
        const probe = await controllerRef.current.probeTargetWorktree(targetId, abort.signal);
        return probe.eligibility === "eligible" ? targetId : undefined;
      } catch {
        return undefined;
      }
    })).then((results) => {
      if (!abort.signal.aborted) setPortableWorktreeTargetIds(new Set(results.filter((value): value is string => value !== undefined)));
    });
    return () => abort.abort();
  }, [portableImportRequest?.id, portableWorktreeProbeTargetKey]);
  const bootConnectionAttemptedRef = useRef(false);
  const layoutRouteSessionIdRef = useRef(state.route.kind === "session" ? state.route.sessionId : undefined);
  layoutRouteSessionIdRef.current = state.route.kind === "session" ? state.route.sessionId : undefined;
  useEffect(() => {
    const resetView = (): void => {
      setSessionSplitLayout({});
      setFocusedSplitSessionId(layoutRouteSessionIdRef.current);
      if (sessionApplicationWindow) setSessionWindowNavigation({ mode: "hidden", width: NAVIGATION_DEFAULT_WIDTH });
    };
    window.addEventListener(CLIENT_LAYOUT_RESET_EVENT, resetView);
    const unsubscribe = window.jokoDesktop?.layout?.onReset(() => {
      controllerRef.current.synchronizeLayoutReset();
    });
    return () => {
      window.removeEventListener(CLIENT_LAYOUT_RESET_EVENT, resetView);
      unsubscribe?.();
    };
  }, [sessionApplicationWindow]);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("joko:application-window-bootstrap");
    const requestId = sessionApplicationWindow
      ? `${Date.now().toString(36)}-${window.crypto.getRandomValues(new Uint32Array(2)).join("-")}`
      : undefined;
    channel.onmessage = (event: MessageEvent<unknown>): void => {
      if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return;
      const message = event.data as Record<string, unknown>;
      if (message["kind"] === "request-profile" && typeof message["requestId"] === "string") {
        const profileId = controllerRef.current.state.activeProfile?.id;
        if (profileId !== undefined) channel.postMessage({ kind: "profile", requestId: message["requestId"], profileId });
        return;
      }
      if (requestId !== undefined && message["kind"] === "profile" && message["requestId"] === requestId &&
        typeof message["profileId"] === "string" && message["profileId"].length <= 256) {
        setBootConnectionProfileId(message["profileId"]);
      }
    };
    if (requestId === undefined) return () => channel.close();
    const request = (): void => channel.postMessage({ kind: "request-profile", requestId });
    request();
    const timer = window.setInterval(request, 500);
    const stop = window.setTimeout(() => window.clearInterval(timer), 10_000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
      channel.close();
    };
  }, [sessionApplicationWindow]);
  useEffect(() => {
    if (!sessionApplicationWindow || !state.ready || state.activeProfile !== undefined ||
      state.connectionState !== "disconnected" || bootConnectionProfileId === undefined || bootConnectionAttemptedRef.current) return;
    const profile = state.profiles.find((candidate) => candidate.id === bootConnectionProfileId);
    if (profile === undefined) return;
    bootConnectionAttemptedRef.current = true;
    void controllerRef.current.connect(profile).catch(() => {
      bootConnectionAttemptedRef.current = false;
    });
  }, [bootConnectionProfileId, sessionApplicationWindow, state.activeProfile, state.connectionState, state.profiles, state.ready]);
  const sessionNotificationTrackerRef = useRef(new SessionNotificationTracker());
  const scheduleNotificationTrackerRef = useRef(new ScheduleNotificationTracker());
  const notificationOwnerId = state.activeProfile?.serverId;
  const attentionBadgeProjectionRef = useRef<ReadonlyMap<string, SessionAttentionBadgeKey>>(new Map());
  const attentionBadgeSyncRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const desktop = window.jokoDesktop;
    const enabled = !sessionApplicationWindow && state.connectionState === "connected" &&
      state.snapshot.revision !== 0n && desktop?.capabilities.includes("attention.badge") === true;
    const delta = reconcileSessionAttentionBadgeProjection(
      attentionBadgeProjectionRef.current,
      enabled ? notificationOwnerId : undefined,
      enabled ? state.snapshot.sessions : []
    );
    attentionBadgeProjectionRef.current = delta.next;
    if (desktop === undefined || delta.clears.length + delta.marks.length === 0) return;
    attentionBadgeSyncRef.current = attentionBadgeSyncRef.current.then(async () => {
      for (const key of delta.clears) {
        await desktop.attention.clear(key).catch(() => undefined);
      }
      for (const key of delta.marks) {
        await desktop.attention.mark(key).catch(() => undefined);
      }
    });
  }, [
    notificationOwnerId,
    sessionApplicationWindow,
    state.connectionState,
    state.snapshot.revision,
    state.snapshot.sessions
  ]);
  useEffect(() => () => {
    const desktop = window.jokoDesktop;
    const projected = [...attentionBadgeProjectionRef.current.values()];
    attentionBadgeProjectionRef.current = new Map();
    if (desktop === undefined || projected.length === 0) return;
    attentionBadgeSyncRef.current = attentionBadgeSyncRef.current.then(async () => {
      for (const key of projected) await desktop.attention.clear(key).catch(() => undefined);
    });
  }, []);
  useEffect(() => {
    const tracker = sessionNotificationTrackerRef.current;
    if (
      sessionApplicationWindow
      ||
      notificationOwnerId === undefined
      || state.connectionState !== "connected"
      || state.snapshot.revision === 0n
    ) {
      tracker.reset();
      scheduleNotificationTrackerRef.current.reset();
      return;
    }
    const scheduleObservation = scheduleNotificationTrackerRef.current.observe(
      notificationOwnerId,
      state.snapshot.schedules
    );
    const notifications = [
      ...scheduleObservation.notifications,
      ...tracker.observe(notificationOwnerId, state.snapshot.sessions)
        .filter((notification) => !scheduleObservation.attentionOwnedSessionIds.has(notification.sessionId))
    ];
    const desktop = window.jokoDesktop;
    if (notifications.length === 0 || !shouldDispatchSessionNotifications({
      enabled: state.preferences.sessionNotificationsEnabled,
      desktopAvailable: desktop?.capabilities.includes("notifications.session") === true,
      windowFocused: document.hasFocus()
    }) || desktop === undefined) return;
    for (const notification of notifications) {
      const title = notification.title.trim() || t("session.unnamed");
      const body = notification.kind === "done"
        ? t("desktop.sessionNotification.done")
        : notification.kind === "awaiting"
          ? t("desktop.sessionNotification.awaiting")
          : t("desktop.sessionNotification.error");
      void desktop.notify({
        title: `${t("app.name")} · ${title}`,
        body,
        ...(notification.sessionId === undefined ? {} : { sessionId: notification.sessionId })
      }).catch(() => undefined);
    }
  }, [
    notificationOwnerId,
    state.connectionState,
    state.preferences.sessionNotificationsEnabled,
    state.snapshot.revision,
    state.snapshot.schedules,
    state.snapshot.sessions,
    sessionApplicationWindow,
    t
  ]);
  useEffect(() => {
    const unsubscribe = window.jokoDesktop?.notifications?.onFocusSession((sessionId) => {
      controllerRef.current.navigate({ kind: "session", sessionId });
    });
    return unsubscribe;
  }, []);
  const applicationMenuTargetRef = useRef<DesktopApplicationMenuActionTarget | undefined>(undefined);
  const applicationMenuCommandQueue = useMemo(() => {
    const target = (): DesktopApplicationMenuActionTarget => {
      const current = applicationMenuTargetRef.current;
      if (current === undefined) throw new Error("Desktop application-menu target is not ready.");
      return current;
    };
    return createDesktopApplicationMenuCommandQueue({
      getPreferences: () => target().preferences,
      openAbout: () => target().openAbout(),
      openNewSession: () => target().openNewSession(),
      openSettings: () => target().openSettings(),
      openTaskStatusSettings: () => target().openTaskStatusSettings(),
      checkForUpdates: () => target().checkForUpdates(),
      setNavigationOpen: (open) => target().setNavigationOpen(open),
      setWindowZoom: (zoom) => target().setWindowZoom(zoom),
      onError: (error) => target().onError(error)
    });
  }, []);

  useEffect(() => {
    void window.jokoDesktop?.selectionContextMenu?.setLocale(state.preferences.locale).catch(() => undefined);
  }, [state.preferences.locale]);

  const applicationMenuNoticeId = applicationMenuNotice?.id;
  useEffect(() => {
    if (applicationMenuNoticeId === undefined) return;
    const timeout = window.setTimeout(() => {
      setApplicationMenuNotice((current) => current?.id === applicationMenuNoticeId ? undefined : current);
    }, 5_000);
    return () => window.clearTimeout(timeout);
  }, [applicationMenuNoticeId]);

  const runAction = useCallback<RunAction>((key, action) => {
    setActionError(undefined);
    setBusyAction(key);
    void action().catch((error: unknown) => setActionError(messageOf(error, t("error.unexpected")))).finally(() => setBusyAction((current) => current === key ? undefined : current));
  }, [t]);
  const runSidebarScheduleAction = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setActionError(undefined);
    try {
      await action();
    } catch (error) {
      setActionError(messageOf(error, t("error.unexpected")));
      throw error;
    }
  }, [t]);
  const openPortableSessionImportFile = useCallback((file: File): void => {
    if (portableImportTargets.length === 0) {
      setActionError(t("portable.importFailed"));
      return;
    }
    setActionError(undefined);
    setPortableImportRequest({ id: ++portableImportRequestIdRef.current, file });
  }, [portableImportTargets.length, t]);
  const choosePortableSessionImport = useCallback(async (): Promise<void> => {
    if (portableImportTargets.length === 0) {
      setActionError(t("portable.importFailed"));
      return;
    }
    setActionError(undefined);
    const desktop = window.jokoDesktop;
    if (desktop === undefined) {
      setPortableImportRequest({ id: ++portableImportRequestIdRef.current });
      return;
    }
    try {
      const selected = await desktop.choosePortableSessionFile();
      if (selected !== undefined) openPortableSessionImportFile(browserFileFromDesktopFile(selected));
    } catch (error) {
      setActionError(messageOf(error, t("portable.importFailed")));
    }
  }, [openPortableSessionImportFile, portableImportTargets.length, t]);
  useEffect(() => {
    if (sessionApplicationWindow) return;
    const api = window.jokoDesktop?.deepLinks;
    if (api === undefined) return;
    let active = true;
    const navigate = (navigation: JokoDesktopDeepLinkNavigation): void => {
      if (!active) return;
      if (navigation.kind === "portable") {
        setActionError(undefined);
        setPortableImportRequest({
          id: ++portableImportRequestIdRef.current,
          ...(navigation.file === undefined ? {} : { file: browserFileFromDesktopFile(navigation.file) })
        });
        return;
      }
      window.location.hash = desktopDeepLinkRouteHash(navigation);
    };
    const unsubscribe = api.onNavigate(navigate);
    void api.takePending().then((navigation) => {
      if (navigation !== undefined) navigate(navigation);
    }).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [sessionApplicationWindow]);

  const submitNewSession = useCallback(async (draft: DelayedNewSessionDraft, input: ComposerDraft): Promise<void> => {
    const actionKey = "create-session";
    setActionError(undefined);
    setBusyAction(actionKey);
    try {
      await createDelayedSessionFromFirstInput(controller, draft, input, async (sessionId) => {
        // Reveal the durable task before sendInput. If dispatch fails, the user
        // lands on the created task and sees the recoverable operation error.
        await controller.clearNewSessionDraft().catch((error: unknown) => setActionError(messageOf(error, t("error.unexpected"))));
        controller.navigate({ kind: "session", sessionId });
      });
    } catch (error: unknown) {
      setActionError(messageOf(error, t("error.unexpected")));
      throw error;
    } finally {
      setBusyAction((current) => current === actionKey ? undefined : current);
    }
  }, [controller, t]);

  const activeSession = useMemo(() => {
    if (state.route.kind !== "session" && state.route.kind !== "files") return undefined;
    const sessionId = state.route.sessionId;
    if (sessionId !== undefined) return state.snapshot.sessions.find((session) => session.id === sessionId);
    return [...state.snapshot.sessions].filter((session) => !session.archived).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)[0];
  }, [state.route, state.snapshot.sessions]);
  const nativeTaskStatusVisibleSessionIds = useMemo(() => {
    if (state.route.kind !== "session" && state.route.kind !== "files") return [];
    if (state.route.kind === "session" && sessionSplitLayout.root !== undefined) {
      return Object.freeze(sessionSplitPanes(sessionSplitLayout.root).map((pane) => pane.sessionId));
    }
    return Object.freeze(activeSession === undefined ? [] : [activeSession.id]);
  }, [activeSession, sessionSplitLayout.root, state.route.kind]);
  const sidebarSnapshot = useMemo(() => {
    const sessions = applySessionProjectOverrides(state.snapshot.sessions, sessionProjectOverrides);
    return sessions === state.snapshot.sessions ? state.snapshot : { ...state.snapshot, sessions };
  }, [sessionProjectOverrides, state.snapshot]);
  useEffect(() => {
    setSessionProjectOverrides((current) => reconcileSessionProjectOverrides(current, state.snapshot.sessions));
  }, [state.snapshot.sessions]);
  const placementOwnerId = state.activeProfile?.serverId;
  const placementOwnerIdRef = useRef<string | undefined>(placementOwnerId);
  useEffect(() => {
    if (placementOwnerIdRef.current === placementOwnerId) return;
    placementOwnerIdRef.current = placementOwnerId;
    setSessionProjectOverrides(new Map());
    setMovingSessionProjectIds(new Set());
  }, [placementOwnerId]);
  const splitOwnerId = state.activeProfile?.serverId;
  const splitOwnerRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (splitOwnerId === undefined || splitOwnerRef.current === splitOwnerId) return;
    splitOwnerRef.current = splitOwnerId;
    const layout = readSessionSplitLayout(splitOwnerId, !sessionApplicationWindow);
    setSessionSplitLayout(layout);
    setFocusedSplitSessionId(activeSession?.id ?? sessionSplitPanes(layout.root)[0]?.sessionId);
  }, [activeSession?.id, sessionApplicationWindow, splitOwnerId]);
  const commitSessionSplitLayout = useCallback((layout: SessionSplitLayout): void => {
    setSessionSplitLayout(layout);
    if (splitOwnerId !== undefined) writeSessionSplitLayout(splitOwnerId, layout, !sessionApplicationWindow);
  }, [sessionApplicationWindow, splitOwnerId]);
  useEffect(() => {
    if (splitOwnerId === undefined || state.connectionState !== "connected" || state.snapshot.revision === 0n) return;
    const existing = new Set(state.snapshot.sessions.filter((session) => !session.archived).map((session) => session.id));
    const next = reconcileSessionSplit(sessionSplitLayout, existing);
    if (next !== sessionSplitLayout) commitSessionSplitLayout(next);
    const routeSessionId = state.route.kind === "session" ? state.route.sessionId : undefined;
    const focusedExists = focusedSplitSessionId === undefined || existing.has(focusedSplitSessionId);
    const routeExists = routeSessionId === undefined || existing.has(routeSessionId);
    if (focusedExists && routeExists) return;
    const replacement = sessionSplitPanes(sessionSplitLayout.root)
      .find((pane) => existing.has(pane.sessionId))?.sessionId;
    setFocusedSplitSessionId(replacement);
    if (!routeExists) controller.navigate(replacement === undefined
      ? { kind: "session" }
      : { kind: "session", sessionId: replacement });
  }, [
    commitSessionSplitLayout,
    controller,
    focusedSplitSessionId,
    sessionSplitLayout,
    splitOwnerId,
    state.connectionState,
    state.route,
    state.snapshot.revision,
    state.snapshot.sessions
  ]);
  const lastSplitRouteSessionIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (state.route.kind !== "session" || activeSession === undefined) {
      lastSplitRouteSessionIdRef.current = undefined;
      return;
    }
    const routeChanged = lastSplitRouteSessionIdRef.current !== activeSession.id;
    lastSplitRouteSessionIdRef.current = activeSession.id;
    if (sessionSplitLayout.root === undefined) return;
    const panes = sessionSplitPanes(sessionSplitLayout.root);
    if (panes.some((pane) => pane.sessionId === activeSession.id)) {
      if (routeChanged || !panes.some((pane) => pane.sessionId === focusedSplitSessionId)) {
        setFocusedSplitSessionId(activeSession.id);
      }
      return;
    }
    const replaceId = panes.some((pane) => pane.sessionId === focusedSplitSessionId)
      ? focusedSplitSessionId!
      : panes[0]?.sessionId;
    if (replaceId === undefined) return;
    const next = replaceSessionSplit(sessionSplitLayout, replaceId, activeSession.id);
    if (next !== sessionSplitLayout) commitSessionSplitLayout(next);
    setFocusedSplitSessionId(activeSession.id);
  }, [activeSession, commitSessionSplitLayout, focusedSplitSessionId, sessionSplitLayout, state.route.kind]);
  useEffect(() => {
    if (layoutNotice === undefined) return;
    const timer = window.setTimeout(() => setLayoutNotice(undefined), 4_000);
    return () => window.clearTimeout(timer);
  }, [layoutNotice]);
  const activeSessionIdRef = useRef<string | undefined>(activeSession?.id);
  activeSessionIdRef.current = activeSession?.id;
  const insertFileSelectionQuote = useCallback((sessionId: string, quote: ComposerFileSelectionQuoteDraft): void => {
    // Inspector portals may outlive one render of a route transition. Fence at
    // commit time as well as at SessionPane consumption time.
    const nextId = fileSelectionQuoteInsertionIdRef.current + 1;
    const insertion = fileSelectionQuoteInsertionFor(nextId, activeSessionIdRef.current, sessionId, quote);
    if (insertion === undefined) return;
    fileSelectionQuoteInsertionIdRef.current = nextId;
    setFileSelectionQuoteInsertion(insertion);
  }, []);
  useEffect(() => {
    setFileSelectionQuoteInsertion((current) => current?.sessionId === activeSession?.id ? current : undefined);
    setFileAttachmentInsertion((current) => current?.sessionId === activeSession?.id ? current : undefined);
  }, [activeSession?.id]);
  const activeTarget = activeSession === undefined ? undefined : state.snapshot.targets.find((target) => target.id === activeSession.targetId);
  const settingsTargetIdRef = useRef<string | undefined>(activeTarget?.id);
  if (state.route.kind !== "settings") settingsTargetIdRef.current = activeTarget?.id;
  const activeBackend = activeSession === undefined ? undefined : state.snapshot.backends.find((backend) => backend.id === activeSession.backendId);
  const acknowledgedAttentionRef = useRef(new Set<string>());
  const attentionAckRetryTimerRef = useRef<{
    readonly key: string;
    readonly timer: number;
  } | undefined>(undefined);
  const attentionAckRetryTrackerRef = useRef(new SessionAttentionAcknowledgementRetryTracker());
  const [attentionAckRetryRevision, setAttentionAckRetryRevision] = useState(0);
  const attentionThroughCursor = activeSession !== undefined
    && state.connectionState === "connected"
    && activeBackend?.capabilities.get("session.attention")?.supported === true
    ? viewerAttentionCursorWhenHistoryReady(activeSession, state.snapshot.generation, timelineHistory)
    : undefined;
  const activeAttentionAckKey = activeSession === undefined || attentionThroughCursor === undefined
    ? undefined
    : `${activeSession.id}\u0000${attentionThroughCursor.opaqueToken}`;
  attentionAckRetryTrackerRef.current.activate(activeAttentionAckKey);
  useEffect(() => {
    const key = activeAttentionAckKey;
    const pendingRetry = attentionAckRetryTimerRef.current;
    if (pendingRetry !== undefined && pendingRetry.key !== key) {
      window.clearTimeout(pendingRetry.timer);
      attentionAckRetryTimerRef.current = undefined;
    }
    if (activeSession === undefined || attentionThroughCursor === undefined || key === undefined) return;
    if (acknowledgedAttentionRef.current.has(key)) return;
    if (!attentionAckRetryTrackerRef.current.begin(key)) return;
    acknowledgedAttentionRef.current.add(key);
    if (acknowledgedAttentionRef.current.size > 512) {
      const oldest = acknowledgedAttentionRef.current.values().next().value as string | undefined;
      if (oldest !== undefined && oldest !== key) acknowledgedAttentionRef.current.delete(oldest);
    }
    void controllerRef.current.acknowledgeSessionAttention(
      activeSession.id,
      attentionThroughCursor
    ).then(() => {
      attentionAckRetryTrackerRef.current.succeeded(key);
    }).catch((error: unknown) => {
      acknowledgedAttentionRef.current.delete(key);
      const delayMs = attentionAckRetryTrackerRef.current.failed(key, error);
      if (delayMs === undefined) return;
      const timer = window.setTimeout(() => {
        if (!attentionAckRetryTrackerRef.current.release(key)) return;
        attentionAckRetryTimerRef.current = undefined;
        setAttentionAckRetryRevision((current) => current + 1);
      }, delayMs);
      attentionAckRetryTimerRef.current = { key, timer };
    });
  }, [
    activeAttentionAckKey,
    activeSession,
    attentionAckRetryRevision,
    attentionThroughCursor
  ]);
  useEffect(() => () => {
    const retry = attentionAckRetryTimerRef.current;
    if (retry !== undefined) window.clearTimeout(retry.timer);
  }, []);
  const activeReviewerRun = reviewRunForReviewerSession(state.snapshot.reviewRuns, activeSession?.id);
  const activeImageAttachments = activeReviewerRun === undefined
    && resolveComposerAttachmentPolicy(activeBackend, activeSession?.model?.supportsImages).images;
  const insertFileAttachment = useCallback((sessionId: string, file: File): void => {
    if (!activeImageAttachments) return;
    const nextId = fileAttachmentInsertionIdRef.current + 1;
    const insertion = fileAttachmentInsertionFor(nextId, activeSessionIdRef.current, sessionId, file);
    if (insertion === undefined) return;
    fileAttachmentInsertionIdRef.current = nextId;
    setFileAttachmentInsertion(insertion);
  }, [activeImageAttachments]);
  const activeWorkspaceId = activeSession?.worktree === undefined
    ? activeTarget?.workspaceId
    : activeSession.worktree.state === "active" ? activeSession.worktree.workspaceId : undefined;
  const activeWorkspace = activeWorkspaceId === undefined
    ? undefined
    : state.snapshot.workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  const formalFilesMode = state.route.kind === "files"
    && activeSession !== undefined
    && activeTarget !== undefined
    && activeBackend?.capabilities.get("workspace.files")?.supported === true
    && activeWorkspace !== undefined;
  const activeTimelineHistoryRevision = activeSession === undefined
    ? 0n
    : state.snapshot.timelineHistoryRevisionBySession.get(activeSession.id) ?? 0n;
  const requestTimelineHistoryPage = useCallback(async (
    sessionId: string,
    generation: bigint,
    beforeCursor: TimelineHistoryCursorView | undefined,
    reset: boolean
  ): Promise<void> => {
    const requestId = ++timelineHistoryRequestIdRef.current;
    setTimelineHistory((current) => reset || current?.sessionId !== sessionId || current.generation !== generation
      ? { sessionId, generation, items: [], initialized: false, loading: true }
      : {
          sessionId,
          generation,
          items: current.items,
          ...(current.nextBeforeCursor === undefined ? {} : { nextBeforeCursor: current.nextBeforeCursor }),
          initialized: current.initialized,
          loading: true
        });
    try {
      const page = await controllerRef.current.loadSessionTimelinePage(sessionId, beforeCursor, 240);
      if (timelineHistoryRequestIdRef.current !== requestId) return;
      setTimelineHistory((current) => {
        if (current?.sessionId !== sessionId || current.generation !== generation) return current;
        return {
          sessionId,
          generation,
          items: reset ? page.items : mergeTimelineWindows(current.items, page.items),
          ...(page.nextBeforeCursor === undefined ? {} : { nextBeforeCursor: page.nextBeforeCursor }),
          initialized: true,
          loading: false
        };
      });
    } catch (error) {
      if (timelineHistoryRequestIdRef.current !== requestId) return;
      setTimelineHistory((current) => current?.sessionId !== sessionId || current.generation !== generation
        ? current
        : { ...current, loading: false, error: messageOf(error, "Unable to load task history.") });
    }
  }, []);

  useEffect(() => {
    if (activeSession === undefined) {
      timelineHistoryRequestIdRef.current += 1;
      setTimelineHistory(undefined);
      return;
    }
    if (state.connectionState !== "connected") return;
    void requestTimelineHistoryPage(activeSession.id, state.snapshot.generation, undefined, true);
  }, [activeSession?.id, activeTimelineHistoryRevision, requestTimelineHistoryPage, state.connectionState, state.snapshot.generation]);

  const recentActiveTimeline = activeSession === undefined ? EMPTY_TIMELINE : state.snapshot.timelineBySession.get(activeSession.id) ?? EMPTY_TIMELINE;
  const activeHistory = activeSession !== undefined && timelineHistory?.sessionId === activeSession.id && timelineHistory.generation === state.snapshot.generation
    ? timelineHistory
    : undefined;
  const activeHistoryItems = activeHistory?.items;
  const recentAndHistoricalTimeline = useMemo(
    () => activeHistoryItems === undefined
      ? recentActiveTimeline
      : mergeTimelineWindows(recentActiveTimeline, activeHistoryItems),
    [activeHistoryItems, recentActiveTimeline]
  );
  const activeTimeline = useMemo(
    () => activeSession === undefined || searchTimelineWindow?.sessionId !== activeSession.id
      ? recentAndHistoricalTimeline
      : mergeTimelineWindows(recentAndHistoricalTimeline, searchTimelineWindow.items),
    [activeSession, recentAndHistoricalTimeline, searchTimelineWindow]
  );
  const loadEarlierTimeline = useCallback(async (): Promise<void> => {
    if (activeSession === undefined || activeHistory?.loading === true) return;
    if (activeHistory?.initialized === true && activeHistory.nextBeforeCursor === undefined) return;
    await requestTimelineHistoryPage(
      activeSession.id,
      state.snapshot.generation,
      activeHistory?.nextBeforeCursor,
      activeHistory?.initialized !== true
    );
  }, [activeHistory, activeSession, requestTimelineHistoryPage, state.snapshot.generation]);

  useEffect(() => {
    const messageId = state.route.kind === "session" ? state.route.messageId : undefined;
    const messageEventId = state.route.kind === "session" ? state.route.messageEventId : undefined;
    if (activeSession === undefined || messageId === undefined) {
      if (currentMessageDeepLinkRef.current !== undefined) messageJumpGenerationRef.current += 1;
      currentMessageDeepLinkRef.current = undefined;
      handledMessageDeepLinkRef.current = undefined;
      loadingMessageDeepLinkRef.current = undefined;
      return;
    }
    const deepLinkKey = `${activeSession.id}\u0000${messageEventId ?? ""}\u0000${messageId}\u0000${state.snapshot.generation}\u0000${state.navigationRevision ?? 0}`;
    if (currentMessageDeepLinkRef.current !== deepLinkKey) {
      messageJumpGenerationRef.current += 1;
      currentMessageDeepLinkRef.current = deepLinkKey;
      handledMessageDeepLinkRef.current = undefined;
      loadingMessageDeepLinkRef.current = undefined;
    }
    if (activeTimeline.some((item) => item.id === messageId)) {
      if (handledMessageDeepLinkRef.current === deepLinkKey) return;
      handledMessageDeepLinkRef.current = deepLinkKey;
      setActionError(undefined);
      setTimelineFocusRequest({
        sessionId: activeSession.id,
        itemId: messageId,
        requestId: ++timelineFocusRequestIdRef.current
      });
      return;
    }
    if (state.connectionState !== "connected") return;
    if (messageEventId !== undefined) {
      if (loadingMessageDeepLinkRef.current === deepLinkKey || handledMessageDeepLinkRef.current === deepLinkKey) return;
      loadingMessageDeepLinkRef.current = deepLinkKey;
      const jumpGeneration = ++messageJumpGenerationRef.current;
      setActionError(undefined);
      setBusyAction(`message-link:${messageEventId}`);
      void controllerRef.current.loadSessionTimelineAround(activeSession.id, messageEventId, 160).then((items) => {
        if (messageJumpGenerationRef.current !== jumpGeneration || currentMessageDeepLinkRef.current !== deepLinkKey) return;
        if (!items.some((item) => item.id === messageId)) throw new Error(t("nav.messageJumpUnavailable"));
        handledMessageDeepLinkRef.current = deepLinkKey;
        setSearchTimelineWindow({ sessionId: activeSession.id, items });
        setTimelineFocusRequest({
          sessionId: activeSession.id,
          itemId: messageId,
          requestId: ++timelineFocusRequestIdRef.current
        });
      }).catch((error: unknown) => {
        if (messageJumpGenerationRef.current === jumpGeneration && currentMessageDeepLinkRef.current === deepLinkKey) {
          setActionError(messageOf(error, t("nav.messageJumpUnavailable")));
        }
      }).finally(() => {
        if (loadingMessageDeepLinkRef.current === deepLinkKey) loadingMessageDeepLinkRef.current = undefined;
        setBusyAction((current) => current === `message-link:${messageEventId}` ? undefined : current);
      });
      return;
    }
    if (
      activeHistory?.initialized !== true
      || activeHistory.loading
      || activeHistory.nextBeforeCursor === undefined
    ) return;
    void requestTimelineHistoryPage(activeSession.id, state.snapshot.generation, activeHistory.nextBeforeCursor, false);
  }, [activeHistory, activeSession, activeTimeline, requestTimelineHistoryPage, state.connectionState, state.navigationRevision, state.route, state.snapshot.generation, t]);
  const activeExtensionWidgets = activeSession === undefined ? [] : state.snapshot.extensionWidgetsBySession.get(activeSession.id) ?? [];
  const activeExtensionStatuses = activeSession === undefined ? [] : state.snapshot.extensionStatusesBySession.get(activeSession.id) ?? [];
  const interactions = useMemo(() => [...state.snapshot.interactions].sort((a, b) =>
    Number(a.sessionId !== activeSession?.id) - Number(b.sessionId !== activeSession?.id) ||
    interactionPriority(a.kind) - interactionPriority(b.kind) ||
    a.createdAt - b.createdAt
  ), [activeSession?.id, state.snapshot.interactions]);
  const activeInteractions = (state.route.kind === "session" || state.route.kind === "files") && activeSession !== undefined ? interactions.filter((interaction) => interaction.sessionId === activeSession.id) : [];
  const backgroundInteraction = interactions.find((interaction) => interaction.sessionId.length > 0 && interaction.sessionId !== activeSession?.id);

  const shortcutOverrides = state.preferences.appShortcutOverrides;
  const shortcutInspectorOpen = state.preferences.inspectorOpen
    && state.route.kind === "session"
    && activeSession !== undefined
    && activeReviewerRun === undefined;
  const navigateFromApplicationMenu = async (route: Parameters<AppController["navigate"]>[0]): Promise<boolean> => {
    if (state.route.kind !== "files") {
      controller.navigate(route);
      return true;
    }
    const filesSessionId = state.route.sessionId;
    const allowed = await requestWorkspaceDocumentLeave({
      reason: "switch-session",
      matches: (identity) => identity.sessionId === filesSessionId
    });
    if (allowed) controller.navigate(route);
    return allowed;
  };
  const navigateFromShortcut = (route: Parameters<AppController["navigate"]>[0]): void => {
    void navigateFromApplicationMenu(route);
  };
  const applicationMenuPreferences = {
    navigationOpen: effectiveNavigationOpen,
    windowZoom: state.preferences.windowZoom
  } as const;
  applicationMenuTargetRef.current = {
    preferences: applicationMenuPreferences,
    openAbout: async () => {
      if (await navigateFromApplicationMenu({ kind: "settings" })) window.location.hash = "#/settings/about";
    },
    openNewSession: async () => { await navigateFromApplicationMenu({ kind: "newSession" }); },
    openSettings: async () => { await navigateFromApplicationMenu({ kind: "settings" }); },
    openTaskStatusSettings: async () => {
      if (await navigateFromApplicationMenu({ kind: "settings" })) window.location.hash = "#/settings/taskStatus";
    },
    checkForUpdates: async () => {
      const result = await window.jokoDesktop?.checkForUpdates();
      if (result === undefined) return;
      applicationMenuNoticeIdRef.current += 1;
      setApplicationMenuNotice({
        id: applicationMenuNoticeIdRef.current,
        ...desktopUpdateCheckNotice(result)
      });
    },
    setNavigationOpen: async (open) => setWindowNavigationOpen(open),
    setWindowZoom: (zoom) => controller.setWindowZoom(zoom),
    onError: (error) => setActionError(messageOf(error, t("error.unexpected")))
  };
  applicationMenuCommandQueue.sync(applicationMenuPreferences);
  const applicationMenuAccelerators = desktopApplicationMenuAccelerators(shortcutOverrides);

  // Subscribe before the initial full accelerator sync. Main holds menu
  // commands behind that sync, so no cold-start click can outrun this listener.
  useEffect(() => window.jokoDesktop?.applicationMenu.onCommand((command) => {
    // Native menu commands do not traverse the DOM's modal/inert boundary.
    // Discard them while startup update owns the renderer; window chrome uses
    // its separate preload APIs and remains available.
    if (isStartupUpdateInteractionBlocked()) return;
    applicationMenuCommandQueue.handle(command);
  }), [applicationMenuCommandQueue]);
  useEffect(() => {
    if (!state.ready) return;
    void window.jokoDesktop?.applicationMenu.configure(applicationMenuAccelerators).catch(() => undefined);
  }, [
    applicationMenuAccelerators.newSessionAccelerator,
    applicationMenuAccelerators.openSettingsAccelerator,
    applicationMenuAccelerators.toggleSidebarAccelerator,
    state.ready
  ]);

  useAppShortcut("new-maker", shortcutOverrides, (event) => {
    if (shortcutBlocked(event)) return false;
    navigateFromShortcut({ kind: "newSession" });
    return true;
  });
  useAppShortcut("toggle-sidebar", shortcutOverrides, (event) => {
    if (shortcutBlocked(event)) return false;
    const editable = event.target instanceof Element ? event.target.closest<HTMLElement>("[contenteditable='true']") : null;
    if (editable !== null && editable.closest("[data-composer-editor='true']") === null) return false;
    setWindowNavigationOpen(!effectiveNavigationOpen);
    return true;
  });
  useAppShortcut("open-settings", shortcutOverrides, (event) => {
    if (shortcutBlocked(event)) return false;
    navigateFromShortcut({ kind: "settings" });
    return true;
  });
  useAppShortcut("close-tab-or-window", shortcutOverrides, (event) => {
    if (shortcutBlocked(event) || (shortcutInspectorOpen && !inspectorDetached)) return false;
    const desktop = window.jokoDesktop;
    if (currentAppShortcutPlatform() !== "darwin" || desktop === undefined) return false;
    void desktop.window.close().catch(() => undefined);
    return true;
  });
  useAppShortcut("zoom-in", shortcutOverrides, (event) => {
    if (shortcutBlocked(event) || zoomShortcutBlockedTarget(event.target)) return false;
    void controller.setWindowZoom(state.preferences.windowZoom + 0.1);
    return true;
  }, { stopImmediate: true });
  useAppShortcut("zoom-out", shortcutOverrides, (event) => {
    if (shortcutBlocked(event) || zoomShortcutBlockedTarget(event.target)) return false;
    void controller.setWindowZoom(state.preferences.windowZoom - 0.1);
    return true;
  }, { stopImmediate: true });
  useAppShortcut("zoom-reset", shortcutOverrides, (event) => {
    if (shortcutBlocked(event) || zoomShortcutBlockedTarget(event.target)) return false;
    void controller.setWindowZoom(1);
    return true;
  }, { stopImmediate: true });

  useSessionSwitchShortcut("switch-session-1", 0, controller, state.route, effectiveNavigationOpen, shortcutOverrides);
  useSessionSwitchShortcut("switch-session-2", 1, controller, state.route, effectiveNavigationOpen, shortcutOverrides);
  useSessionSwitchShortcut("switch-session-3", 2, controller, state.route, effectiveNavigationOpen, shortcutOverrides);
  useSessionSwitchShortcut("switch-session-4", 3, controller, state.route, effectiveNavigationOpen, shortcutOverrides);
  useSessionSwitchShortcut("switch-session-5", 4, controller, state.route, effectiveNavigationOpen, shortcutOverrides);
  useSessionSwitchShortcut("switch-session-6", 5, controller, state.route, effectiveNavigationOpen, shortcutOverrides);
  useSessionSwitchShortcut("switch-session-7", 6, controller, state.route, effectiveNavigationOpen, shortcutOverrides);
  useSessionSwitchShortcut("switch-session-8", 7, controller, state.route, effectiveNavigationOpen, shortcutOverrides);
  useSessionSwitchShortcut("switch-session-9", 8, controller, state.route, effectiveNavigationOpen, shortcutOverrides);

  const applicationMenuFeedback = applicationMenuNotice === undefined ? null : (
    <div className="extension-notifications" aria-live="assertive" aria-relevant="additions removals">
      <div className="extension-notification" role="status" key={`application-menu-${applicationMenuNotice.id}`}>
        <Bell aria-hidden="true" />
        <span className="extension-notification__body">{t(applicationMenuNotice.key, applicationMenuNotice.values)}</span>
        <IconButton label={t("common.dismiss")} onClick={() => setApplicationMenuNotice(undefined)}><X aria-hidden="true" /></IconButton>
      </div>
    </div>
  );
  const aboutRequested = typeof window !== "undefined" && /^#\/settings\/about(?:[/?#]|$)/u.test(window.location.hash);
  const standaloneAboutRequested = aboutRequested && (
    !state.ready
    || state.activeProfile === undefined
    || state.connectionState === "disconnected"
    || (state.connectionState === "connecting" && state.snapshot.revision === 0n)
    || (state.snapshot.revision === 0n && state.connectionState !== "connected")
  );

  if (standaloneAboutRequested) return <>
    {applicationMenuFeedback}
    <AppErrorBoundary
      scope="route"
      resetKey={routeErrorBoundaryKey("settings")}
      resetAfterNavigation
      onBackToTasks={() => controller.navigate({ kind: "session" })}
    >
      <Suspense fallback={<RouteLoading label={t("common.loading")} />}><StandaloneAboutPage snapshot={state.snapshot} t={t} /></Suspense>
    </AppErrorBoundary>
  </>;
  if (!state.ready) return <>{applicationMenuFeedback}<LoadingScreen label={t("common.loading")} body={t("app.openingState")} /></>;
  if (state.activeProfile === undefined || state.connectionState === "disconnected") return <>{applicationMenuFeedback}<ConnectionScreen controller={controller} t={t} /></>;
  if (state.connectionState === "connecting" && state.snapshot.revision === 0n) return <>{applicationMenuFeedback}<ConnectingScreen controller={controller} t={t} /></>;
  if (state.snapshot.revision === 0n && state.connectionState !== "connected") return <>{applicationMenuFeedback}<UnavailableScreen controller={controller} t={t} error={state.error} /></>;

  const preferredNavigation = sessionApplicationWindow ? sessionWindowNavigation : {
    mode: state.preferences.navigationMode,
    width: state.preferences.navigationWidth
  } as const;
  const navigationMode = navigationDrag?.mode ?? preferredNavigation.mode;
  const navigationWidth = navigationDrag?.visualWidth ?? navigationVisualWidth(preferredNavigation);
  const navigationOpen = navigationMode !== "hidden";
  const settingsRoute = state.route.kind === "settings";
  const shellNavigationOpen = navigationOpen && !settingsRoute;
  const creatingNewSession = state.route.kind === "newSession";
  const inspectorOpen = state.preferences.inspectorOpen && state.route.kind === "session" && activeSession !== undefined && activeReviewerRun === undefined;
  const inspectorAttached = inspectorOpen && !inspectorDetached;
  const closeNavigation = (): void => { if (window.matchMedia("(max-width: 980px)").matches) setWindowNavigationOpen(false); };
  const setNavigationMode = (mode: NavigationMode): void => {
    setWindowNavigationLayout({ mode, width: preferredNavigation.width });
  };
  const beginNavigationResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || navigationMode === "hidden") return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    const next = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: navigationWidth,
      visualWidth: navigationWidth,
      mode: navigationMode
    };
    navigationDragRef.current = next;
    setNavigationDrag(next);
  };
  const moveNavigationResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = navigationDragRef.current;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    const visualWidth = clampNavigationDragWidth(drag.startWidth + event.clientX - drag.startX);
    const next = { ...drag, visualWidth, mode: navigationModeForDragWidth(visualWidth) };
    navigationDragRef.current = next;
    setNavigationDrag(next);
  };
  const finishNavigationResize = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false): void => {
    const drag = navigationDragRef.current;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    // Clear synchronously before releasePointerCapture emits
    // lostpointercapture so that the cancel path cannot overwrite the last
    // pointer frame or leave the shell in its dragging presentation.
    navigationDragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setNavigationDrag(undefined);
    if (!cancelled) setWindowNavigationLayout(finalizeNavigationDrag(drag.visualWidth, preferredNavigation.width));
  };
  const handleNavigationResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const next = navigationLayoutForResizeKey(preferredNavigation, event.key, event.shiftKey);
    if (next === undefined) return;
    event.preventDefault();
    setWindowNavigationLayout(next);
  };
  const routeBoundaryKey = routeErrorBoundaryKey(
    state.route.kind,
    state.route.kind === "session" || state.route.kind === "files" ? state.route.sessionId : undefined
  );
  const shellOverlays = <>
    <VisionBridgeToasts t={t} />
    {state.extensionNotifications.length > 0 && (
      <div className="extension-notifications" aria-relevant="additions removals">
        {state.extensionNotifications.map((notification) => {
          const NotificationIcon = notification.kind === "error"
            ? CircleAlert
            : notification.kind === "warning"
              ? AlertTriangle
              : notification.kind === "info" ? Info : Bell;
          const severityLabel = notification.kind === "error"
            ? t("extension.notification.error")
            : notification.kind === "warning"
              ? t("extension.notification.warning")
              : notification.kind === "info"
                ? t("extension.notification.info")
                : t("extension.notification.unknown");
          return (
            <div
              className={cx("extension-notification", `is-${notification.kind}`)}
              data-notification-kind={notification.kind}
              role={notification.kind === "error" ? "alert" : "status"}
              aria-atomic="true"
              key={notification.eventId}
            >
              <NotificationIcon aria-hidden="true" />
              <button type="button" className="extension-notification__body" onClick={() => controller.navigate({ kind: "session", sessionId: notification.sessionId })}>
                <span className="sr-only">{severityLabel}: </span>{notification.text}
              </button>
              <IconButton label={t("common.dismiss")} onClick={() => controller.dismissExtensionNotification(notification.eventId)}><X aria-hidden="true" /></IconButton>
            </div>
          );
        })}
      </div>
    )}
    <div className="app-banners">
      {layoutNotice !== undefined && <div className="offline-banner" role="status"><span>{layoutNotice}</span><IconButton label={t("common.dismiss")} onClick={() => setLayoutNotice(undefined)}><X aria-hidden="true" /></IconButton></div>}
      {state.connectionState === "offline" && <div className="offline-banner" role="status"><AlertTriangle aria-hidden="true" /><span>{t("error.offline")}</span><Button tone="ghost" onClick={() => runAction("refresh", controller.refresh)}><RefreshCcw aria-hidden="true" />{t("common.refresh")}</Button></div>}
      {state.snapshot.server.health === "degraded" && <div className="degraded-banner" role="status"><ServerCrash aria-hidden="true" /><span>{t("app.degraded")}</span></div>}
      {state.error !== undefined && <ErrorBanner message={state.error} retryLabel={t("common.retry")} onRetry={() => runAction("refresh", controller.refresh)} />}
      {actionError !== undefined && <ErrorBanner message={actionError} dismissLabel={t("common.dismiss")} onClose={() => setActionError(undefined)} />}
      {backgroundInteraction !== undefined && <div className="pending-interaction-banner" role="status"><Bell aria-hidden="true" /><span>{t("interaction.pendingElsewhere")}</span><Button tone="ghost" onClick={() => controller.navigate({ kind: "session", sessionId: backgroundInteraction.sessionId })}>{t("interaction.openTask")}</Button></div>}
      {busyAction !== undefined && <div className="action-progress" role="status"><Spinner label={t("common.working")} /><span>{t("app.applyingChange")}</span></div>}
    </div>
  </>;
  const renderActiveSessionPane = (embeddedInFiles: boolean): JSX.Element | null => activeSession === undefined ? null : (
    <SessionPane
      controller={controller}
      session={activeSession}
      target={activeTarget}
      backend={activeBackend}
      reviewReadOnly={activeReviewerRun !== undefined}
      presentation={embeddedInFiles ? "filesRail" : "standard"}
      composerAutoFocus={!embeddedInFiles}
      models={state.snapshot.models}
      timeline={activeTimeline}
      timelineHasEarlier={activeHistory === undefined || !activeHistory.initialized || activeHistory.nextBeforeCursor !== undefined}
      timelineHistoryLoading={activeHistory?.loading ?? state.connectionState === "connected"}
      timelineHistoryError={activeHistory?.error}
      onLoadEarlierTimeline={loadEarlierTimeline}
      timelineFocusRequest={timelineFocusRequest?.sessionId === activeSession.id ? timelineFocusRequest : undefined}
      extensionWidgets={activeExtensionWidgets}
      extensionStatuses={activeExtensionStatuses}
      queue={state.snapshot.queue}
      queueControl={state.snapshot.queueControls.find((control) => control.sessionId === activeSession.id)}
      workspace={activeWorkspace}
      extraDirectories={state.snapshot.extraDirectories}
      resources={state.snapshot.resources}
      commandRefreshSignal={state.snapshot.commands}
      interaction={activeInteractions[0]}
      remainingInteractions={Math.max(0, activeInteractions.length - 1)}
      navigationOpen={embeddedInFiles || navigationOpen}
      inspectorOpen={embeddedInFiles ? false : inspectorOpen}
      inspectorAvailable={!embeddedInFiles}
      selectionQuoteInsertion={fileSelectionQuoteInsertion?.sessionId === activeSession.id ? fileSelectionQuoteInsertion : undefined}
      attachmentInsertion={fileAttachmentInsertion?.sessionId === activeSession.id ? fileAttachmentInsertion : undefined}
      t={t}
      runAction={runAction}
      onOpenNavigation={() => { if (!embeddedInFiles) setWindowNavigationOpen(true); }}
      onOpenInspector={() => { if (!embeddedInFiles && activeReviewerRun === undefined) void controller.setInspectorOpen(true); }}
      onOpenSubagent={embeddedInFiles || activeReviewerRun !== undefined ? undefined : (runId) => {
        setInspectorSubagentFocusRequest({ sessionId: activeSession.id, runId, requestId: ++inspectorSubagentFocusRequestIdRef.current });
        void controller.setInspectorOpen(true);
      }}
      onOpenTurnReview={embeddedInFiles || activeReviewerRun !== undefined ? undefined : (changeSetId, selectedPath) => {
        setInspectorTurnReviewFocusRequest(createInspectorTurnReviewRequest(
          ++inspectorTurnReviewFocusRequestIdRef.current,
          activeSession.id,
          changeSetId,
          selectedPath
        ));
        void controller.setInspectorOpen(true);
      }}
      onRename={() => setRenameSession(activeSession)}
      onPin={() => runAction(`pin:${activeSession.id}`, () => controller.pinSession(activeSession.id, !activeSession.pinned))}
      onArchive={() => runAction(`archive:${activeSession.id}`, async () => {
        const archive = !activeSession.archived;
        if (archive && !(await requestWorkspaceDocumentLeave({ reason: "switch-session", matches: (identity) => identity.sessionId === activeSession.id }))) return;
        await controller.archiveSession(activeSession.id, archive);
        if (!archive) return;
        if (sessionSplitPanes(sessionSplitLayout.root).some((pane) => pane.sessionId === activeSession.id)) {
          closeSessionSplitPane(activeSession.id);
        } else {
          controller.navigate({ kind: "session" });
        }
      })}
      onDelete={() => setDeleteSession(activeSession)}
      onMoveSessionProject={(placement) => moveTaskToProject(activeSession, placement)}
      movingSessionProject={movingSessionProjectIds.has(activeSession.id)}
      onCopyTaskLink={() => copyTaskLink(activeSession)}
      onExportPortableSession={() => setPortableExportSession(activeSession)}
      onSplitSession={(side) => {
        const anchor = focusedSplitSessionId ?? activeSession.id;
        addSessionToSplit(activeSession.id, anchor, side);
      }}
      onOpenSessionWindow={() => openTaskWindow(activeSession)}
    />
  );
  const focusSplitSession = (sessionId: string): void => {
    setFocusedSplitSessionId(sessionId);
    if (state.route.kind !== "session" || state.route.sessionId !== sessionId) {
      controller.navigate({ kind: "session", sessionId });
    }
  };
  const addSessionToSplit = (sessionId: string, anchorSessionId: string, side: SessionSplitSide): void => {
    const panes = sessionSplitPanes(sessionSplitLayout.root);
    if (panes.some((pane) => pane.sessionId === sessionId) || (sessionSplitLayout.root === undefined && activeSession?.id === sessionId)) {
      setLayoutNotice(t("split.duplicate"));
      focusSplitSession(sessionId);
      return;
    }
    const count = sessionSplitLayout.root === undefined ? 1 : panes.length;
    if (count >= MAXIMUM_SESSION_SPLIT_PANES) {
      setLayoutNotice(t("split.maximum"));
      return;
    }
    const next = addSessionSplit(sessionSplitLayout, sessionId, anchorSessionId, side);
    if (next === sessionSplitLayout) return;
    commitSessionSplitLayout(next);
    focusSplitSession(sessionId);
  };
  const closeSessionSplitPane = (sessionId: string): void => {
    const remaining = sessionSplitPanes(sessionSplitLayout.root).filter((pane) => pane.sessionId !== sessionId);
    const next = removeSessionSplit(sessionSplitLayout, sessionId);
    commitSessionSplitLayout(next);
    if (focusedSplitSessionId !== sessionId && activeSession?.id !== sessionId) return;
    const replacement = remaining[0]?.sessionId;
    setFocusedSplitSessionId(replacement);
    if (replacement !== undefined) controller.navigate({ kind: "session", sessionId: replacement });
  };
  const removeSessionsFromNavigation = (sessions: readonly SessionView[]): void => {
    const removed = new Set(sessions.map((session) => session.id));
    let nextLayout = sessionSplitLayout;
    for (const sessionId of removed) nextLayout = removeSessionSplit(nextLayout, sessionId);
    if (nextLayout !== sessionSplitLayout) commitSessionSplitLayout(nextLayout);
    if (activeSession === undefined || !removed.has(activeSession.id)) return;
    const replacement = sessionSplitPanes(nextLayout.root)[0]?.sessionId;
    controller.navigate(replacement === undefined ? { kind: "session" } : { kind: "session", sessionId: replacement });
  };
  const copyTaskLink = (session: SessionView): void => {
    let link: string;
    try {
      link = window.jokoDesktop?.capabilities.includes("navigation.deepLinks") === true
        ? desktopSessionTaskLink(session.id, state.activeProfile?.id)
        : sessionTaskLink(window.location, session.id, state.activeProfile?.id);
    } catch {
      setLayoutNotice(t("session.taskLinkCopyFailed"));
      return;
    }
    const write = navigator.clipboard?.writeText.bind(navigator.clipboard);
    if (write === undefined) {
      setLayoutNotice(t("session.taskLinkCopyFailed"));
      return;
    }
    void write(link).then(
      () => setLayoutNotice(t("session.taskLinkCopied")),
      () => setLayoutNotice(t("session.taskLinkCopyFailed"))
    );
  };
  const copyTargetLink = (target: TargetView): void => {
    const write = navigator.clipboard?.writeText.bind(navigator.clipboard);
    if (write === undefined) {
      setLayoutNotice(t("projects.linkCopyFailed"));
      return;
    }
    const link = new URL(appRouteHash({ kind: "projects", projectId: target.id }), window.location.href).href;
    void write(link).then(
      () => setLayoutNotice(t("projects.linkCopied")),
      () => setLayoutNotice(t("projects.linkCopyFailed"))
    );
  };
  const openTaskWindow = (session: SessionView): void => {
    const desktop = window.jokoDesktop;
    if (desktop?.capabilities.includes("session.windows") === true) {
      void desktop.sessionWindows.open(session.id).catch(() => setLayoutNotice(t("split.openFailed")));
      return;
    }
    if (openSessionWindowFallback(window.location, session.id, state.activeProfile?.id) === null) setLayoutNotice(t("split.openFailed"));
  };
  const moveTaskToProject = (session: SessionView, placement: SessionProjectNavigationPlacement): void => {
    const authoritative = state.snapshot.sessions.find((candidate) => candidate.id === session.id);
    if (authoritative === undefined) {
      setLayoutNotice(t("session.moveProjectUnavailable"));
      return;
    }
    const block = sessionProjectMoveBlock(authoritative);
    if (block !== undefined) {
      setLayoutNotice(t(block === "archived"
        ? "session.moveProjectBlockedArchived"
        : block === "remote"
          ? "session.moveProjectBlockedRemote"
          : block === "busy"
            ? "session.moveProjectBlockedBusy"
            : block === "attached"
              ? "session.moveProjectBlockedAttached"
              : "session.moveProjectBlockedClosed"));
      return;
    }
    if (sameSessionProjectPlacement(authoritative, placement) || movingSessionProjectIdsRef.current.has(session.id)) return;
    const destination = placement.kind === "project"
      ? state.snapshot.targets.find((target) => target.id === placement.projectId && !target.archived && target.remoteWorkspace === undefined)
      : undefined;
    if (placement.kind === "project" && destination === undefined) {
      setLayoutNotice(t("session.moveProjectUnavailable"));
      return;
    }
    const ownerLayout = sidebarOwnerLayoutFor(state.preferences.sidebarOwnerLayouts, placementOwnerId);
    const previousLayout = placement.kind === "project"
      ? { collapsedProjectIds: ownerLayout.collapsedProjectIds }
      : { collapsedDialogue: ownerLayout.collapsedDialogue };
    const revealPatch = placement.kind === "project"
      ? { collapsedProjectIds: ownerLayout.collapsedProjectIds.filter((id) => id !== placement.projectId) }
      : { collapsedDialogue: false };
    setActionError(undefined);
    setLayoutNotice(undefined);
    setSessionProjectOverrides((current) => new Map(current).set(session.id, placement));
    const nextMoving = new Set(movingSessionProjectIdsRef.current);
    nextMoving.add(session.id);
    movingSessionProjectIdsRef.current = nextMoving;
    setMovingSessionProjectIds(nextMoving);
    void controller.setSidebarOwnerLayout(revealPatch).catch(() => undefined);
    void controller.moveSessionProject(
      session.id,
      placement.kind === "project" ? placement.projectId : undefined
    ).then(() => {
      setLayoutNotice(placement.kind === "project"
        ? t("session.moveProjectSuccess", { project: destination!.name })
        : t("session.moveDialogueSuccess"));
    }).catch((error: unknown) => {
      setSessionProjectOverrides((current) => {
        return rollbackSessionProjectOverride(current, session.id, placement);
      });
      void controller.setSidebarOwnerLayout(previousLayout).catch(() => undefined);
      setLayoutNotice(t("session.moveProjectFailed"));
      setActionError(messageOf(error, t("error.unexpected")));
    }).finally(() => {
      const next = new Set(movingSessionProjectIdsRef.current);
      next.delete(session.id);
      movingSessionProjectIdsRef.current = next;
      setMovingSessionProjectIds(next);
    });
  };
  const renderSessionSplitPane = (sessionId: string): JSX.Element | null => {
    if (activeSession?.id === sessionId) return renderActiveSessionPane(false);
    return <SplitSessionPaneHost
      key={sessionId}
      controller={controller}
      sessionId={sessionId}
      navigationOpen={navigationOpen}
      t={t}
      runAction={runAction}
      onOpenNavigation={() => setWindowNavigationOpen(true)}
      onRename={setRenameSession}
      onPin={(session) => runAction(`pin:${session.id}`, () => controller.pinSession(session.id, !session.pinned))}
      onArchive={(session) => runAction(`archive:${session.id}`, async () => {
        const archive = !session.archived;
        await controller.archiveSession(session.id, archive);
        if (archive) closeSessionSplitPane(session.id);
      })}
      onDelete={setDeleteSession}
      onMoveSessionProject={moveTaskToProject}
      movingSessionProject={movingSessionProjectIds.has(sessionId)}
      onCopyTaskLink={copyTaskLink}
      onExportPortableSession={setPortableExportSession}
      onSplitSession={(session, side) => addSessionToSplit(session.id, session.id, side)}
      onOpenSessionWindow={openTaskWindow}
      onOpenTurnReview={(session, changeSetId, selectedPath) => {
        focusSplitSession(session.id);
        setInspectorTurnReviewFocusRequest(createInspectorTurnReviewRequest(
          ++inspectorTurnReviewFocusRequestIdRef.current,
          session.id,
          changeSetId,
          selectedPath
        ));
        void controller.setInspectorOpen(true);
      }}
    />;
  };

  return (
    <div
      className={cx("app", shellNavigationOpen && "has-navigation", settingsRoute ? "navigation-hidden" : `navigation-${navigationMode}`, formalFilesMode && "workspace-files-mode", navigationDrag !== undefined && !settingsRoute && "is-navigation-resizing", inspectorAttached && "has-inspector")}
      style={{
        "--sidebar-width": `${navigationWidth}px`,
        "--sidebar-expanded-width": `${state.preferences.navigationWidth}px`
      } as CSSProperties}
    >
      <NativeTaskStatusBridge
        controller={controller}
        ownsProjection={!sessionApplicationWindow}
        visibleSessionIds={nativeTaskStatusVisibleSessionIds}
      />
      <a className="skip-link" href="#main-content">{t("app.skipToContent")}</a>
      <DesktopPageSearchBar overrides={shortcutOverrides} t={t} />
      {applicationMenuFeedback}
      {!formalFilesMode && !settingsRoute && <Sidebar
        snapshot={sidebarSnapshot}
        activeSessionId={creatingNewSession ? undefined : activeSession?.id}
        route={state.route}
        locale={state.preferences.locale}
        messageSearchSort={state.preferences.messageSearchSort}
        sidebarOwnerId={state.activeProfile.serverId}
        sidebarDisplayPreferences={state.preferences.sidebarDisplayPreferences}
        sidebarOwnerLayouts={state.preferences.sidebarOwnerLayouts}
        open={navigationOpen}
        mode={navigationMode}
        width={navigationWidth}
        searchInputRef={searchInputRef}
        t={t}
        probeRuntimeActivity={controller.probeRuntimeActivity}
        machineControl={{
          profiles: state.profiles,
          activeProfile: state.activeProfile,
          presenceByProfile: state.machinePresenceByProfile,
          caches: state.machineCaches,
          selection: state.preferences.machineSelection,
          onSelectionChange: (selection) => { void controller.setMachineSelection(selection); },
          onRefresh: () => runAction("refresh-machines", () => controller.refreshMachines()),
          onSwitch: (profile) => {
            if (profile.id !== state.activeProfile?.id) runAction(`switch-machine:${profile.id}`, () => controller.switchMachine(profile.id));
          },
          onRepair: () => controller.navigate({ kind: "settings" }),
          onOpenCachedSession: (profileId, sessionId) => runAction(
            `open-machine-session:${profileId}:${sessionId}`,
            () => controller.openMachineSession(profileId, sessionId)
          ),
          onOpenMessageMatch: (profileId, match) => {
            messageJumpGenerationRef.current += 1;
            setTimelineFocusRequest(undefined);
            setSearchTimelineWindow(undefined);
            runAction(`open-machine-message:${profileId}:${match.sessionId}:${match.eventId}`, async () => {
              await controller.openMachineSession(profileId, match.sessionId);
              controller.navigate({
                kind: "session",
                profileId,
                sessionId: match.sessionId,
                messageEventId: match.eventId,
                messageId: match.timelineItemId
              });
            });
          }
        }}
        onNavigate={(route) => {
          messageJumpGenerationRef.current += 1;
          setTimelineFocusRequest(undefined);
          setSearchTimelineWindow(undefined);
          controller.navigate(route);
        }}
        onNewTask={() => controller.navigate({ kind: "newSession" })}
        onNewTaskInTarget={(target) => controller.navigate({ kind: "newSession", targetId: target.id })}
        onNewDialogue={(backendId) => controller.navigate({ kind: "newSession", dialogueBackendId: backendId })}
        onRename={(session, name) => runAction(`rename:${session.id}`, () => controller.renameSession(session.id, name))}
        onPin={(session) => runAction(`pin:${session.id}`, () => controller.pinSession(session.id, !session.pinned))}
        onPinTarget={(target) => runAction(`project-pin:${target.id}`, () => controller.updateTarget(target.id, { pinned: !target.pinned }))}
        onRenameTarget={(target, name) => runAction(`project-rename:${target.id}`, () => controller.updateTarget(target.id, { name }))}
        onRemoveTarget={(target) => runAction(`project-archive:${target.id}`, () => controller.archiveTarget(target.id, true))}
        onSetTargetSessionsArchived={(target, sessions, archived) => runAction(`project-${archived ? "archive" : "unarchive"}-all:${target.id}`, async () => {
          for (const session of sessions) await controller.archiveSession(session.id, archived);
          if (archived) removeSessionsFromNavigation(sessions);
        })}
        onCopyTargetLink={copyTargetLink}
        onArchive={(session) => runAction(`archive:${session.id}`, async () => {
          const archive = !session.archived;
          await controller.archiveSession(session.id, archive);
          if (archive && sessionSplitPanes(sessionSplitLayout.root).some((pane) => pane.sessionId === session.id)) {
            closeSessionSplitPane(session.id);
          }
        })}
        onDelete={setDeleteSession}
        onBulkArchive={(sessions) => {
          const batch = sessions.filter((session) => !session.archived);
          if (batch.length === 0) return;
          runAction(`bulk-archive:${batch.map((session) => session.id).join(",")}`, async () => {
            for (const session of batch) await controller.archiveSession(session.id, true);
            removeSessionsFromNavigation(batch);
          });
        }}
        onBulkDelete={setBulkDeleteSessions}
        onCopyTaskLink={copyTaskLink}
        onExportPortableSession={setPortableExportSession}
        onSplitSession={(session, side) => {
          const anchor = focusedSplitSessionId ?? activeSession?.id;
          if (anchor !== undefined) addSessionToSplit(session.id, anchor, side);
        }}
        onOpenSessionWindow={openTaskWindow}
        movingSessionProjectIds={movingSessionProjectIds}
        onMoveSessionProject={moveTaskToProject}
        onSearchMessages={async (query, semanticMode, filters, signal) => (await controller.searchAllSessionMessages(query, { scope: { kind: "owner" }, filters, pageSize: 100, semanticMode, signal })).matches}
        onSearchRemoteMessages={(query, semanticMode, filters, signal) => controller.searchRemoteSessionMessages(query, { scope: { kind: "owner" }, filters, pageSize: 100, semanticMode, signal })}
        onMessageSearchSortChange={(sort) => { void controller.setMessageSearchSort(sort); }}
        onSidebarDisplayPreferencesChange={(patch) => { void controller.setSidebarDisplayPreferences(patch); }}
        onSidebarOwnerLayoutChange={(patch) => { void controller.setSidebarOwnerLayout(patch); }}
        onRunSchedule={(schedule) => runSidebarScheduleAction(() => controller.runSchedule(schedule.id))}
        onToggleSchedule={(schedule) => runSidebarScheduleAction(() => controller.setScheduleEnabled(schedule.id, !schedule.enabled))}
        onPreviewScheduleDeletion={(schedule) => prepareScheduleDeletion(controller, schedule, state.snapshot.sessions)}
        onDeleteSchedule={(schedule, disposition) => runSidebarScheduleAction(async () => {
          const result = await deleteScheduleWithGeneratedSessions(
            controller,
            schedule,
            disposition,
            state.snapshot.sessions
          );
          const completed = state.snapshot.sessions.filter((session) => result.completedSessionIds.includes(session.id));
          if (completed.length > 0) removeSessionsFromNavigation(completed);
          if (result.failures.length > 0) {
            setActionError(t(
              disposition === "archive" ? "scheduler.deletePartialArchive" : "scheduler.deletePartialDelete",
              { failed: result.failures.length, total: result.generatedSessionIds.length }
            ));
          }
        })}
        onOpenMessageMatch={(match: SessionMessageSearchMatchView) => {
          messageJumpGenerationRef.current += 1;
          setTimelineFocusRequest(undefined);
          setSearchTimelineWindow(undefined);
          controller.navigate({
            kind: "session",
            sessionId: match.sessionId,
            messageEventId: match.eventId,
            messageId: match.timelineItemId
          });
          closeNavigation();
        }}
        onClose={closeNavigation}
        onHide={() => setNavigationMode("hidden")}
        onCollapse={() => setNavigationMode("rail")}
        onExpand={() => setNavigationMode("expanded")}
        onResizePointerDown={beginNavigationResize}
        onResizePointerMove={moveNavigationResize}
        onResizePointerUp={(event) => finishNavigationResize(event)}
        onResizePointerCancel={(event) => finishNavigationResize(event, true)}
        onResizeKeyDown={handleNavigationResizeKey}
        onResetWidth={() => setWindowNavigationLayout({ mode: "expanded", width: NAVIGATION_DEFAULT_WIDTH })}
        onDisconnect={() => void controller.disconnect()}
      />}
      {shellNavigationOpen && <button className="panel-scrim panel-scrim--navigation" type="button" aria-label={t("a11y.closeNavigation")} onClick={() => setWindowNavigationOpen(false)} />}

      {formalFilesMode && state.route.kind === "files" ? <AppErrorBoundary
        scope="route"
        resetKey={routeBoundaryKey}
        resetAfterNavigation
        onBackToTasks={() => controller.navigate({ kind: "session" })}
        onOpenSettings={() => controller.navigate({ kind: "settings" })}
      >
        <Suspense fallback={<div id="main-content" className="app__main"><RouteLoading label={t("common.loading")} /></div>}>
          <WorkspaceFilesRoute
            controller={controller}
            route={state.route}
            session={activeSession!}
            target={activeTarget!}
            backend={activeBackend!}
            workspace={activeWorkspace!}
            sessions={state.snapshot.sessions}
            banners={shellOverlays}
            chatPane={renderActiveSessionPane(true)}
            t={t}
            onError={setActionError}
            onSelectionQuote={insertFileSelectionQuote}
            onImageToChat={activeImageAttachments ? insertFileAttachment : undefined}
            navigation={{
              open: navigationOpen,
              mode: navigationMode,
              width: navigationWidth,
              onCloseDrawer: closeNavigation,
              onHide: () => setNavigationMode("hidden"),
              onCollapse: () => setNavigationMode("rail"),
              onExpand: () => setNavigationMode("expanded"),
              onResizePointerDown: beginNavigationResize,
              onResizePointerMove: moveNavigationResize,
              onResizePointerUp: (event) => finishNavigationResize(event),
              onResizePointerCancel: (event) => finishNavigationResize(event, true),
              onResizeKeyDown: handleNavigationResizeKey,
              onResetWidth: () => setWindowNavigationLayout({ mode: "expanded", width: NAVIGATION_DEFAULT_WIDTH }),
              onDisconnect: () => void controller.disconnect()
            }}
          />
        </Suspense>
      </AppErrorBoundary> : <div id="main-content" className="app__main" tabIndex={-1}>
        {shellOverlays}
        <AppErrorBoundary
          scope="route"
          resetKey={routeBoundaryKey}
          resetAfterNavigation
          onBackToTasks={() => controller.navigate({ kind: "session" })}
          onOpenSettings={state.route.kind === "settings" ? undefined : () => controller.navigate({ kind: "settings" })}
        >
          <Suspense fallback={<RouteLoading label={t("common.loading")} />}>
          {state.route.kind === "newSession" ? <NewSessionPage
            controller={controller}
            snapshot={state.snapshot}
            initialTargetId={state.route.targetId}
            initialDialogueBackendId={state.route.dialogueBackendId}
            navigationOpen={navigationOpen}
            t={t}
            onOpenNavigation={() => setWindowNavigationOpen(true)}
            onClose={() => controller.navigate({ kind: "session" })}
            onSubmit={submitNewSession}
          /> : <>
          {state.route.kind === "session" && (activeSession === undefined ? (
            <EmptySessionPage navigationOpen={navigationOpen} t={t} onOpenNavigation={() => setWindowNavigationOpen(true)} onNewTask={() => controller.navigate({ kind: "newSession" })} />
          ) : <SessionSplitView
            layout={sessionSplitLayout}
            currentSessionId={activeSession.id}
            focusedSessionId={focusedSplitSessionId ?? activeSession.id}
            sessions={state.snapshot.sessions}
            t={t}
            renderPane={renderSessionSplitPane}
            onLayoutChange={commitSessionSplitLayout}
            onFocus={focusSplitSession}
            onPreviewFocus={setFocusedSplitSessionId}
            onClose={closeSessionSplitPane}
            onDropSession={addSessionToSplit}
          />)}
          {state.route.kind === "files" && <main className="empty-session-page"><EmptyState icon={<AlertTriangle />} title={t("workspace.filesLoadFailed")} body={t("workspace.noWorkspace")} action={<Button onClick={() => { const sessionId = activeSession?.id; controller.navigate(sessionId === undefined ? { kind: "session" } : { kind: "session", sessionId }); }}>{t("workspace.filesBack")}</Button>} /></main>}
          {state.route.kind === "schedules" && <SchedulesPage controller={controller} schedules={state.snapshot.schedules} sessions={state.snapshot.sessions} targets={state.snapshot.targets} models={state.snapshot.models} backends={state.snapshot.backends} extraDirectories={state.snapshot.extraDirectories} focusScheduleId={state.route.scheduleId} locale={state.preferences.locale} t={t} runAction={runAction} onOpenNavigation={() => setWindowNavigationOpen(true)} />}
          {state.route.kind === "projects" && <ProjectsPage controller={controller} snapshot={state.snapshot} focusProjectId={state.route.projectId} t={t} runAction={runAction} onOpenNavigation={() => setWindowNavigationOpen(true)} />}
          {state.route.kind === "tools" && <ToolsPage controller={controller} snapshot={state.snapshot} locale={state.preferences.locale} t={t} runAction={runAction} onOpenNavigation={() => setWindowNavigationOpen(true)} />}
          {state.route.kind === "settings" && <SettingsPage controller={controller} snapshot={state.snapshot} activeTargetId={settingsTargetIdRef.current} locale={state.preferences.locale} t={t} runAction={runAction} onImportPortableSession={portableImportTargets.length === 0 ? undefined : () => { void choosePortableSessionImport(); }} />}
          </>}
          </Suspense>
        </AppErrorBoundary>
      </div>}

      <Suspense fallback={null}>{activeSession !== undefined && state.route.kind === "session" && <Inspector controller={controller} snapshot={state.snapshot} session={activeSession} workspace={activeWorkspace} timeline={activeTimeline} open={inspectorOpen} subagentFocusRequest={inspectorSubagentFocusRequest?.sessionId === activeSession.id ? inspectorSubagentFocusRequest : undefined} turnReviewFocusRequest={inspectorTurnReviewFocusRequest?.sessionId === activeSession.id ? inspectorTurnReviewFocusRequest : undefined} browserFocusRequest={state.browserInspectorFocusRequest?.sessionId === activeSession.id ? state.browserInspectorFocusRequest : undefined} t={t} runAction={runAction} onClose={() => void controller.setInspectorOpen(false)} onDetachedChange={setInspectorDetached} onSelectionQuote={insertFileSelectionQuote} />}</Suspense>
      {inspectorAttached && <button className="panel-scrim panel-scrim--inspector" type="button" aria-label={t("a11y.closeInspector")} onClick={() => void controller.setInspectorOpen(false)} />}

      <RenameSessionDialog
        session={renameSession}
        t={t}
        onClose={() => setRenameSession(undefined)}
        onSuggest={renameSession !== undefined && state.snapshot.backends
          .find((backend) => backend.id === renameSession.backendId)
          ?.capabilities.get("session.ai_rename")?.supported === true
          ? (signal) => controller.suggestSessionTitle(renameSession.id, signal)
          : undefined}
        onRename={(name) => {
          const session = renameSession;
          setRenameSession(undefined);
          if (session !== undefined) runAction(`rename:${session.id}`, () => controller.renameSession(session.id, name));
        }}
      />
      <DeleteSessionDialog session={deleteSession} t={t} onClose={() => setDeleteSession(undefined)} onDelete={(deleteNative) => { const session = deleteSession; setDeleteSession(undefined); if (session !== undefined) runAction(`delete:${session.id}`, async () => {
        if (state.route.kind === "files" && activeSession?.id === session.id) {
          const allowed = await requestWorkspaceDocumentLeave({ reason: "switch-session", matches: (identity) => identity.sessionId === session.id });
          if (!allowed) return;
        }
        await controller.deleteSession(session.id, deleteNative);
        const splitContainsSession = sessionSplitPanes(sessionSplitLayout.root)
          .some((pane) => pane.sessionId === session.id);
        if (splitContainsSession) closeSessionSplitPane(session.id);
        else if (activeSession?.id === session.id) controller.navigate({ kind: "session" });
      }); }} />
      <BulkDeleteSessionDialog sessions={bulkDeleteSessions} t={t} onClose={() => setBulkDeleteSessions([])} onDelete={(deleteNative) => {
        const batch = bulkDeleteSessions;
        setBulkDeleteSessions([]);
        if (batch.length === 0) return;
        runAction(`bulk-delete:${batch.map((session) => session.id).join(",")}`, async () => {
          const removed = new Set(batch.map((session) => session.id));
          if (state.route.kind === "files" && activeSession !== undefined && removed.has(activeSession.id)) {
            const allowed = await requestWorkspaceDocumentLeave({ reason: "switch-session", matches: (identity) => removed.has(identity.sessionId) });
            if (!allowed) return;
          }
          for (const session of batch) await controller.deleteSession(session.id, deleteNative);
          removeSessionsFromNavigation(batch);
        });
      }} />
      <PortableSessionDialogHost
        controller={controller}
        snapshot={state.snapshot}
        locale={state.preferences.locale}
        t={t}
        exportSession={portableExportSession}
        importRequest={portableImportRequest}
        defaultTargetId={settingsTargetIdRef.current}
        worktreeSupportedTargetIds={portableWorktreeTargetIds}
        onCloseExport={() => setPortableExportSession(undefined)}
        onCloseImport={() => setPortableImportRequest(undefined)}
        onExported={() => setLayoutNotice(t("portable.exported"))}
        onOpenTask={(sessionId) => {
          setPortableImportRequest(undefined);
          controller.navigate({ kind: "session", sessionId });
        }}
      />
      {portableImportTargets.length > 0 && <PortableSessionDropTarget
        label={t("portable.importEntryBody")}
        onFile={openPortableSessionImportFile}
      />}
    </div>
  );
}

function SplitSessionPaneHost({ controller, sessionId, navigationOpen, t, runAction, onOpenNavigation, onRename, onPin, onArchive, onDelete, onMoveSessionProject, movingSessionProject, onCopyTaskLink, onExportPortableSession, onSplitSession, onOpenSessionWindow, onOpenTurnReview }: {
  readonly controller: AppController;
  readonly sessionId: string;
  readonly navigationOpen: boolean;
  readonly t: (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => string;
  readonly runAction: RunAction;
  readonly onOpenNavigation: () => void;
  readonly onRename: (session: SessionView) => void;
  readonly onPin: (session: SessionView) => void;
  readonly onArchive: (session: SessionView) => void;
  readonly onDelete: (session: SessionView) => void;
  readonly onMoveSessionProject: (session: SessionView, placement: SessionProjectNavigationPlacement) => void;
  readonly movingSessionProject: boolean;
  readonly onCopyTaskLink: (session: SessionView) => void;
  readonly onExportPortableSession: (session: SessionView) => void;
  readonly onSplitSession: (session: SessionView, side: "right" | "bottom") => void;
  readonly onOpenSessionWindow: (session: SessionView) => void;
  readonly onOpenTurnReview: (session: SessionView, changeSetId: string, selectedPath?: string) => void;
}): JSX.Element | null {
  const { snapshot, connectionState } = controller.state;
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const [history, setHistory] = useState<ActiveTimelineHistory>();
  const historyRevision = snapshot.timelineHistoryRevisionBySession.get(sessionId) ?? 0n;
  const requestPage = useCallback(async (beforeCursor: TimelineHistoryCursorView | undefined, reset: boolean): Promise<void> => {
    const generation = snapshot.generation;
    setHistory((current) => reset || current?.sessionId !== sessionId || current.generation !== generation
      ? { sessionId, generation, items: [], initialized: false, loading: true }
      : { ...current, loading: true });
    try {
      const page = await controllerRef.current.loadSessionTimelinePage(sessionId, beforeCursor, 240);
      setHistory((current) => {
        if (current?.sessionId !== sessionId || current.generation !== generation) return current;
        return {
          sessionId,
          generation,
          items: reset ? page.items : mergeTimelineWindows(current.items, page.items),
          ...(page.nextBeforeCursor === undefined ? {} : { nextBeforeCursor: page.nextBeforeCursor }),
          initialized: true,
          loading: false
        };
      });
    } catch (error) {
      setHistory((current) => current?.sessionId !== sessionId || current.generation !== generation
        ? current
        : { ...current, loading: false, error: messageOf(error, t("error.unexpected")) });
    }
  }, [sessionId, snapshot.generation, t]);
  useEffect(() => {
    if (session === undefined || connectionState !== "connected") return;
    void requestPage(undefined, true);
  }, [connectionState, historyRevision, requestPage, session?.id]);
  if (session === undefined) return null;
  const recent = snapshot.timelineBySession.get(sessionId) ?? EMPTY_TIMELINE;
  const currentHistory = history?.sessionId === sessionId && history.generation === snapshot.generation ? history : undefined;
  const timeline = currentHistory?.items === undefined ? recent : mergeTimelineWindows(recent, currentHistory.items);
  const target = snapshot.targets.find((candidate) => candidate.id === session.targetId);
  const backend = snapshot.backends.find((candidate) => candidate.id === session.backendId);
  const reviewer = reviewRunForReviewerSession(snapshot.reviewRuns, session.id);
  const workspaceId = session.worktree === undefined
    ? target?.workspaceId
    : session.worktree.state === "active" ? session.worktree.workspaceId : undefined;
  const workspace = workspaceId === undefined ? undefined : snapshot.workspaces.find((candidate) => candidate.id === workspaceId);
  const interactions = [...snapshot.interactions]
    .filter((interaction) => interaction.sessionId === sessionId)
    .sort((left, right) => interactionPriority(left.kind) - interactionPriority(right.kind) || left.createdAt - right.createdAt);
  const loadEarlier = async (): Promise<void> => {
    if (currentHistory?.loading === true) return;
    if (currentHistory?.initialized === true && currentHistory.nextBeforeCursor === undefined) return;
    await requestPage(currentHistory?.nextBeforeCursor, currentHistory?.initialized !== true);
  };
  return <SessionPane
    controller={controller}
    session={session}
    target={target}
    backend={backend}
    reviewReadOnly={reviewer !== undefined}
    composerAutoFocus={false}
    models={snapshot.models}
    timeline={timeline}
    timelineHasEarlier={currentHistory === undefined || !currentHistory.initialized || currentHistory.nextBeforeCursor !== undefined}
    timelineHistoryLoading={currentHistory?.loading ?? connectionState === "connected"}
    timelineHistoryError={currentHistory?.error}
    onLoadEarlierTimeline={loadEarlier}
    extensionWidgets={snapshot.extensionWidgetsBySession.get(sessionId) ?? []}
    extensionStatuses={snapshot.extensionStatusesBySession.get(sessionId) ?? []}
    queue={snapshot.queue}
    queueControl={snapshot.queueControls.find((control) => control.sessionId === sessionId)}
    workspace={workspace}
    extraDirectories={snapshot.extraDirectories}
    resources={snapshot.resources}
    commandRefreshSignal={snapshot.commands}
    interaction={interactions[0]}
    remainingInteractions={Math.max(0, interactions.length - 1)}
    navigationOpen={navigationOpen}
    inspectorOpen={false}
    inspectorAvailable={false}
    t={t}
    runAction={runAction}
    onOpenNavigation={onOpenNavigation}
    onOpenInspector={() => undefined}
    onRename={() => onRename(session)}
    onPin={() => onPin(session)}
    onArchive={() => onArchive(session)}
    onDelete={() => onDelete(session)}
    onMoveSessionProject={(placement) => onMoveSessionProject(session, placement)}
    movingSessionProject={movingSessionProject}
    onCopyTaskLink={() => onCopyTaskLink(session)}
    onExportPortableSession={() => onExportPortableSession(session)}
    onSplitSession={(side) => onSplitSession(session, side)}
    onOpenSessionWindow={() => onOpenSessionWindow(session)}
    onOpenTurnReview={reviewer === undefined ? (changeSetId, selectedPath) => onOpenTurnReview(session, changeSetId, selectedPath) : undefined}
  />;
}

function LoadingScreen({ label, body }: { readonly label: string; readonly body: string }): JSX.Element {
  return <main className="full-state" aria-busy="true"><div className="loading-avatar" aria-hidden="true" /><Spinner label={label} /><h1>{label}</h1><p>{body}</p></main>;
}

function RouteLoading({ label }: { readonly label: string }): JSX.Element {
  return <main className="route-loading" aria-busy="true"><div className="loading-avatar loading-avatar--route" aria-hidden="true" /><Spinner label={label} /><span>{label}</span></main>;
}

function ConnectingScreen({ controller, t }: { readonly controller: ReturnType<typeof useAppController>; readonly t: (key: Parameters<typeof translate>[1]) => string }): JSX.Element {
  return <main className="full-state" aria-busy="true"><div className="loading-avatar" aria-hidden="true" /><Spinner label={t("connection.connecting")} /><h1>{t("connection.connecting")}</h1><p>{controller.state.activeProfile?.name}<br /><span>{controller.state.activeProfile?.origin}</span></p><Button tone="ghost" onClick={() => void controller.disconnect()}>{t("common.cancel")}</Button></main>;
}

function UnavailableScreen({ controller, t, error }: { readonly controller: ReturnType<typeof useAppController>; readonly t: (key: Parameters<typeof translate>[1]) => string; readonly error?: string }): JSX.Element {
  const profile = controller.state.activeProfile;
  return <main className="full-state"><div className="full-state__error"><ServerCrash aria-hidden="true" /></div><h1>{t("connection.failed")}</h1><p>{error ?? t("error.snapshotUnavailable")}</p><div className="full-state__actions">{profile !== undefined && <Button tone="primary" onClick={() => void controller.connect(profile)}><RefreshCcw aria-hidden="true" />{t("connection.reconnect")}</Button>}<Button onClick={() => void controller.disconnect()}>{t("common.back")}</Button></div></main>;
}

function EmptySessionPage({ navigationOpen, t, onOpenNavigation, onNewTask }: { readonly navigationOpen: boolean; readonly t: (key: Parameters<typeof translate>[1]) => string; readonly onOpenNavigation: () => void; readonly onNewTask: () => void }): JSX.Element {
  return <main className="empty-session-page"><header>{!navigationOpen && <IconButton label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}</header><EmptyState icon={<Sparkles />} title={t("session.emptyTitle")} body={t("session.emptyBody")} action={<Button tone="primary" onClick={onNewTask}><CirclePlus aria-hidden="true" />{t("nav.newTask")}</Button>} /></main>;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function interactionPriority(kind: InteractionView["kind"]): number {
  if (kind === "plan") return 0;
  if (kind === "permission") return 1;
  if (kind === "question") return 2;
  return 3;
}

function shortcutBlocked(event: KeyboardEvent): boolean {
  return document.body.classList.contains("modal-open") || event.target instanceof Element && event.target.closest("[inert]") !== null;
}

function zoomShortcutBlockedTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (element === null) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  return element.closest("[contenteditable='true'], .ProseMirror, .cm-editor, .cm-content, .cm-scroller, [role='textbox']") !== null;
}

function useSessionSwitchShortcut(
  id: Extract<AppShortcutId, `switch-session-${number}`>,
  slot: number,
  controller: AppController,
  route: AppController["state"]["route"],
  navigationOpen: boolean,
  overrides: AppShortcutOverrides
): void {
  useAppShortcut(id, overrides, (event) => {
    if (shortcutBlocked(event) || !navigationOpen) return false;
    const visibleSessionButtons = [...document.querySelectorAll<HTMLElement>(".sidebar [data-session-id], .workspace-session-tabs-bar [data-session-id]")]
      .filter((element) => element.getClientRects().length > 0
        && element.closest("[aria-hidden='true'], [inert]") === null);
    const sessionId = visibleSessionButtons[slot]?.dataset.sessionId;
    if (sessionId === undefined) return false;
    controller.navigate(route.kind === "files"
      ? {
          kind: "files",
          sessionId,
          ...(route.file === undefined ? {} : { file: route.file }),
          ...(route.search === undefined ? {} : { search: route.search }),
          ...(route.line === undefined ? {} : { line: route.line })
        }
      : { kind: "session", sessionId });
    return true;
  });
}
