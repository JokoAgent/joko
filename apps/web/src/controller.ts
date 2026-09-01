import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createOrchestratorGateway,
  discoverOrchestratorNodesAt,
  probeOrchestratorOrigin,
  probeOrchestratorRuntimeActivityAt,
  type ExtensionNotificationKind,
  type ExtensionUiEffect,
  type GatewayConnectionState,
  type OrchestratorGateway
} from "./gateway.js";
import {
  DEFAULT_UI_PREFERENCES,
  LocalState,
  type AutomaticConnectionTarget,
  type ComposerSendShortcutPreference,
  type LinkOpenPreference,
  type MessageSearchSortPreference,
  type UiPreferences,
  personalizationPromptForOwner,
  withPersonalizationPrompt
} from "./local-state.js";
import { isLoopbackHostname, normalizeOrchestratorOrigin } from "./connection-origin.js";
import { persistentWebSecretEncryptionAvailable } from "./web-crypto.js";
import { normalizeNavigationWidth, type NavigationLayout } from "./navigation-layout.js";
import { parseWorkspaceFilesHash, workspaceFilesHash } from "./workspace-files-navigation.js";
import { requestWorkspaceDocumentLeave, workspaceRouteLeaveRequest } from "./workspace-document-lifecycle.js";
import type {
  AppSnapshot,
  BrowserView,
  ComposerDraft,
  ConnectionProfile,
  DiscoveredOrchestratorView,
  FederatedSessionMessageSearchMatchView,
  InteractionView,
  Locale,
  MachineCacheView,
  MachinePresenceView,
  OperationApi,
  PermissionMode,
  NativeSessionTreeView,
  NewSessionDraft,
  NewSessionLocalDraft,
  SessionMessageSearchCollectionOptions,
  Theme
} from "./model.js";
import { appendTextToComposerDocument, composerDocumentKeepingQuotes } from "./composer-quote-document.js";
import { emptySnapshot } from "./model.js";
import { visionBridgeToastStore } from "./vision-bridge-toast-store.js";
import {
  withAppShortcutOverride,
  type AppShortcutId,
  type AppShortcutOverrideValue
} from "./app-shortcuts.js";
import {
  applyAppearanceTypography,
  clampCodeSize,
  clampUiSize,
  clampWindowZoom,
  normalizeFontFamily
} from "./appearance-settings.js";
import {
  withSidebarDisplayPreferences,
  withSidebarOwnerLayout,
  type SidebarDisplayPreferences,
  type SidebarOwnerLayout
} from "./sidebar-layout.js";
import { layoutResetPersistsSessionSplit, resetClientLayout } from "./client-layout-reset.js";
import {
  machineCacheFromSnapshot,
  normalizeMachineSelection,
  selectedReachableRemoteProfileIds,
  selectedMachineProfileIds,
  type MachineSelection
} from "./machine-federation.js";

const LIGHT_APP_ICON_URL = new URL("./icon-light.svg", import.meta.url).href;
const DARK_APP_ICON_URL = new URL("./icon-dark.svg", import.meta.url).href;
const FAVICON_SIZE = 256;
let faviconRequest = 0;

export type AppRoute =
  | { readonly kind: "session"; readonly profileId?: string; readonly sessionId?: string; readonly messageId?: string; readonly messageEventId?: string }
  | { readonly kind: "files"; readonly sessionId: string; readonly file?: string; readonly search?: string; readonly line?: number }
  | { readonly kind: "newSession"; readonly targetId?: string; readonly dialogueBackendId?: string }
  | { readonly kind: "projects"; readonly projectId?: string }
  | { readonly kind: "schedules"; readonly scheduleId?: string }
  | { readonly kind: "tools" }
  | { readonly kind: "settings" };

export interface BrowserInspectorFocusRequest {
  readonly sessionId: string;
  readonly browserId: string;
  readonly pageId: string;
  readonly requestId: number;
}

export interface ControllerState {
  readonly ready: boolean;
  readonly connectionState: GatewayConnectionState;
  readonly profiles: readonly ConnectionProfile[];
  readonly machineCaches: readonly MachineCacheView[];
  readonly machinePresenceByProfile: Readonly<Record<string, MachinePresenceView>>;
  readonly activeProfile?: ConnectionProfile;
  readonly discoveredNodes: readonly DiscoveredOrchestratorView[];
  readonly discoveryState: "idle" | "discovering" | "ready";
  readonly discoveryError?: string;
  /** Present only when the trusted Desktop shell owns the local Orchestrator lifecycle. */
  readonly managedOrchestratorStatus: JokoDesktopManagedOrchestratorStatus | undefined;
  /** Whether an Auth Key can be protected across a full client restart. */
  readonly automaticConnectionAvailable: boolean;
  readonly snapshot: AppSnapshot;
  readonly route: AppRoute;
  /** Non-persistent navigation occurrence; lets the same deep link re-emit focus. */
  readonly navigationRevision?: number;
  /** One-shot focus intent for an in-task Browser page in the Inspector. */
  readonly browserInspectorFocusRequest?: BrowserInspectorFocusRequest;
  readonly preferences: UiPreferences;
  readonly statusMessage?: string;
  readonly error?: string;
  readonly editorTextUpdate?: { readonly eventId: string; readonly sessionId: string; readonly text: string };
  readonly extensionNotifications: readonly {
    readonly eventId: string;
    readonly sessionId: string;
    readonly text: string;
    readonly kind: ExtensionNotificationKind;
  }[];
}

export interface AppController extends OperationApi {
  readonly state: ControllerState;
  /** True only when the Desktop-managed local Orchestrator reports shutdown-blocking work. */
  probeRuntimeActivity(): Promise<boolean>;
  connect(profile: ConnectionProfile, options?: ConnectionSelectionOptions): Promise<void>;
  pair(origin: string, code: string, deviceName: string, options?: ConnectionSelectionOptions): Promise<void>;
  disconnect(): Promise<void>;
  forgetProfile(profileId: string): Promise<void>;
  logoutProfile(profileId: string): Promise<void>;
  refreshDiscoveredNodes(): Promise<void>;
  refreshMachines(): Promise<void>;
  setMachineSelection(selection: MachineSelection): Promise<void>;
  switchMachine(profileId: string): Promise<void>;
  openMachineSession(profileId: string, sessionId: string): Promise<void>;
  searchRemoteSessionMessages(query: string, options?: SessionMessageSearchCollectionOptions): Promise<readonly FederatedSessionMessageSearchMatchView[]>;
  retryManagedOrchestrator(): Promise<void>;
  /** Consume only the not-yet-started automatic attempt for this app open. */
  cancelAutomaticConnectionAttempt(): void;
  setAutomaticConnectionEnabled(enabled: boolean): Promise<void>;
  navigate(route: AppRoute, options?: { readonly replace?: boolean }): void;
  setLocale(locale: Locale): Promise<void>;
  setTheme(theme: Theme): Promise<void>;
  setUiFamily(family: string): Promise<void>;
  setCodeFamily(family: string): Promise<void>;
  setUiSize(size: number): Promise<void>;
  setCodeSize(size: number): Promise<void>;
  setWindowZoom(zoom: number): Promise<void>;
  setComposerSendShortcut(shortcut: ComposerSendShortcutPreference): Promise<void>;
  setMessageSearchSort(sort: MessageSearchSortPreference): Promise<void>;
  setMessageNavRailEnabled(enabled: boolean): Promise<void>;
  resetMessageNavRailEnabled(): Promise<void>;
  getPersonalizationPrompt(): string;
  setPersonalizationPrompt(value: string): Promise<void>;
  resetPersonalizationPrompt(): Promise<void>;
  setLinkOpenPreference(preference: LinkOpenPreference): Promise<void>;
  resetLinkOpenPreference(): Promise<void>;
  setStreamFadeEnabled(enabled: boolean): Promise<void>;
  resetStreamFadeEnabled(): Promise<void>;
  setSessionNotificationsEnabled(enabled: boolean): Promise<void>;
  setNewSessionWorktreeEnabled(enabled: boolean): Promise<void>;
  openHttpLink(url: string, options?: { readonly forceExternal?: boolean; readonly forceSidebar?: boolean; readonly sessionId?: string }): Promise<void>;
  setSidebarDisplayPreferences(patch: Partial<SidebarDisplayPreferences>): Promise<void>;
  setSidebarOwnerLayout(patch: Partial<SidebarOwnerLayout>): Promise<void>;
  /** Set a binding, null to disable it, or undefined to restore its default. */
  setAppShortcutOverride(id: AppShortcutId, value: AppShortcutOverrideValue | undefined): Promise<void>;
  resetAppShortcutOverrides(): Promise<void>;
  setInspectorOpen(open: boolean): Promise<void>;
  setNavigationOpen(open: boolean): Promise<void>;
  setNavigationLayout(layout: NavigationLayout): Promise<void>;
  synchronizeLayoutReset(): void;
  resetLayoutPreferences(): Promise<void>;
  dismissExtensionNotification(eventId: string): void;
  readDraft(sessionId: string): Promise<ComposerDraft | undefined>;
  saveDraft(sessionId: string, draft: ComposerDraft): Promise<void>;
  readNewSessionDraft(): Promise<NewSessionLocalDraft | undefined>;
  saveNewSessionDraft(draft: NewSessionLocalDraft): Promise<void>;
  clearNewSessionDraft(): Promise<void>;
}

export interface ConnectionSelectionOptions {
  readonly automatic?: boolean;
}

export function useAppController(): AppController {
  const [state, setState] = useState<ControllerState>({
    ready: false,
    connectionState: "disconnected",
    profiles: [],
    machineCaches: [],
    machinePresenceByProfile: {},
    discoveredNodes: [],
    discoveryState: "idle",
    managedOrchestratorStatus: undefined,
    automaticConnectionAvailable: false,
    snapshot: emptySnapshot(),
    route: routeFromLocation(),
    navigationRevision: 0,
    preferences: DEFAULT_UI_PREFERENCES,
    extensionNotifications: []
  });
  const localRef = useRef<LocalState | undefined>(undefined);
  const activeProfileRef = useRef<ConnectionProfile | undefined>(state.activeProfile);
  activeProfileRef.current = state.activeProfile;
  const profilesRef = useRef<readonly ConnectionProfile[]>(state.profiles);
  profilesRef.current = state.profiles;
  const snapshotRef = useRef<AppSnapshot>(state.snapshot);
  snapshotRef.current = state.snapshot;
  const connectionStateRef = useRef<GatewayConnectionState>(state.connectionState);
  connectionStateRef.current = state.connectionState;
  const machinePresenceByProfileRef = useRef(state.machinePresenceByProfile);
  machinePresenceByProfileRef.current = state.machinePresenceByProfile;
  const routeRef = useRef<AppRoute>(state.route);
  const navigationBypassHashRef = useRef<string | undefined>(undefined);
  const navigationRequestRef = useRef(0);
  const browserInspectorRequestRef = useRef(0);
  routeRef.current = state.route;
  const preferencesRef = useRef<UiPreferences>(DEFAULT_UI_PREFERENCES);
  preferencesRef.current = state.preferences;
  const gatewayRef = useRef<OrchestratorGateway | undefined>(undefined);
  const gatewayGenerationRef = useRef(0);
  const extensionUiEffectLedgerRef = useRef(new Map<string, true>());
  const latestExtensionEditorEffectRef = useRef(new Map<string, string>());
  const extensionTitleSessionRef = useRef<string | undefined>(undefined);
  const automaticPreferenceIntentRef = useRef(0);
  const discoveryGenerationRef = useRef(0);
  const discoveryAbortRef = useRef<AbortController | undefined>(undefined);
  const startupAutoConnectRef = useRef<ConnectionProfile | undefined>(undefined);
  const startupManagedLocalAutoPendingRef = useRef(false);
  const managedRetryRef = useRef(false);
  const machineRefreshGenerationRef = useRef(0);
  const machineRefreshPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const machineFailureBackoffRef = useRef(new Map<string, { readonly failures: number; readonly retryAt: number }>());
  const machineSwitchIntentRef = useRef(0);
  const remoteMachineGatewayEpochRef = useRef(0);
  const remoteMachineGatewaysRef = useRef(new Map<string, {
    readonly epoch: number;
    readonly profileKey: string;
    gateway?: OrchestratorGateway;
    connected: boolean;
    failures: number;
    retryTimer?: number;
  }>());

  useEffect(() => {
    const routeSessionId = extensionUiRouteSessionId(state.route);
    if (extensionTitleSessionRef.current === undefined || extensionTitleSessionRef.current === routeSessionId) return;
    extensionTitleSessionRef.current = undefined;
    document.title = "Joko";
  }, [state.route]);

  useEffect(() => {
    let cancelled = false;
    void LocalState.open().then(async (local) => {
      const [persistedProfiles, machineCaches, preferences, managedStatus, automaticConnectionAvailable] = await Promise.all([
        local.listProfiles(),
        local.listMachineCaches(),
        local.readPreferences(),
        readDesktopManagedOrchestratorStatus(),
        automaticConnectionPersistenceAvailable()
      ]);
      if (cancelled) return;
      let profiles = persistedProfiles;
      let effectivePreferences = preferences ?? DEFAULT_UI_PREFERENCES;
      if (effectivePreferences.automaticConnectionTarget !== undefined && !automaticConnectionAvailable && window.jokoDesktop === undefined) {
        effectivePreferences = { ...effectivePreferences, automaticConnectionTarget: undefined };
        await local.savePreferences(effectivePreferences);
        if (cancelled) return;
      }
      let managedProfile: ConnectionProfile | undefined;
      let managedBootstrapError: string | undefined;
      let effectiveManagedStatus = managedStatus;
      const managedConnection = effectiveManagedStatus?.state === "ready" ? effectiveManagedStatus.connection : undefined;
      if (managedConnection !== undefined) {
        try {
          managedProfile = managedConnectionProfile(managedConnection, persistedProfiles);
          const staleManagedProfiles = persistedProfiles.filter((profile) => profile.managedLocal === true && profile.id !== managedProfile!.id);
          await Promise.all(staleManagedProfiles.map((profile) => local.deleteProfile(profile.id)));
          if (cancelled) return;
          profiles = [
            ...persistedProfiles.filter((profile) => profile.managedLocal !== true && profile.id !== managedProfile!.id),
            managedProfile
          ];
        } catch (error) {
          managedProfile = undefined;
          managedBootstrapError = messageOf(error);
          effectiveManagedStatus = managedRecoveryStatus("identityConflict");
        }
      }
      const routedProfileId = routeRef.current.kind === "session" ? routeRef.current.profileId : undefined;
      const routedProfile = routedProfileId === undefined ? undefined : profiles.find((profile) => profile.id === routedProfileId);
      const automaticProfile = routedProfile ?? (automaticConnectionAvailable
        ? automaticConnectionProfile(effectivePreferences.automaticConnectionTarget, profiles, effectiveManagedStatus)
        : undefined);
      startupAutoConnectRef.current = automaticProfile;
      startupManagedLocalAutoPendingRef.current = automaticConnectionAvailable
        && effectivePreferences.automaticConnectionTarget?.kind === "managedLocal"
        && automaticProfile === undefined
        && effectiveManagedStatus?.state === "starting";
      localRef.current = local;
      preferencesRef.current = effectivePreferences;
      setState((current) => ({
        ...current,
        ready: true,
        profiles,
        machineCaches: machineCaches.filter((cache) => profiles.some((profile) => profile.id === cache.profileId)),
        machinePresenceByProfile: Object.fromEntries(profiles.map((profile) => [profile.id, "checking"] as const)),
        ...(effectiveManagedStatus === undefined ? {} : { managedOrchestratorStatus: effectiveManagedStatus }),
        automaticConnectionAvailable,
        preferences: effectivePreferences,
        ...(managedBootstrapError === undefined ? {} : { error: managedBootstrapError }),
        ...(automaticProfile === undefined ? {} : { activeProfile: automaticProfile, connectionState: "connecting" as const })
      }));
    }).catch((error: unknown) => {
      if (!cancelled) setState((current) => ({ ...current, ready: true, error: messageOf(error) }));
    });
    const commitRoute = (route: AppRoute): void => {
      routeRef.current = route;
      setState((current) => ({
        ...current,
        route,
        navigationRevision: (current.navigationRevision ?? 0) + 1
      }));
    };
    const onHashChange = (): void => {
      const requestedHash = window.location.hash;
      const next = routeFromLocation();
      if (navigationBypassHashRef.current === requestedHash) {
        navigationBypassHashRef.current = undefined;
        commitRoute(next);
        return;
      }
      const leave = workspaceRouteLeaveRequest(routeRef.current, next);
      if (leave === undefined) {
        commitRoute(next);
        return;
      }
      const requestId = ++navigationRequestRef.current;
      const currentHash = appRouteHash(routeRef.current);
      window.history.replaceState(window.history.state, "", currentHash);
      void requestWorkspaceDocumentLeave(leave).then((accepted) => {
        if (!accepted || navigationRequestRef.current !== requestId) return;
        navigationBypassHashRef.current = requestedHash;
        window.location.hash = requestedHash;
      });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      cancelled = true;
      gatewayGenerationRef.current += 1;
      machineRefreshGenerationRef.current += 1;
      discoveryGenerationRef.current += 1;
      discoveryAbortRef.current?.abort();
      window.removeEventListener("hashchange", onHashChange);
      gatewayRef.current?.disconnect();
      for (const binding of remoteMachineGatewaysRef.current.values()) {
        if (binding.retryTimer !== undefined) window.clearTimeout(binding.retryTimer);
        binding.gateway?.disconnect();
      }
      remoteMachineGatewaysRef.current.clear();
    };
  }, []);

  useEffect(() => {
    applyTheme(state.preferences.theme);
    if (state.preferences.theme !== "system") return;
    const colorScheme = matchMedia("(prefers-color-scheme: dark)");
    const syncSystemThemeColor = (): void => applyTheme("system");
    colorScheme.addEventListener("change", syncSystemThemeColor);
    return () => colorScheme.removeEventListener("change", syncSystemThemeColor);
  }, [state.preferences.theme]);

  useEffect(() => {
    document.documentElement.lang = state.preferences.locale;
  }, [state.preferences.locale]);

  useEffect(() => {
    applyAppearanceTypography(state.preferences, [document.documentElement, document.body]);
  }, [state.preferences.codeFamily, state.preferences.codeSize, state.preferences.uiFamily, state.preferences.uiSize]);

  useEffect(() => {
    const windowZoom = clampWindowZoom(state.preferences.windowZoom);
    const nativeZoom = window.jokoDesktop?.window.setZoomFactor;
    if (nativeZoom !== undefined) {
      document.documentElement.style.removeProperty("zoom");
      void nativeZoom(windowZoom).catch(() => undefined);
      return;
    }
    document.documentElement.style.setProperty("zoom", String(windowZoom));
  }, [state.preferences.windowZoom]);

  const updatePreferences = useCallback(async (patch: Partial<UiPreferences>): Promise<void> => {
    const previous = preferencesRef.current;
    const next = { ...previous, ...patch };
    preferencesRef.current = next;
    setState((current) => ({ ...current, preferences: next }));
    try {
      await requireLocal(localRef.current).savePreferences(next);
    } catch (error) {
      // Do not roll a newer successful change back when concurrent preference
      // writes settle out of order. The latest failed write restores both the
      // ref used by actions and the state rendered by settings.
      if (preferencesRef.current === next) {
        preferencesRef.current = previous;
        setState((current) => current.preferences === next ? { ...current, preferences: previous } : current);
      }
      throw error;
    }
  }, []);

  const setMachineSelection = useCallback(async (selection: MachineSelection): Promise<void> => {
    await updatePreferences({ machineSelection: normalizeMachineSelection(selection) });
  }, [updatePreferences]);

  const commitAutomaticConnectionChoice = useCallback(async (
    profile: ConnectionProfile,
    automatic: boolean | undefined,
    gatewayGeneration: number,
    preferenceIntent: number | undefined
  ): Promise<void> => {
    if (automatic === undefined || preferenceIntent === undefined) return;
    const stillCurrent = (): boolean => automaticConnectionCommitCurrent({
      expectedGatewayGeneration: gatewayGeneration,
      currentGatewayGeneration: gatewayGenerationRef.current,
      expectedPreferenceIntent: preferenceIntent,
      currentPreferenceIntent: automaticPreferenceIntentRef.current,
      expectedProfileId: profile.id,
      activeProfileId: activeProfileRef.current?.id,
      connectionState: connectionStateRef.current
    });
    if (!stillCurrent()) return;
    if (automatic && !await automaticConnectionPersistenceAvailable()) {
      if (stillCurrent()) setState((current) => ({
        ...current,
        automaticConnectionAvailable: false,
        error: "Automatic entry requires encrypted persistent credential storage."
      }));
      return;
    }
    if (!stillCurrent()) return;
    try {
      await updatePreferences({
        automaticConnectionTarget: automatic ? automaticConnectionTargetForProfile(profile) : undefined
      });
    } catch (error) {
      setState((current) => ({ ...current, error: messageOf(error) }));
    }
  }, [updatePreferences]);

  const beginGatewayTransition = useCallback((): number => {
    const generation = ++gatewayGenerationRef.current;
    const previous = gatewayRef.current;
    gatewayRef.current = undefined;
    previous?.disconnect();
    latestExtensionEditorEffectRef.current.clear();
    extensionTitleSessionRef.current = undefined;
    document.title = "Joko";
    setState(clearTransientExtensionUiState);
    return generation;
  }, []);

  const bindGateway = useCallback((profile: ConnectionProfile, authKey: string, generation: number): OrchestratorGateway => {
    const gateway = createOrchestratorGateway(profile, authKey, {
      onState: (connectionState, statusMessage) => {
        if (gatewayGenerationRef.current !== generation) return;
        connectionStateRef.current = connectionState;
        setState((current) => ({
          ...current,
          connectionState,
          ...(connectionState === "connected" ? { statusMessage: undefined, error: undefined } : statusMessage === undefined ? {} : { statusMessage })
        }));
      },
      onSnapshot: (snapshot) => {
        if (gatewayGenerationRef.current !== generation) return;
        connectionStateRef.current = "connected";
        snapshotRef.current = snapshot;
        const cache = machineCacheFromSnapshot(profile, snapshot);
        setState((current) => ({
          ...current,
          snapshot,
          connectionState: "connected",
          statusMessage: undefined,
          error: undefined,
          machineCaches: upsertMachineCache(current.machineCaches, cache),
          machinePresenceByProfile: { ...current.machinePresenceByProfile, [profile.id]: "current" }
        }));
        void requireLocal(localRef.current).saveMachineCache(cache).catch(() => undefined);
      },
      onError: (error) => {
        if (gatewayGenerationRef.current !== generation) return;
        setState((current) => ({
          ...current,
          error: error.message,
          connectionState: error.offline ? "offline" : current.connectionState,
          ...(error.offline ? { machinePresenceByProfile: { ...current.machinePresenceByProfile, [profile.id]: "offline" as const } } : {})
        }));
      },
      onAuthenticationInvalidated: async (error) => {
        if (gatewayGenerationRef.current !== generation) return;
        const managedLocal = profile.managedLocal === true;
        // Desktop owns managed-local bearer diagnosis and retirement. Keep it
        // available so the main process can prove an explicit server logout;
        // generic saved connections remain renderer-owned and are forgotten.
        if (shouldDeleteInvalidatedConnectionCredential(profile)) {
          await requireLocal(localRef.current).deleteAuthKey(profile.id);
          if (gatewayGenerationRef.current !== generation) return;
        }
        if (automaticConnectionTargetMatchesProfile(preferencesRef.current.automaticConnectionTarget, profile.id, [profile])) {
          automaticPreferenceIntentRef.current += 1;
          await updatePreferences({ automaticConnectionTarget: undefined }).catch(() => undefined);
          if (gatewayGenerationRef.current !== generation) return;
        }
        gatewayGenerationRef.current += 1;
        gatewayRef.current = undefined;
        activeProfileRef.current = managedLocal ? profile : undefined;
        connectionStateRef.current = "disconnected";
        setState((current) => ({
          ...current,
          ...(managedLocal
            ? {
              activeProfile: profile,
              managedOrchestratorStatus: managedRecoveryStatus("credentialRejected")
            }
            : { activeProfile: undefined }),
          connectionState: "disconnected",
          snapshot: emptySnapshot(),
          statusMessage: undefined,
          error: error.message
        }));
      },
      onExtensionUiEffect: (effect) => {
        if (gatewayGenerationRef.current !== generation) return;
        const effectScope = `${profile.id}\u0000${effect.eventId}`;
        if (!rememberExtensionUiEffect(extensionUiEffectLedgerRef.current, effectScope)) return;
        const editorScope = `${profile.id}\u0000${effect.sessionId}`;
        if (effect.kind === "editorText") latestExtensionEditorEffectRef.current.set(editorScope, effect.eventId);
        const activeSessionId = extensionUiRouteSessionId(routeRef.current);
        if (effect.kind === "title" && activeSessionId === effect.sessionId) {
          extensionTitleSessionRef.current = effect.sessionId;
        }
        applyExtensionUiEffect(effect, localRef.current, setState, {
          activeSessionId,
          isCurrent: () => gatewayGenerationRef.current === generation,
          isLatestEditorEffect: () => latestExtensionEditorEffectRef.current.get(editorScope) === effect.eventId
        });
      },
      onVisionBridgeUiEffect: (effect) => {
        if (gatewayGenerationRef.current !== generation) return;
        visionBridgeToastStore.apply(effect);
      }
    });
    gatewayRef.current = gateway;
    return gateway;
  }, [updatePreferences]);

  const connect = useCallback(async (profile: ConnectionProfile, options?: ConnectionSelectionOptions): Promise<void> => {
    startupManagedLocalAutoPendingRef.current = false;
    const automaticPreferenceIntent = options?.automatic === undefined ? undefined : ++automaticPreferenceIntentRef.current;
    const generation = beginGatewayTransition();
    let safeProfile = profile;
    let managedRecoveryReason: Extract<JokoDesktopManagedOrchestratorStatus, { readonly state: "recoveryRequired" }>["reason"] | undefined;
    activeProfileRef.current = safeProfile;
    connectionStateRef.current = "connecting";
    setState((current) => ({ ...current, activeProfile: safeProfile, connectionState: "connecting", error: undefined }));
    try {
      try {
        const normalizedOrigin = normalizeOrchestratorOrigin(profile.origin);
        safeProfile = normalizedOrigin === profile.origin ? profile : { ...profile, origin: normalizedOrigin };
      } catch (error) {
        if (profile.managedLocal === true) managedRecoveryReason = "identityConflict";
        throw error;
      }
      activeProfileRef.current = safeProfile;
      setState((current) => ({ ...current, activeProfile: safeProfile }));
      // Validate the transport boundary before decrypting a persisted bearer
      // credential. A tampered profile must never redirect an Auth Key to
      // public plain HTTP.
      const identity = await probeOrchestratorOrigin(safeProfile.origin);
      if (gatewayGenerationRef.current !== generation) return;
      if (safeProfile.serverId !== identity.serverId) {
        if (safeProfile.managedLocal === true) managedRecoveryReason = "identityConflict";
        throw new Error("This address now belongs to a different Joko node. Pair it again before sending a saved credential.");
      }
      const verifiedProfile: ConnectionProfile = {
        ...safeProfile,
        serverId: identity.serverId
      };
      const authKey = await requireLocal(localRef.current).readAuthKey(profile);
      if (gatewayGenerationRef.current !== generation) return;
      if (authKey === undefined) {
        if (safeProfile.managedLocal === true) managedRecoveryReason = "credentialUnavailable";
        throw new Error("The saved connection secret is unavailable. Pair this device again.");
      }
      const bound = bindGateway(verifiedProfile, authKey, generation);
      await bound.connect();
      if (gatewayGenerationRef.current !== generation) bound.disconnect();
      else {
        const connectedProfile = { ...verifiedProfile, lastConnectedAt: Date.now() };
        await requireLocal(localRef.current).saveProfile(connectedProfile, authKey);
        if (gatewayGenerationRef.current !== generation) {
          bound.disconnect();
          return;
        }
        activeProfileRef.current = connectedProfile;
        setState((current) => ({
          ...current,
          activeProfile: connectedProfile,
          profiles: [...current.profiles.filter((candidate) => candidate.id !== connectedProfile.id), connectedProfile]
        }));
        await commitAutomaticConnectionChoice(connectedProfile, options?.automatic, generation, automaticPreferenceIntent);
      }
    } catch (error) {
      if (gatewayGenerationRef.current === generation) {
        gatewayGenerationRef.current += 1;
        const bound = gatewayRef.current;
        gatewayRef.current = undefined;
        bound?.disconnect();
        setState((current) => safeProfile.managedLocal === true ? {
          ...current,
          activeProfile: undefined,
          connectionState: "disconnected",
          managedOrchestratorStatus: managedRecoveryReason === undefined
            ? { state: "retryableError", reason: "serviceUnavailable" }
            : managedRecoveryStatus(managedRecoveryReason),
          snapshot: emptySnapshot(),
          statusMessage: undefined,
          error: messageOf(error)
        } : {
          ...current,
          activeProfile: undefined,
          connectionState: "disconnected",
          snapshot: emptySnapshot(),
          statusMessage: undefined,
          error: messageOf(error)
        });
        activeProfileRef.current = undefined;
        connectionStateRef.current = "disconnected";
      }
      throw error;
    }
  }, [beginGatewayTransition, bindGateway, commitAutomaticConnectionChoice]);

  useEffect(() => {
    if (!state.ready) return;
    const automaticProfile = startupAutoConnectRef.current;
    if (automaticProfile === undefined) return;
    startupAutoConnectRef.current = undefined;
    void connect(automaticProfile).catch(() => undefined);
  }, [connect, state.ready]);

  const adoptManagedOrchestratorStatus = useCallback(async (status: JokoDesktopManagedOrchestratorStatus): Promise<void> => {
    if (status.state !== "ready") {
      if (status.state !== "starting") startupManagedLocalAutoPendingRef.current = false;
      const releaseManagedSelection = activeProfileRef.current?.managedLocal === true;
      if (releaseManagedSelection) {
        gatewayGenerationRef.current += 1;
        gatewayRef.current?.disconnect();
        gatewayRef.current = undefined;
        activeProfileRef.current = undefined;
        connectionStateRef.current = "disconnected";
      }
      setState((current) => ({
        ...current,
        managedOrchestratorStatus: status,
        ...(releaseManagedSelection || current.activeProfile?.managedLocal === true
          ? {
            activeProfile: undefined,
            connectionState: "disconnected" as const,
            snapshot: emptySnapshot(),
            statusMessage: undefined
          }
          : {})
      }));
      return;
    }
    const local = requireLocal(localRef.current);
    const reconciled = await reconcileManagedConnection(local, status.connection);
    const startupAutomaticPending = startupManagedLocalAutoPendingRef.current;
    startupManagedLocalAutoPendingRef.current = false;
    const selectedProfile = activeProfileRef.current;
    const shouldConnect = pendingManagedAutomaticConnectionEligible(
      startupAutomaticPending,
      connectionStateRef.current,
      selectedProfile
    );
    const releaseFailedLocalSelection = !shouldConnect && selectedProfile?.managedLocal === true;
    if (releaseFailedLocalSelection) {
      activeProfileRef.current = undefined;
      connectionStateRef.current = "disconnected";
    }
    setState((current) => ({
      ...current,
      managedOrchestratorStatus: status,
      profiles: profilesWithManagedConnection(current.profiles, reconciled.profile),
      ...(releaseFailedLocalSelection ? { activeProfile: undefined, connectionState: "disconnected" as const } : {})
    }));
    if (shouldConnect) await connect(reconciled.profile);
  }, [connect]);

  useEffect(() => {
    if (state.managedOrchestratorStatus?.state !== "starting") return;
    if (managedRetryRef.current) return;
    const api = window.jokoDesktop?.managedOrchestrator;
    if (api === undefined) return;
    let cancelled = false;
    let polling = false;
    const timer = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void api.getStatus().then((status) => {
        if (cancelled || status.state === "starting") return;
        window.clearInterval(timer);
        void adoptManagedOrchestratorStatus(status).catch((error: unknown) => {
          if (cancelled) return;
          startupManagedLocalAutoPendingRef.current = false;
          setState((current) => ({
            ...current,
            managedOrchestratorStatus: managedRecoveryStatus("identityConflict"),
            error: messageOf(error)
          }));
        });
      }).catch(() => {
        if (!cancelled) {
          window.clearInterval(timer);
          startupManagedLocalAutoPendingRef.current = false;
          setState((current) => ({
            ...current,
            managedOrchestratorStatus: { state: "retryableError", reason: "startFailed" }
          }));
        }
      }).finally(() => { polling = false; });
    }, 350);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [adoptManagedOrchestratorStatus, state.managedOrchestratorStatus?.state]);

  const retryManagedOrchestrator = useCallback(async (): Promise<void> => {
    const api = window.jokoDesktop?.managedOrchestrator;
    if (api === undefined) throw new Error("The Desktop-managed Joko service is unavailable.");
    startupManagedLocalAutoPendingRef.current = false;
    managedRetryRef.current = true;
    if (activeProfileRef.current?.managedLocal === true) {
      gatewayGenerationRef.current += 1;
      gatewayRef.current?.disconnect();
      gatewayRef.current = undefined;
      activeProfileRef.current = undefined;
      connectionStateRef.current = "disconnected";
    }
    setState((current) => ({
      ...current,
      managedOrchestratorStatus: { state: "starting" },
      ...(current.activeProfile?.managedLocal === true
        ? { activeProfile: undefined, connectionState: "disconnected" as const, snapshot: emptySnapshot(), statusMessage: undefined }
        : {}),
      error: undefined
    }));
    try {
      await adoptManagedOrchestratorStatus(await api.retry());
    } catch (error) {
      setState((current) => ({
        ...current,
        managedOrchestratorStatus: { state: "retryableError", reason: "startFailed" },
        ...(current.activeProfile?.managedLocal === true
          ? { activeProfile: undefined, connectionState: "disconnected" as const, snapshot: emptySnapshot(), statusMessage: undefined }
          : {}),
        error: messageOf(error)
      }));
    } finally {
      managedRetryRef.current = false;
    }
  }, [adoptManagedOrchestratorStatus]);

  const pair = useCallback(async (origin: string, code: string, deviceName: string, options?: ConnectionSelectionOptions): Promise<void> => {
    startupManagedLocalAutoPendingRef.current = false;
    const automaticPreferenceIntent = options?.automatic === undefined ? undefined : ++automaticPreferenceIntentRef.current;
    const generation = beginGatewayTransition();
    activeProfileRef.current = undefined;
    connectionStateRef.current = "connecting";
    setState((current) => ({ ...current, activeProfile: undefined, connectionState: "connecting", error: undefined }));
    try {
      const normalizedOrigin = normalizeOrchestratorOrigin(origin);
      const local = requireLocal(localRef.current);
      // Probe anonymously before decrypting any reusable credential. Reuse is
      // allowed only for the exact persisted node identity at this origin.
      const identity = await probeOrchestratorOrigin(normalizedOrigin);
      if (gatewayGenerationRef.current !== generation) return;
      const reusableProfiles = trustedReusablePairingProfiles(state.profiles, normalizedOrigin, identity.serverId);
      let reusableProfile: ConnectionProfile | undefined;
      let reusableAuthKey: string | undefined;
      for (const profile of reusableProfiles) {
        const candidate = await local.readAuthKey(profile);
        if (candidate !== undefined && candidate.length > 0) {
          reusableProfile = profile;
          reusableAuthKey = candidate;
          break;
        }
      }
      if (gatewayGenerationRef.current !== generation) return;
      const result = await createOrchestratorGateway(reusableProfile, reusableAuthKey, {}).pair(normalizedOrigin, code, deviceName);
      if (gatewayGenerationRef.current !== generation) return;
      await local.saveProfile(result.profile, result.authKey);
      if (gatewayGenerationRef.current !== generation) return;
      const adoption = await tryAdoptRecoveredManagedConnection(result.profile);
      if (gatewayGenerationRef.current !== generation) return;
      const managedAdoption = managedOrchestratorStatusAfterExplicitPairing(adoption, result.profile);
      let connectedProfile = result.profile;
      let connectedAuthKey = result.authKey;
      let profiles: readonly ConnectionProfile[] | undefined;
      if (managedAdoption !== undefined) {
        await local.deleteProfile(result.profile.id);
        const reconciled = await reconcileManagedConnection(local, managedAdoption.connection);
        connectedProfile = reconciled.profile;
        profiles = reconciled.profiles;
        const managedAuthKey = await local.readAuthKey(connectedProfile);
        if (managedAuthKey === undefined || managedAuthKey.length === 0) {
          throw new Error("Desktop did not persist the rotated local Joko credential.");
        }
        connectedAuthKey = managedAuthKey;
        await local.saveProfile(connectedProfile, connectedAuthKey);
      }
      if (gatewayGenerationRef.current !== generation) return;
      setState((current) => ({
        ...current,
        profiles: profiles ?? [...current.profiles.filter((profile) => profile.id !== connectedProfile.id), connectedProfile],
        activeProfile: connectedProfile,
        // The bundled service lifecycle remains independent when this pairing
        // is an ordinary remote connection. Exact local recovery adoption may
        // replace it with the rotated managed authority.
        managedOrchestratorStatus: managedAdoption ?? current.managedOrchestratorStatus,
        connectionState: "connecting",
        error: undefined
      }));
      const bound = bindGateway(connectedProfile, connectedAuthKey, generation);
      await bound.connect();
      if (gatewayGenerationRef.current !== generation) bound.disconnect();
      else {
        const recentProfile = { ...connectedProfile, lastConnectedAt: Date.now() };
        await local.saveProfile(recentProfile, connectedAuthKey);
        if (gatewayGenerationRef.current !== generation) {
          bound.disconnect();
          return;
        }
        activeProfileRef.current = recentProfile;
        setState((current) => ({
          ...current,
          activeProfile: recentProfile,
          profiles: [...current.profiles.filter((profile) => profile.id !== recentProfile.id), recentProfile]
        }));
        await commitAutomaticConnectionChoice(recentProfile, options?.automatic, generation, automaticPreferenceIntent);
      }
    } catch (error) {
      if (gatewayGenerationRef.current === generation) {
        gatewayGenerationRef.current += 1;
        const bound = gatewayRef.current;
        gatewayRef.current = undefined;
        bound?.disconnect();
        setState((current) => ({
          ...current,
          activeProfile: undefined,
          connectionState: "disconnected",
          snapshot: emptySnapshot(),
          statusMessage: undefined,
          error: messageOf(error)
        }));
        activeProfileRef.current = undefined;
        connectionStateRef.current = "disconnected";
      }
      throw error;
    }
  }, [beginGatewayTransition, bindGateway, commitAutomaticConnectionChoice, state.profiles]);

  const disconnect = useCallback(async (): Promise<void> => {
    startupManagedLocalAutoPendingRef.current = false;
    automaticPreferenceIntentRef.current += 1;
    gatewayGenerationRef.current += 1;
    const previous = gatewayRef.current;
    gatewayRef.current = undefined;
    previous?.disconnect();
    activeProfileRef.current = undefined;
    connectionStateRef.current = "disconnected";
    setState((current) => ({
      ...current,
      activeProfile: undefined,
      connectionState: "disconnected",
      snapshot: emptySnapshot(),
      statusMessage: undefined
    }));
  }, []);

  const removeProfile = useCallback(async (profileId: string): Promise<void> => {
    if (state.activeProfile?.id === profileId) await disconnect();
    if (automaticConnectionTargetMatchesProfile(preferencesRef.current.automaticConnectionTarget, profileId, state.profiles)) {
      automaticPreferenceIntentRef.current += 1;
      await updatePreferences({ automaticConnectionTarget: undefined });
    }
    const machineSelection = preferencesRef.current.machineSelection;
    if (machineSelection !== "all" && machineSelection.includes(profileId)) {
      await updatePreferences({ machineSelection: machineSelection.filter((candidate) => candidate !== profileId) });
    }
    await requireLocal(localRef.current).deleteProfile(profileId);
    setState((current) => {
      const machinePresenceByProfile = { ...current.machinePresenceByProfile };
      delete machinePresenceByProfile[profileId];
      return {
        ...current,
        profiles: current.profiles.filter((profile) => profile.id !== profileId),
        machineCaches: current.machineCaches.filter((cache) => cache.profileId !== profileId),
        machinePresenceByProfile
      };
    });
  }, [disconnect, state.activeProfile?.id, state.profiles, updatePreferences]);

  const forgetProfile = useCallback(async (profileId: string): Promise<void> => {
    const profile = state.profiles.find((candidate) => candidate.id === profileId);
    if (profile?.managedLocal === true) {
      throw new Error("Use Log out to remove the Desktop-managed local connection.");
    }
    await removeProfile(profileId);
  }, [removeProfile, state.profiles]);

  const logoutProfile = useCallback(async (profileId: string): Promise<void> => {
    const profile = state.profiles.find((candidate) => candidate.id === profileId);
    if (profile === undefined) throw new Error("The selected connection profile no longer exists.");
    await logoutConnectionProfile({
      profile,
      logoutConnection: (connectionId) => {
        const current = gatewayRef.current;
        if (current === undefined) throw new Error("Connect to Joko before performing this action.");
        return current.logoutConnection(connectionId);
      },
      completeManagedLogout: async () => {
        const api = window.jokoDesktop?.managedOrchestrator;
        if (api === undefined) throw new Error("The Desktop-managed Joko service is unavailable.");
        const status = await api.completeLogout();
        if (status.state !== "disabled") throw new Error("Desktop did not complete local Joko logout.");
        setState((current) => ({ ...current, managedOrchestratorStatus: status }));
      },
      deleteProfile: () => removeProfile(profileId)
    });
  }, [removeProfile, state.profiles]);

  const navigate = useCallback((route: AppRoute, options?: { readonly replace?: boolean }): void => {
    const effectiveRoute: AppRoute = route.kind === "session" && route.profileId === undefined && activeProfileRef.current !== undefined
      ? { ...route, profileId: activeProfileRef.current.id }
      : route;
    const hash = appRouteHash(effectiveRoute);
    const commit = (): void => {
      routeRef.current = effectiveRoute;
      if (window.location.hash === hash) setState((current) => ({
        ...current,
        route: effectiveRoute,
        navigationRevision: (current.navigationRevision ?? 0) + 1
      }));
      else if (options?.replace === true) {
        navigationBypassHashRef.current = undefined;
        window.history.replaceState(window.history.state, "", hash);
        setState((current) => ({
          ...current,
          route: effectiveRoute,
          navigationRevision: (current.navigationRevision ?? 0) + 1
        }));
      } else {
        navigationBypassHashRef.current = hash;
        window.location.hash = hash;
      }
    };
    const leave = workspaceRouteLeaveRequest(routeRef.current, effectiveRoute);
    if (leave === undefined) {
      commit();
      return;
    }
    const requestId = ++navigationRequestRef.current;
    void requestWorkspaceDocumentLeave(leave).then((accepted) => {
      if (accepted && navigationRequestRef.current === requestId) commit();
    });
  }, [updatePreferences]);

  const loadMachineSnapshot = useCallback(async (profile: ConnectionProfile): Promise<AppSnapshot> => {
    if (profile.id === activeProfileRef.current?.id && connectionStateRef.current === "connected") return snapshotRef.current;
    const identity = await probeOrchestratorOrigin(profile.origin);
    if (identity.serverId !== profile.serverId) {
      await requireLocal(localRef.current).deleteMachineCache(profile.id);
      setState((current) => ({
        ...current,
        machineCaches: current.machineCaches.filter((cache) => cache.profileId !== profile.id),
        machinePresenceByProfile: { ...current.machinePresenceByProfile, [profile.id]: "identityMismatch" }
      }));
      throw new MachineIdentityError("This address now belongs to a different Joko node. Pair it again before switching machines.");
    }
    const local = requireLocal(localRef.current);
    const authKey = await local.readAuthKey(profile);
    if (authKey === undefined) throw new Error("The saved connection secret is unavailable. Pair this device again.");
    let captured: AppSnapshot | undefined;
    let accessDenied = false;
    const transient = createOrchestratorGateway(profile, authKey, {
      onSnapshot: (snapshot) => { captured = snapshot; },
      onAuthenticationInvalidated: () => { accessDenied = true; }
    });
    try {
      await transient.connect();
    } catch (error) {
      if (accessDenied) {
        await local.deleteMachineCache(profile.id);
        setState((current) => ({
          ...current,
          machineCaches: current.machineCaches.filter((cache) => cache.profileId !== profile.id),
          machinePresenceByProfile: { ...current.machinePresenceByProfile, [profile.id]: "accessDenied" }
        }));
        throw new MachineAccessDeniedError("This machine no longer accepts the saved connection. Pair it again.");
      }
      throw error;
    } finally {
      transient.disconnect();
    }
    if (captured === undefined) throw new Error("The machine returned no authoritative task snapshot.");
    const cache = machineCacheFromSnapshot(profile, captured);
    await local.saveMachineCache(cache);
    setState((current) => ({
      ...current,
      machineCaches: upsertMachineCache(current.machineCaches, cache),
      machinePresenceByProfile: { ...current.machinePresenceByProfile, [profile.id]: "online" }
    }));
    return captured;
  }, []);

  const runMachineRefresh = useCallback((manual: boolean): Promise<void> => {
    const inFlight = machineRefreshPromiseRef.current;
    if (inFlight !== undefined) return inFlight;
    const refresh = (async (): Promise<void> => {
      const generation = ++machineRefreshGenerationRef.current;
      const profiles = [...profilesRef.current];
      const active = activeProfileRef.current;
      const selected = new Set(selectedMachineProfileIds(preferencesRef.current.machineSelection, profiles));
      if (manual) {
        setState((current) => ({
          ...current,
          machinePresenceByProfile: {
            ...current.machinePresenceByProfile,
            ...Object.fromEntries(profiles.map((profile) => [
              profile.id,
              profile.id === active?.id && connectionStateRef.current === "connected" ? "current" : "checking"
            ] as const))
          }
        }));
      }
      const local = requireLocal(localRef.current);
      const results = await Promise.all(profiles.map(async (profile): Promise<readonly [string, MachinePresenceView] | undefined> => {
        if (profile.id === active?.id && connectionStateRef.current === "connected") return [profile.id, "current"];
        const backoff = machineFailureBackoffRef.current.get(profile.id);
        if (!manual && backoff !== undefined && backoff.retryAt > Date.now()) return undefined;
        try {
          const identity = await probeOrchestratorOrigin(profile.origin);
          machineFailureBackoffRef.current.delete(profile.id);
          if (identity.serverId !== profile.serverId) {
            await local.deleteMachineCache(profile.id);
            if (machineRefreshGenerationRef.current === generation) {
              setState((current) => ({ ...current, machineCaches: current.machineCaches.filter((cache) => cache.profileId !== profile.id) }));
            }
            return [profile.id, "identityMismatch"];
          }
          if (!selected.has(profile.id)) return [profile.id, "online"];
          try {
            await loadMachineSnapshot(profile);
            return [profile.id, "online"];
          } catch (error) {
            if (error instanceof MachineAccessDeniedError) return [profile.id, "accessDenied"];
            if (error instanceof MachineIdentityError) return [profile.id, "identityMismatch"];
            return [profile.id, "online"];
          }
        } catch {
          const previous = machineFailureBackoffRef.current.get(profile.id)?.failures ?? 0;
          const failures = previous + 1;
          machineFailureBackoffRef.current.set(profile.id, {
            failures,
            retryAt: Date.now() + machineRetryDelayMs(profile.id, failures)
          });
          return [profile.id, "offline"];
        }
      }));
      if (machineRefreshGenerationRef.current !== generation) return;
      setState((current) => ({
        ...current,
        machinePresenceByProfile: {
          ...current.machinePresenceByProfile,
          ...Object.fromEntries(results.filter((entry): entry is readonly [string, MachinePresenceView] => entry !== undefined))
        }
      }));
    })();
    machineRefreshPromiseRef.current = refresh;
    void refresh.then(() => {
      if (machineRefreshPromiseRef.current === refresh) machineRefreshPromiseRef.current = undefined;
    }, () => {
      if (machineRefreshPromiseRef.current === refresh) machineRefreshPromiseRef.current = undefined;
    });
    return refresh;
  }, [loadMachineSnapshot]);

  const refreshMachines = useCallback((): Promise<void> => runMachineRefresh(true), [runMachineRefresh]);

  const switchMachine = useCallback(async (profileId: string): Promise<void> => {
    const intent = ++machineSwitchIntentRef.current;
    const profile = profilesRef.current.find((candidate) => candidate.id === profileId);
    if (profile === undefined) throw new Error("The selected machine is no longer saved on this client.");
    if (profile.id === activeProfileRef.current?.id && connectionStateRef.current === "connected") {
      navigate({ kind: "session", profileId });
      return;
    }
    await loadMachineSnapshot(profile);
    if (machineSwitchIntentRef.current !== intent) return;
    await connect(profile);
    if (machineSwitchIntentRef.current !== intent) return;
    navigate({ kind: "session", profileId });
  }, [connect, loadMachineSnapshot, navigate]);

  const openMachineSession = useCallback(async (profileId: string, sessionId: string): Promise<void> => {
    const intent = ++machineSwitchIntentRef.current;
    const profile = profilesRef.current.find((candidate) => candidate.id === profileId);
    if (profile === undefined) throw new Error("The selected machine is no longer saved on this client.");
    const snapshot = await loadMachineSnapshot(profile);
    if (!snapshot.sessions.some((session) => session.id === sessionId)) {
      throw new Error("This cached task no longer exists on the selected machine.");
    }
    if (machineSwitchIntentRef.current !== intent) return;
    if (activeProfileRef.current?.id !== profile.id || connectionStateRef.current !== "connected") await connect(profile);
    if (machineSwitchIntentRef.current !== intent) return;
    if (!snapshotRef.current.sessions.some((session) => session.id === sessionId)) {
      throw new Error("The task disappeared while the selected machine was connecting.");
    }
    navigate({ kind: "session", profileId, sessionId });
  }, [connect, loadMachineSnapshot, navigate]);

  const searchRemoteSessionMessages = useCallback(async (
    query: string,
    options: SessionMessageSearchCollectionOptions = {}
  ): Promise<readonly FederatedSessionMessageSearchMatchView[]> => {
    const normalizedQuery = query.trim();
    if (normalizedQuery === "") return [];
    throwIfRemoteSearchAborted(options.signal);

    const connectedProfileIds = new Set([...remoteMachineGatewaysRef.current]
      .filter(([, binding]) => binding.connected && binding.gateway !== undefined)
      .map(([profileId]) => profileId));
    const profileIds = selectedReachableRemoteProfileIds(
      preferencesRef.current.machineSelection,
      profilesRef.current,
      activeProfileRef.current?.id,
      machinePresenceByProfileRef.current,
      connectedProfileIds
    );
    const profiles = new Map(profilesRef.current.map((profile) => [profile.id, profile] as const));
    const searches = profileIds.map(async (profileId): Promise<readonly FederatedSessionMessageSearchMatchView[]> => {
      const profile = profiles.get(profileId);
      const binding = remoteMachineGatewaysRef.current.get(profileId);
      if (profile === undefined || binding?.gateway === undefined || !binding.connected) return [];
      const routedOptions = remoteSessionMessageSearchOptionsForProfile(profileId, options);
      if (routedOptions === undefined || binding.profileKey !== remoteMachineProfileKey(profile)) return [];
      const { gateway: remoteGateway, epoch, profileKey } = binding;
      const result = await remoteGateway.searchAllSessionMessages(normalizedQuery, routedOptions);
      const current = remoteMachineGatewaysRef.current.get(profileId);
      const currentProfile = profilesRef.current.find((candidate) => candidate.id === profileId);
      if (current?.epoch !== epoch
        || current.profileKey !== profileKey
        || current.gateway !== remoteGateway
        || !current.connected
        || currentProfile?.serverId !== profile.serverId
        || currentProfile === undefined
        || remoteMachineProfileKey(currentProfile) !== profileKey
        || machinePresenceByProfileRef.current[profileId] !== "online") return [];
      return result.matches.map((match) => ({
        profileId,
        serverId: profile.serverId,
        source: "live" as const,
        reachable: true as const,
        match
      }));
    });
    const settled = await Promise.allSettled(searches);
    throwIfRemoteSearchAborted(options.signal);
    return settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }, []);

  useEffect(() => {
    if (!state.ready || state.profiles.length === 0) return;
    void runMachineRefresh(false);
    const timer = window.setInterval(() => void runMachineRefresh(false), 30_000);
    return () => window.clearInterval(timer);
  }, [runMachineRefresh, state.profiles, state.ready]);

  useEffect(() => {
    if (!state.ready || localRef.current === undefined) return;
    const selected = new Set(selectedMachineProfileIds(state.preferences.machineSelection, state.profiles));
    const desired = new Map(state.profiles
      .filter((profile) => profile.id !== state.activeProfile?.id && selected.has(profile.id))
      .map((profile) => [profile.id, profile] as const));
    for (const [profileId, binding] of remoteMachineGatewaysRef.current) {
      const profile = desired.get(profileId);
      if (profile !== undefined && binding.profileKey === remoteMachineProfileKey(profile)) continue;
      if (binding.retryTimer !== undefined) window.clearTimeout(binding.retryTimer);
      binding.gateway?.disconnect();
      remoteMachineGatewaysRef.current.delete(profileId);
    }
    for (const profile of desired.values()) {
      if (remoteMachineGatewaysRef.current.has(profile.id)) continue;
      const epoch = ++remoteMachineGatewayEpochRef.current;
      const binding = {
        epoch,
        profileKey: remoteMachineProfileKey(profile),
        gateway: undefined as OrchestratorGateway | undefined,
        connected: false,
        failures: 0,
        retryTimer: undefined as number | undefined
      };
      remoteMachineGatewaysRef.current.set(profile.id, binding);
      const current = (): boolean => {
        const registered = remoteMachineGatewaysRef.current.get(profile.id);
        const savedProfile = profilesRef.current.find((candidate) => candidate.id === profile.id);
        return registered === binding
          && registered.epoch === epoch
          && registered.profileKey === binding.profileKey
          && savedProfile !== undefined
          && remoteMachineProfileKey(savedProfile) === binding.profileKey;
      };
      const scheduleRetry = (): void => {
        if (!current() || binding.retryTimer !== undefined) return;
        binding.failures += 1;
        binding.retryTimer = window.setTimeout(() => {
          binding.retryTimer = undefined;
          if (current()) void connectGateway();
        }, machineRetryDelayMs(profile.id, binding.failures));
      };
      const connectGateway = async (): Promise<void> => {
        const local = requireLocal(localRef.current);
        try {
          const identity = await probeOrchestratorOrigin(profile.origin);
          if (!current()) return;
          if (identity.serverId !== profile.serverId) {
            await local.deleteMachineCache(profile.id);
            if (!current()) return;
            binding.gateway?.disconnect();
            remoteMachineGatewaysRef.current.delete(profile.id);
            setState((value) => ({
              ...value,
              machineCaches: value.machineCaches.filter((cache) => cache.profileId !== profile.id),
              machinePresenceByProfile: { ...value.machinePresenceByProfile, [profile.id]: "identityMismatch" }
            }));
            return;
          }
          const authKey = await local.readAuthKey(profile);
          if (!current()) return;
          if (authKey === undefined) {
            await local.deleteMachineCache(profile.id);
            if (!current()) return;
            binding.gateway?.disconnect();
            remoteMachineGatewaysRef.current.delete(profile.id);
            setState((value) => ({
              ...value,
              machineCaches: value.machineCaches.filter((cache) => cache.profileId !== profile.id),
              machinePresenceByProfile: { ...value.machinePresenceByProfile, [profile.id]: "accessDenied" }
            }));
            return;
          }
          const gateway = createOrchestratorGateway(profile, authKey, {
            onState: (connectionState) => {
              if (!current() || binding.gateway !== gateway) return;
              binding.connected = connectionState === "connected";
              if (connectionState === "connected") {
                binding.failures = 0;
                setState((value) => ({ ...value, machinePresenceByProfile: { ...value.machinePresenceByProfile, [profile.id]: "online" } }));
              } else if (connectionState === "offline") {
                setState((value) => ({ ...value, machinePresenceByProfile: { ...value.machinePresenceByProfile, [profile.id]: "offline" } }));
              }
            },
            onSnapshot: (snapshot) => {
              if (!current() || binding.gateway !== gateway) return;
              const cache = machineCacheFromSnapshot(profile, snapshot);
              setState((value) => ({
                ...value,
                machineCaches: upsertMachineCache(value.machineCaches, cache),
                machinePresenceByProfile: { ...value.machinePresenceByProfile, [profile.id]: "online" }
              }));
              void local.saveMachineCache(cache).catch(() => undefined);
            },
            onError: (error) => {
              if (!current() || binding.gateway !== gateway || !error.offline) return;
              binding.connected = false;
              setState((value) => ({ ...value, machinePresenceByProfile: { ...value.machinePresenceByProfile, [profile.id]: "offline" } }));
            },
            onAuthenticationInvalidated: async () => {
              if (!current() || binding.gateway !== gateway) return;
              binding.connected = false;
              if (shouldDeleteInvalidatedConnectionCredential(profile)) await local.deleteAuthKey(profile.id);
              await local.deleteMachineCache(profile.id);
              if (!current()) return;
              gateway.disconnect();
              remoteMachineGatewaysRef.current.delete(profile.id);
              setState((value) => ({
                ...value,
                machineCaches: value.machineCaches.filter((cache) => cache.profileId !== profile.id),
                machinePresenceByProfile: { ...value.machinePresenceByProfile, [profile.id]: "accessDenied" }
              }));
            }
          });
          binding.gateway = gateway;
          await gateway.connect();
          if (!current() || binding.gateway !== gateway) {
            gateway.disconnect();
            return;
          }
          binding.connected = true;
          binding.failures = 0;
        } catch {
          if (!current()) return;
          binding.connected = false;
          binding.gateway?.disconnect();
          binding.gateway = undefined;
          setState((value) => ({ ...value, machinePresenceByProfile: { ...value.machinePresenceByProfile, [profile.id]: "offline" } }));
          scheduleRetry();
        }
      };
      void connectGateway();
    }
  }, [state.activeProfile?.id, state.preferences.machineSelection, state.profiles, state.ready]);

  useEffect(() => {
    const route = state.route;
    if (!state.ready || route.kind !== "session" || route.profileId === undefined || route.sessionId === undefined) return;
    if (activeProfileRef.current?.id === route.profileId && connectionStateRef.current === "connecting") return;
    if (activeProfileRef.current?.id === route.profileId
      && connectionStateRef.current === "connected"
      && snapshotRef.current.sessions.some((session) => session.id === route.sessionId)) return;
    const requestedHash = appRouteHash(route);
    void openMachineSession(route.profileId, route.sessionId).catch((error: unknown) => {
      if (appRouteHash(routeRef.current) !== requestedHash) return;
      setState((current) => ({ ...current, error: messageOf(error) }));
      navigate({ kind: "session" }, { replace: true });
    });
  }, [navigate, openMachineSession, state.connectionState, state.ready, state.route]);

  const refreshDiscoveredNodes = useCallback(async (): Promise<void> => {
    const generation = ++discoveryGenerationRef.current;
    discoveryAbortRef.current?.abort();
    const abort = new AbortController();
    discoveryAbortRef.current = abort;
    setState((current) => ({ ...current, discoveryState: "discovering", discoveryError: undefined }));
    try {
      const nodes = await collectDiscoveredOrchestratorNodes(abort.signal);
      if (discoveryGenerationRef.current !== generation) return;
      setState((current) => ({ ...current, discoveredNodes: nodes, discoveryState: "ready", discoveryError: undefined }));
    } catch (error) {
      if (discoveryGenerationRef.current !== generation || abort.signal.aborted) return;
      setState((current) => ({ ...current, discoveredNodes: [], discoveryState: "ready", discoveryError: messageOf(error) }));
    }
  }, []);

  useEffect(() => {
    if (!state.ready || state.connectionState !== "disconnected") return;
    void refreshDiscoveredNodes();
  }, [refreshDiscoveredNodes, state.connectionState, state.ready]);

  const setAutomaticConnectionEnabled = useCallback(async (enabled: boolean): Promise<void> => {
    const preferenceIntent = ++automaticPreferenceIntentRef.current;
    if (!enabled) {
      startupAutoConnectRef.current = undefined;
      startupManagedLocalAutoPendingRef.current = false;
      await updatePreferences({ automaticConnectionTarget: undefined });
      return;
    }
    const profile = activeProfileRef.current;
    const gatewayGeneration = gatewayGenerationRef.current;
    if (profile === undefined || connectionStateRef.current !== "connected") {
      throw new Error("Connect to Joko before enabling automatic entry.");
    }
    const available = await automaticConnectionPersistenceAvailable();
    if (automaticPreferenceIntentRef.current !== preferenceIntent) return;
    if (!available) throw new Error("Automatic entry requires encrypted persistent credential storage.");
    if (gatewayGenerationRef.current !== gatewayGeneration
      || activeProfileRef.current?.id !== profile.id
      || connectionStateRef.current !== "connected") return;
    await updatePreferences({ automaticConnectionTarget: automaticConnectionTargetForProfile(profile) });
  }, [updatePreferences]);

  const cancelAutomaticConnectionAttempt = useCallback((): void => {
    startupAutoConnectRef.current = undefined;
    startupManagedLocalAutoPendingRef.current = false;
  }, []);

  const gateway = useCallback((): OrchestratorGateway => {
    const value = gatewayRef.current;
    if (value === undefined) throw new Error("Connect to Joko before performing this action.");
    return value;
  }, []);

  const revokeDevice = useCallback(async (deviceId: string): Promise<void> => {
    await gateway().revokeDevice(deviceId);
    if (automaticConnectionTargetMatchesDevice(preferencesRef.current.automaticConnectionTarget, deviceId, state.profiles)) {
      automaticPreferenceIntentRef.current += 1;
      await updatePreferences({ automaticConnectionTarget: undefined });
    }
  }, [gateway, state.profiles, updatePreferences]);

  const logoutConnection = useCallback(async (connectionId: string): Promise<void> => {
    await gateway().logoutConnection(connectionId);
    if (automaticConnectionTargetMatchesProfile(preferencesRef.current.automaticConnectionTarget, connectionId, state.profiles)) {
      automaticPreferenceIntentRef.current += 1;
      await updatePreferences({ automaticConnectionTarget: undefined });
    }
  }, [gateway, state.profiles, updatePreferences]);

  const probeRuntimeActivity = useCallback((): Promise<boolean> => {
    const local = requireLocal(localRef.current);
    return probeDesktopManagedRuntimeActivity({
      getManagedStatus: readDesktopManagedOrchestratorStatus,
      probeOrigin: (origin) => probeOrchestratorOrigin(origin),
      readAuthKey: (profile) => local.readAuthKey(profile),
      probeRuntime: (origin, authKey) => probeOrchestratorRuntimeActivityAt(origin, authKey)
    });
  }, []);

  return useMemo<AppController>(() => ({
    state,
    probeRuntimeActivity,
    connect,
    pair,
    disconnect,
    forgetProfile,
    logoutProfile,
    refreshDiscoveredNodes,
    refreshMachines,
    setMachineSelection,
    switchMachine,
    openMachineSession,
    retryManagedOrchestrator,
    cancelAutomaticConnectionAttempt,
    setAutomaticConnectionEnabled,
    navigate,
    setLocale: (locale) => updatePreferences({ locale }),
    setTheme: (theme) => updatePreferences({ theme }),
    setUiFamily: (uiFamily) => updatePreferences({ uiFamily: normalizeFontFamily(uiFamily) }),
    setCodeFamily: (codeFamily) => updatePreferences({ codeFamily: normalizeFontFamily(codeFamily) }),
    setUiSize: (uiSize) => updatePreferences({ uiSize: clampUiSize(uiSize) }),
    setCodeSize: (codeSize) => updatePreferences({ codeSize: clampCodeSize(codeSize) }),
    setWindowZoom: (windowZoom) => updatePreferences({ windowZoom: clampWindowZoom(windowZoom) }),
    setComposerSendShortcut: (composerSendShortcut) => updatePreferences({ composerSendShortcut }),
    setMessageSearchSort: (messageSearchSort) => updatePreferences({ messageSearchSort }),
    setMessageNavRailEnabled: (messageNavRailEnabled) => updatePreferences({ messageNavRailEnabled }),
    resetMessageNavRailEnabled: () => updatePreferences({ messageNavRailEnabled: true }),
    getPersonalizationPrompt: () => personalizationPromptForOwner(
      preferencesRef.current.personalizationPrompts,
      state.activeProfile?.serverId
    ),
    setPersonalizationPrompt: (value) => {
      const ownerId = state.activeProfile?.serverId;
      if (ownerId === undefined) return Promise.reject(new Error("Connect to a Joko node before changing personalization instructions."));
      return updatePreferences({
        personalizationPrompts: withPersonalizationPrompt(preferencesRef.current.personalizationPrompts, ownerId, value)
      });
    },
    resetPersonalizationPrompt: () => {
      const ownerId = state.activeProfile?.serverId;
      if (ownerId === undefined) return Promise.reject(new Error("Connect to a Joko node before changing personalization instructions."));
      return updatePreferences({
        personalizationPrompts: withPersonalizationPrompt(preferencesRef.current.personalizationPrompts, ownerId, "")
      });
    },
    setLinkOpenPreference: (linkOpenPreference) => updatePreferences({ linkOpenPreference }),
    resetLinkOpenPreference: () => updatePreferences({ linkOpenPreference: "sidebar" }),
    setStreamFadeEnabled: (streamFadeEnabled) => updatePreferences({ streamFadeEnabled }),
    resetStreamFadeEnabled: () => updatePreferences({ streamFadeEnabled: true }),
    setSessionNotificationsEnabled: (sessionNotificationsEnabled) => updatePreferences({ sessionNotificationsEnabled }),
    setNewSessionWorktreeEnabled: (newSessionWorktreeEnabled) => updatePreferences({ newSessionWorktreeEnabled }),
    openHttpLink: (url, options) => openHttpLinkWithPreference({
      url,
      preference: resolveLinkOpenPreference(preferencesRef.current.linkOpenPreference, options),
      browsers: snapshotRef.current.browsers,
      sessionId: options?.sessionId,
      openPage: (browserId, sessionId, targetUrl) => gateway().openBrowserPage(browserId, sessionId, targetUrl),
      showBrowser: async (browserId, pageId, sessionId) => {
        const route = routeRef.current;
        if (route.kind !== "session" || route.sessionId !== sessionId) navigate({ kind: "session", sessionId });
        await updatePreferences({ inspectorOpen: true });
        const requestId = ++browserInspectorRequestRef.current;
        setState((current) => ({
          ...current,
          browserInspectorFocusRequest: {
            sessionId,
            browserId,
            pageId,
            requestId
          }
        }));
      },
      openExternal: openExternalHttpUrl
    }),
    setSidebarDisplayPreferences: (patch) => updatePreferences({
      sidebarDisplayPreferences: withSidebarDisplayPreferences(preferencesRef.current.sidebarDisplayPreferences, patch)
    }),
    setSidebarOwnerLayout: (patch) => {
      const ownerId = state.activeProfile?.serverId;
      if (ownerId === undefined) return Promise.reject(new Error("Connect to a Joko node before changing sidebar layout."));
      return updatePreferences({
        sidebarOwnerLayouts: withSidebarOwnerLayout(preferencesRef.current.sidebarOwnerLayouts, ownerId, patch)
      });
    },
    setAppShortcutOverride: (id, value) => updatePreferences({
      appShortcutOverrides: withAppShortcutOverride(preferencesRef.current.appShortcutOverrides, id, value)
    }),
    resetAppShortcutOverrides: () => updatePreferences({ appShortcutOverrides: {} }),
    setInspectorOpen: (inspectorOpen) => updatePreferences({ inspectorOpen }),
    setNavigationOpen: (navigationOpen) => {
      const navigationMode = navigationOpen ? "expanded" : "hidden";
      return updatePreferences({ navigationOpen, navigationMode });
    },
    setNavigationLayout: ({ mode, width }) => updatePreferences({
      navigationOpen: mode !== "hidden",
      navigationMode: mode,
      navigationWidth: normalizeNavigationWidth(width)
    }),
    synchronizeLayoutReset: () => {
      const ownerId = state.activeProfile?.serverId;
      resetClientLayout(ownerId, layoutResetPersistsSessionSplit(window.location.search));
      const next = {
        ...preferencesRef.current,
        inspectorOpen: DEFAULT_UI_PREFERENCES.inspectorOpen,
        navigationOpen: DEFAULT_UI_PREFERENCES.navigationOpen,
        navigationMode: DEFAULT_UI_PREFERENCES.navigationMode,
        navigationWidth: DEFAULT_UI_PREFERENCES.navigationWidth
      };
      preferencesRef.current = next;
      setState((current) => ({ ...current, preferences: next }));
    },
    resetLayoutPreferences: async () => {
      const ownerId = state.activeProfile?.serverId;
      resetClientLayout(ownerId, layoutResetPersistsSessionSplit(window.location.search));
      await updatePreferences({
        inspectorOpen: DEFAULT_UI_PREFERENCES.inspectorOpen,
        navigationOpen: DEFAULT_UI_PREFERENCES.navigationOpen,
        navigationMode: DEFAULT_UI_PREFERENCES.navigationMode,
        navigationWidth: DEFAULT_UI_PREFERENCES.navigationWidth
      });
    },
    dismissExtensionNotification: (eventId) => setState((current) => ({
      ...current,
      extensionNotifications: current.extensionNotifications.filter((notification) => notification.eventId !== eventId)
    })),
    readDraft: (sessionId) => requireLocal(localRef.current).readDraft(sessionId),
    saveDraft: (sessionId, draft) => requireLocal(localRef.current).saveDraft(sessionId, draft),
    readNewSessionDraft: () => requireLocal(localRef.current).readNewSessionDraft(newSessionDraftScope(requireActiveProfile(state.activeProfile))),
    saveNewSessionDraft: (draft) => requireLocal(localRef.current).saveNewSessionDraft(newSessionDraftScope(requireActiveProfile(state.activeProfile)), draft),
    clearNewSessionDraft: () => requireLocal(localRef.current).clearNewSessionDraft(newSessionDraftScope(requireActiveProfile(state.activeProfile))),
    refresh: () => gateway().refresh(),
    refreshProviderAccountUsage: (backendId, providerId) => gateway().refreshProviderAccountUsage(backendId, providerId),
    getArtifactStorageStats: (protectedSha256) => gateway().getArtifactStorageStats(protectedSha256),
    scanArtifactStorage: (protectedSha256) => gateway().scanArtifactStorage(protectedSha256),
    reconcileArtifactStorage: (protectedSha256) => gateway().reconcileArtifactStorage(protectedSha256),
    cleanupArtifactStorage: (scanToken, protectedSha256) => gateway().cleanupArtifactStorage(scanToken, protectedSha256),
    getTaskHistoryMaintenanceSupport: () => gateway().getTaskHistoryMaintenanceSupport(),
    scanTaskHistory: (retention, includeActiveTasks) => gateway().scanTaskHistory(retention, includeActiveTasks),
    beginTaskHistoryCleanup: (scanId, backupEnabled) => gateway().beginTaskHistoryCleanup(scanId, backupEnabled),
    getTaskHistoryCleanup: (maintenanceId) => gateway().getTaskHistoryCleanup(maintenanceId),
    cancelTaskHistoryCleanup: (maintenanceId) => gateway().cancelTaskHistoryCleanup(maintenanceId),
    getVoiceInputCapabilities: (signal) => gateway().getVoiceInputCapabilities(signal),
    testVoiceInputConnection: (signal) => gateway().testVoiceInputConnection(signal),
    adviseVoiceInputDictionaryEdit: (draft, signal) => gateway().adviseVoiceInputDictionaryEdit(draft, signal),
    startVoiceInput: (requestId, mimeType, locale, refinement, signal) => gateway().startVoiceInput(requestId, mimeType, locale, refinement, signal),
    appendVoiceAudio: (voiceInputId, chunkSequence, audio, durationMs, voiced, signal) =>
      gateway().appendVoiceAudio(voiceInputId, chunkSequence, audio, durationMs, voiced, signal),
    stopVoiceInput: (voiceInputId, expectedNextChunkSequence, signal) =>
      gateway().stopVoiceInput(voiceInputId, expectedNextChunkSequence, signal),
    cancelVoiceInput: (voiceInputId, signal) => gateway().cancelVoiceInput(voiceInputId, signal),
    getVoiceInputSession: (voiceInputId, signal) => gateway().getVoiceInputSession(voiceInputId, signal),
    send: (sessionId, draft) => gateway().send(sessionId, draft),
    startReview: (sourceSessionId, focus, attachments) => gateway().startReview(sourceSessionId, focus, attachments),
    reobserveReview: (reviewRunId) => gateway().reobserveReview(reviewRunId),
    abort: (runId) => gateway().abort(runId),
    abortRetry: (runId) => gateway().abortRetry(runId),
    retry: (runId) => gateway().retry(runId),
    resetSession: (sessionId) => gateway().resetSession(sessionId),
    deleteSessionMessage: (sessionId, eventId) => gateway().deleteSessionMessage(sessionId, eventId),
    renameSession: (sessionId, name) => gateway().renameSession(sessionId, name),
    suggestSessionTitle: (sessionId, signal) => gateway().suggestSessionTitle(sessionId, signal),
    pinSession: (sessionId, pinned) => gateway().pinSession(sessionId, pinned),
    archiveSession: (sessionId, archived) => gateway().archiveSession(sessionId, archived),
    moveSessionProject: (sessionId, projectId, catalogImport) => gateway().moveSessionProject(sessionId, projectId, catalogImport),
    acknowledgeSessionAttention: (sessionId, throughCursor) => gateway().acknowledgeSessionAttention(sessionId, throughCursor),
    acknowledgeSessionError: (sessionId, throughCursor) => gateway().acknowledgeSessionError(sessionId, throughCursor),
    deleteSession: (sessionId, deleteNative) => gateway().deleteSession(sessionId, deleteNative),
    createSession: (draft) => gateway().createSession(sessionDraftWithPersonalization(
      draft,
      personalizationPromptForOwner(
        preferencesRef.current.personalizationPrompts,
        state.activeProfile?.serverId
      )
    )),
    probeTargetWorktree: (targetId, signal) => gateway().probeTargetWorktree(targetId, signal),
    listTargetWorktreeSources: (targetId, signal) => gateway().listTargetWorktreeSources(targetId, signal),
    discoverNativeSessions: (targetId) => gateway().discoverNativeSessions(targetId),
    scanNativeSessionCatalog: (backendId, options) => gateway().scanNativeSessionCatalog(backendId, options),
    createTarget: (draft) => gateway().createTarget(draft),
    updateTarget: (targetId, patch) => gateway().updateTarget(targetId, patch),
    archiveTarget: (targetId, archived) => gateway().archiveTarget(targetId, archived),
    deleteTarget: (targetId, deleteManagedWorkspace, deleteProductSessions) => gateway().deleteTarget(targetId, deleteManagedWorkspace, deleteProductSessions),
    setWorkspaceTrust: (workspaceId, trusted) => gateway().setWorkspaceTrust(workspaceId, trusted),
    addExtraDirectory: (workspaceId, serverPath, access) => gateway().addExtraDirectory(workspaceId, serverPath, access),
    removeExtraDirectory: (extraDirectoryId) => gateway().removeExtraDirectory(extraDirectoryId),
    setModel: (sessionId, providerId, modelId, effort, fastMode) => gateway().setModel(sessionId, providerId, modelId, effort, fastMode),
    setPermission: (sessionId, mode) => gateway().setPermission(sessionId, mode),
    setPlanMode: (sessionId, enabled) => gateway().setPlanMode(sessionId, enabled),
    compact: (sessionId, customInstructions) => gateway().compact(sessionId, customInstructions),
    exportSession: (sessionId) => gateway().exportSession(sessionId),
    exportPortableSession: (sessionId, options) => gateway().exportPortableSession(sessionId, options),
    inspectPortableSessionImport: (file) => gateway().inspectPortableSessionImport(file),
    unlockPortableSessionImport: (draftId, password) => gateway().unlockPortableSessionImport(draftId, password),
    cancelPortableSessionImport: (draftId) => gateway().cancelPortableSessionImport(draftId),
    commitPortableSessionImport: (input) => gateway().commitPortableSessionImport(input),
    retryPortableSessionActivation: (sessionId) => gateway().retryPortableSessionActivation(sessionId),
    executeUserShell: (sessionId, command, excludeFromContext) => gateway().executeUserShell(sessionId, command, excludeFromContext),
    abortUserShell: (sessionId) => gateway().abortUserShell(sessionId),
    getSessionStatistics: (sessionId, signal) => gateway().getSessionStatistics(sessionId, signal),
    getSessionTree: (sessionId): Promise<NativeSessionTreeView> => gateway().getSessionTree(sessionId),
    navigateSessionBranch: (sessionId, entryId, options) => gateway().navigateSessionBranch(sessionId, entryId, options),
    forkSession: (sessionId, entryId, name, sourceMessage) => gateway().forkSession(sessionId, entryId, name, sourceMessage),
    cloneSession: (sessionId, name, sourceMessage) => gateway().cloneSession(sessionId, name, sourceMessage),
    resolveInteraction: (interaction, value) => gateway().resolveInteraction(interaction, value),
    dismissInteraction: (interaction) => gateway().dismissInteraction(interaction),
    runSchedule: (scheduleId) => gateway().runSchedule(scheduleId),
    setScheduleEnabled: (scheduleId, enabled) => gateway().setScheduleEnabled(scheduleId, enabled),
    deleteSchedule: (scheduleId, disposition) => gateway().deleteSchedule(scheduleId, disposition),
    markScheduleRunRead: (scheduleId, triggerId) => gateway().markScheduleRunRead(scheduleId, triggerId),
    markScheduleRunsRead: (scheduleId) => gateway().markScheduleRunsRead(scheduleId),
    markAllScheduleRunsRead: () => gateway().markAllScheduleRunsRead(),
    deleteScheduleRun: (scheduleId, triggerId) => gateway().deleteScheduleRun(scheduleId, triggerId),
    restartScheduleRun: (scheduleId, triggerId) => gateway().restartScheduleRun(scheduleId, triggerId),
    reconcileProjectAutomations: (targetId) => gateway().reconcileProjectAutomations(targetId),
    promoteScheduleToProject: (scheduleId) => gateway().promoteScheduleToProject(scheduleId),
    cloneProjectScheduleToUser: (scheduleId, displayName) => gateway().cloneProjectScheduleToUser(scheduleId, displayName),
    removeProjectSchedule: (scheduleId, keepPersonalCopy) => gateway().removeProjectSchedule(scheduleId, keepPersonalCopy),
    saveSchedule: (scheduleId, draft) => gateway().saveSchedule(scheduleId, draft),
    listScheduleRunHistory: (scheduleId, pageToken, pageSize) => gateway().listScheduleRunHistory(scheduleId, pageToken, pageSize),
    getSchedulerRuntime: (signal) => gateway().getSchedulerRuntime(signal),
    cancelQueueItem: (queueItemId) => gateway().cancelQueueItem(queueItemId),
    setQueueItemEditLock: (queueItemId, lockToken, locked) => gateway().setQueueItemEditLock(queueItemId, lockToken, locked),
    setQueueInteractionLock: (sessionId, lockToken, locked) => gateway().setQueueInteractionLock(sessionId, lockToken, locked),
    editQueueItem: (queueItemId, text, mode, lockToken) => gateway().editQueueItem(queueItemId, text, mode, lockToken),
    reorderQueueItem: (queueItemId, placement, anchorQueueItemId, interactionLockToken) => gateway().reorderQueueItem(queueItemId, placement, anchorQueueItemId, interactionLockToken),
    steerQueueItemNow: (queueItemId, text, lockToken) => gateway().steerQueueItemNow(queueItemId, text, lockToken),
    pauseQueue: (sessionId, reason) => gateway().pauseQueue(sessionId, reason),
    resumeQueue: (sessionId) => gateway().resumeQueue(sessionId),
    restartBrowser: (browserId) => gateway().restartBrowser(browserId),
    openBrowserPage: (browserId, sessionId, url) => gateway().openBrowserPage(browserId, sessionId, url),
    recoverBrowserPage: (browserId, sessionId, pageId, url) => gateway().recoverBrowserPage(browserId, sessionId, pageId, url),
    focusBrowserPage: (browserId, pageId) => gateway().focusBrowserPage(browserId, pageId),
    closeBrowserPage: (browserId, pageId) => gateway().closeBrowserPage(browserId, pageId),
    beginBrowserTakeover: (browserId, pageId) => gateway().beginBrowserTakeover(browserId, pageId),
    endBrowserTakeover: (browserId) => gateway().endBrowserTakeover(browserId),
    performBrowserTakeoverAction: (browserId, pageId, action) => gateway().performBrowserTakeoverAction(browserId, pageId, action),
    inspectBrowserCommentTarget: (browserId, pageId, input) => gateway().inspectBrowserCommentTarget(browserId, pageId, input),
    updateBrowserCommentDesign: (browserId, pageId, command) => gateway().updateBrowserCommentDesign(browserId, pageId, command),
    listBrowserActivity: (browserId, pageId) => gateway().listBrowserActivity(browserId, pageId),
    listBrowserTransfers: (browserId, pageId) => gateway().listBrowserTransfers(browserId, pageId),
    uploadBrowserFile: (browserId, pageId, file, inputHint) => gateway().uploadBrowserFile(browserId, pageId, file, inputHint),
    approveResource: (resourceId, discoveredRevision) => gateway().approveResource(resourceId, discoveredRevision),
    discoverProjectResources: (targetId) => gateway().discoverProjectResources(targetId),
    addResource: (draft) => gateway().addResource(draft),
    setResourceEnabled: (resourceId, enabled) => gateway().setResourceEnabled(resourceId, enabled),
    removeResource: (resourceId) => gateway().removeResource(resourceId),
    listCommands: (sessionId) => gateway().listCommands(sessionId),
    listRuntimeProcesses: (backendId, signal) => gateway().listRuntimeProcesses(backendId, signal),
    getUsageHistory: (days, backendId, providerId, signal) => gateway().getUsageHistory(days, backendId, providerId, signal),
    getModelPriceOverride: (backendId, providerId, modelId, signal) =>
      gateway().getModelPriceOverride(backendId, providerId, modelId, signal),
    setModelPriceOverride: (backendId, providerId, modelId, desired, signal) =>
      gateway().setModelPriceOverride(backendId, providerId, modelId, desired, signal),
    resetModelPriceOverride: (backendId, providerId, modelId, signal) =>
      gateway().resetModelPriceOverride(backendId, providerId, modelId, signal),
    terminateRuntimeProcess: (process) => gateway().terminateRuntimeProcess(process),
    listRuntimeTools: (sessionId) => gateway().listRuntimeTools(sessionId),
    listBackgroundTasks: (sessionId) => gateway().listBackgroundTasks(sessionId),
    cancelBackgroundTask: (sessionId, backgroundTaskId) => gateway().cancelBackgroundTask(sessionId, backgroundTaskId),
    listSubagentRuns: (sessionId, state, pageToken, pageSize) => gateway().listSubagentRuns(sessionId, state, pageToken, pageSize),
    getSubagentRun: (sessionId, subagentRunId) => gateway().getSubagentRun(sessionId, subagentRunId),
    listSubagentTranscript: (sessionId, subagentRunId, childId, pageToken, pageSize) => gateway().listSubagentTranscript(sessionId, subagentRunId, childId, pageToken, pageSize),
    controlSubagent: (sessionId, subagentRunId, action, message, childId) => gateway().controlSubagent(sessionId, subagentRunId, action, message, childId),
    searchSessionMessages: (query, pageToken, pageSize, scope, filters) => gateway().searchSessionMessages(query, pageToken, pageSize, scope, filters),
    searchAllSessionMessages: (query, options) => gateway().searchAllSessionMessages(query, options),
    searchRemoteSessionMessages,
    loadSessionTimelinePage: (sessionId, beforeCursor, limit) => gateway().loadSessionTimelinePage(sessionId, beforeCursor, limit),
    loadSessionTimelineAround: (sessionId, eventId, limit) => gateway().loadSessionTimelineAround(sessionId, eventId, limit),
    listWorkspaceEntries: (workspaceId, parentPath, options) => gateway().listWorkspaceEntries(workspaceId, parentPath, options),
    listWorkspaceEntryPage: (workspaceId, parentPath, pageToken, pageSize, options) => gateway().listWorkspaceEntryPage(workspaceId, parentPath, pageToken, pageSize, options),
    listWorkspaceFiles: (workspaceId, signal) => gateway().listWorkspaceFiles(workspaceId, signal),
    watchWorkspaceFileChanges: (scope, signal) => gateway().watchWorkspaceFileChanges(scope, signal),
    readWorkspaceFile: (workspaceId, path) => gateway().readWorkspaceFile(workspaceId, path),
    writeWorkspaceTextFile: (workspaceId, draft) => gateway().writeWorkspaceTextFile(workspaceId, draft),
    searchWorkspace: (workspaceId, query) => gateway().searchWorkspace(workspaceId, query),
    searchWorkspacePage: (workspaceId, request, signal) => gateway().searchWorkspacePage(workspaceId, request, signal),
    streamWorkspaceSearch: (workspaceId, query, caseSensitive, signal) => gateway().streamWorkspaceSearch(workspaceId, query, caseSensitive, signal),
    createWorkspaceEntry: (draft) => gateway().createWorkspaceEntry(draft),
    moveWorkspaceEntry: (draft) => gateway().moveWorkspaceEntry(draft),
    deleteWorkspaceEntry: (draft) => gateway().deleteWorkspaceEntry(draft),
    copyWorkspaceEntry: (draft) => gateway().copyWorkspaceEntry(draft),
    getWorkspaceDiff: (workspaceId, query) => gateway().getWorkspaceDiff(workspaceId, query),
    readWorkspaceDiffFile: (workspaceId, file, diff) => gateway().readWorkspaceDiffFile(workspaceId, file, diff),
    readWorkspaceDiffImage: (workspaceId, file, diff) => gateway().readWorkspaceDiffImage(workspaceId, file, diff),
    applyWorkspaceDiffHunk: (workspaceId, draft) => gateway().applyWorkspaceDiffHunk(workspaceId, draft),
    commitWorkspaceDiff: (workspaceId, draft) => gateway().commitWorkspaceDiff(workspaceId, draft),
    pushWorkspaceBranch: (workspaceId, draft) => gateway().pushWorkspaceBranch(workspaceId, draft),
    listWorkspaceChangeSets: (workspaceId, sessionId) => gateway().listWorkspaceChangeSets(workspaceId, sessionId),
    previewWorkspaceRewind: (workspaceId, changeSetId) => gateway().previewWorkspaceRewind(workspaceId, changeSetId),
    executeWorkspaceRewind: (workspaceId, previewId, changeSetId, dialogueOnly) => gateway().executeWorkspaceRewind(workspaceId, previewId, changeSetId, dialogueOnly),
    restartBackend: (backendId) => gateway().restartBackend(backendId),
    updateBackendSettings: (backendId, patch) => gateway().updateBackendSettings(backendId, patch),
    renameDevice: (deviceId, name) => gateway().renameDevice(deviceId, name),
    setDeviceRemoteControlEnabled: (enabled) => gateway().setDeviceRemoteControlEnabled(enabled),
    setDeviceControlTargetEnabled: (targetDeviceId, enabled) => gateway().setDeviceControlTargetEnabled(targetDeviceId, enabled),
    setDeviceControllerAllowed: (controllerDeviceId, allowed) => gateway().setDeviceControllerAllowed(controllerDeviceId, allowed),
    revokeDevice,
    logoutConnection,
    saveProvider: (draft) => gateway().saveProvider(draft),
    deleteProvider: (providerId) => gateway().deleteProvider(providerId),
    refreshProviderModels: (backendId, providerId, automatic) => gateway().refreshProviderModels(backendId, providerId, automatic),
    refreshManagedModelRuntimes: (signal) => gateway().refreshManagedModelRuntimes(signal),
    startManagedModelRuntime: (runtimeId) => gateway().startManagedModelRuntime(runtimeId),
    installManagedModelRuntime: (runtimeId) => gateway().installManagedModelRuntime(runtimeId),
    cancelManagedModelRuntimeInstall: (runtimeId) => gateway().cancelManagedModelRuntimeInstall(runtimeId),
    pullManagedModel: (runtimeId, modelName) => gateway().pullManagedModel(runtimeId, modelName),
    pauseManagedModelPull: (runtimeId, modelName) => gateway().pauseManagedModelPull(runtimeId, modelName),
    resumeManagedModelPull: (runtimeId, modelName) => gateway().resumeManagedModelPull(runtimeId, modelName),
    cancelManagedModelPull: (runtimeId, modelName) => gateway().cancelManagedModelPull(runtimeId, modelName),
    deleteManagedModel: (runtimeId, modelName) => gateway().deleteManagedModel(runtimeId, modelName),
    beginProviderLogin: (backendId, providerId, method) => gateway().beginProviderLogin(backendId, providerId, method),
    getProviderLoginFlow: (loginFlowId) => gateway().getProviderLoginFlow(loginFlowId),
    submitProviderLoginInput: (flow, value) => gateway().submitProviderLoginInput(flow, value),
    cancelProviderLogin: (loginFlowId) => gateway().cancelProviderLogin(loginFlowId),
    refreshProviderCredential: (backendId, providerId) => gateway().refreshProviderCredential(backendId, providerId),
    logoutProvider: (backendId, providerId) => gateway().logoutProvider(backendId, providerId),
    saveProviderCredentialSurface: (backendId, providerId, surfaceId, secret) => gateway().saveProviderCredentialSurface(backendId, providerId, surfaceId, secret),
    clearProviderCredentialSurface: (backendId, providerId, surfaceId) => gateway().clearProviderCredentialSurface(backendId, providerId, surfaceId),
    saveCredential: (draft) => gateway().saveCredential(draft),
    deleteCredential: (credentialId) => gateway().deleteCredential(credentialId),
    getRemoteHostCapabilities: (targetId, signal) => gateway().getRemoteHostCapabilities(targetId, signal),
    listRemoteHosts: (targetId, signal) => gateway().listRemoteHosts(targetId, signal),
    watchRemoteHosts: (targetId, signal) => gateway().watchRemoteHosts(targetId, signal),
    refreshRemoteHostCatalog: (targetId) => gateway().refreshRemoteHostCatalog(targetId),
    createRemoteHost: (targetId, draft) => gateway().createRemoteHost(targetId, draft),
    updateRemoteHost: (targetId, hostId, expectedRevision, draft) =>
      gateway().updateRemoteHost(targetId, hostId, expectedRevision, draft),
    deleteRemoteHost: (targetId, hostId, expectedRevision) =>
      gateway().deleteRemoteHost(targetId, hostId, expectedRevision),
    connectRemoteHost: (targetId, hostId, expectedRevision) =>
      gateway().connectRemoteHost(targetId, hostId, expectedRevision),
    disconnectRemoteHost: (targetId, hostId, expectedRevision) =>
      gateway().disconnectRemoteHost(targetId, hostId, expectedRevision),
    testRemoteHostConnection: (targetId, hostId, expectedRevision) =>
      gateway().testRemoteHostConnection(targetId, hostId, expectedRevision),
    clearRemoteHostTrust: (targetId, hostId, expectedRevision) =>
      gateway().clearRemoteHostTrust(targetId, hostId, expectedRevision),
    saveMcpServer: (draft) => gateway().saveMcpServer(draft),
    deleteMcpServer: (serverId) => gateway().deleteMcpServer(serverId),
    restartMcpServer: (serverId) => gateway().restartMcpServer(serverId),
    updatePiSettings: (backendId, patch) => gateway().updatePiSettings(backendId, patch),
    updateBrowserSettings: (browserProviderId, patch) => gateway().updateBrowserSettings(browserProviderId, patch),
    updateVoiceInputServiceSettings: (draft) => gateway().updateVoiceInputServiceSettings(draft),
    showBrowserAutomation: (browserProviderId, targetId) => gateway().showBrowserAutomation(browserProviderId, targetId),
    updateComputerAutomationSettings: (enabled) => gateway().updateComputerAutomationSettings(enabled),
    installComputerAutomation: () => gateway().installComputerAutomation(),
    probeComputerAutomation: (fresh) => gateway().probeComputerAutomation(fresh),
    requestComputerAutomationPermission: (permission) => gateway().requestComputerAutomationPermission(permission),
    cancelComputerAutomationPermission: () => gateway().cancelComputerAutomationPermission(),
    openComputerAutomationPermissionSettings: (permission) => gateway().openComputerAutomationPermissionSettings(permission),
    checkComputerAutomationUpdate: (fresh) => gateway().checkComputerAutomationUpdate(fresh),
    updateComputerAutomationDriver: (joinOnly) => gateway().updateComputerAutomationDriver(joinOnly),
    updateAndroidAutomationSettings: (enabled) => gateway().updateAndroidAutomationSettings(enabled),
    prepareAndroidAdb: () => gateway().prepareAndroidAdb(),
    probeAndroidAutomation: (fresh) => gateway().probeAndroidAutomation(fresh),
    selectAndroidAutomationDevice: (deviceSerial) => gateway().selectAndroidAutomationDevice(deviceSerial),
    setAndroidAdbPath: (serverPath) => gateway().setAndroidAdbPath(serverPath),
    updatePolicy: (patch) => gateway().updatePolicy(patch),
    updateDiagnostics: (patch) => gateway().updateDiagnostics(patch),
    updateMessageSearchSettings: (enabled) => gateway().updateMessageSearchSettings(enabled),
    resetMessageSearchSettings: () => gateway().resetMessageSearchSettings(),
    updateMemorySettings: (patch) => gateway().updateMemorySettings(patch),
    restoreMemoryDefaults: () => gateway().restoreMemoryDefaults(),
    resetMemory: (scope, backendId) => gateway().resetMemory(scope, backendId),
    updateVisionBridgeSettings: (patch) => gateway().updateVisionBridgeSettings(patch),
    updatePromptRecommendationSettings: (enabled) => gateway().updatePromptRecommendationSettings(enabled),
    resetPromptRecommendationSettings: () => gateway().resetPromptRecommendationSettings(),
    updateLanguageToolSettings: (enabled) => gateway().updateLanguageToolSettings(enabled),
    updateToolPolicySettings: (toolProviderId, targetId, patch) => gateway().updateToolPolicySettings(toolProviderId, targetId, patch),
    updateAgentResourceSettings: (patch) => gateway().updateAgentResourceSettings(patch),
    updateCollaborationSettings: (patch) => gateway().updateCollaborationSettings(patch),
    updateGitSafetySettings: (patch) => gateway().updateGitSafetySettings(patch),
    cleanupGitSafetySavepoints: () => gateway().cleanupGitSafetySavepoints(),
    predictNextPrompt: (sessionId, expectedLastActivityAt, expectedGeneration) =>
      gateway().predictNextPrompt(sessionId, expectedLastActivityAt, expectedGeneration),
    setSilentEncryptedRetryEnabled: (enabled) => gateway().setSilentEncryptedRetryEnabled(enabled),
    resetSilentEncryptedRetry: () => gateway().resetSilentEncryptedRetry(),
    setSessionRuntimeFallbackEnabled: (enabled) => gateway().setSessionRuntimeFallbackEnabled(enabled),
    resetSessionRuntimeFallback: () => gateway().resetSessionRuntimeFallback(),
    createDiagnosticsBundle: () => gateway().createDiagnosticsBundle(),
    installResource: (resourceId) => gateway().installResource(resourceId),
    updateResource: (resourceId) => gateway().updateResource(resourceId),
    captureBrowserScreenshot: (browserId, pageId, fullPage) => gateway().captureBrowserScreenshot(browserId, pageId, fullPage),
    getArtifactUrl: (blobId) => gateway().getArtifactUrl(blobId),
    releaseArtifactUrl: (blobId) => gateway().releaseArtifactUrl(blobId),
    downloadArtifact: (blobId, fileName) => gateway().downloadArtifact(blobId, fileName)
  }), [cancelAutomaticConnectionAttempt, connect, disconnect, forgetProfile, gateway, logoutConnection, logoutProfile, navigate, openMachineSession, pair, probeRuntimeActivity, refreshDiscoveredNodes, refreshMachines, retryManagedOrchestrator, revokeDevice, searchRemoteSessionMessages, setAutomaticConnectionEnabled, setMachineSelection, state, switchMachine, updatePreferences]);
}

function upsertMachineCache(caches: readonly MachineCacheView[], cache: MachineCacheView): readonly MachineCacheView[] {
  return [...caches.filter((candidate) => candidate.profileId !== cache.profileId), cache];
}

function remoteMachineProfileKey(profile: ConnectionProfile): string {
  return `${profile.id}\u0000${profile.origin}\u0000${profile.serverId}`;
}

const REMOTE_SEARCH_ID_SEPARATOR = "\u0000";

/** Qualifies an opaque node-local filter id before federated routing. */
export function qualifiedRemoteSearchFilterId(profileId: string, value: string): string {
  if (profileId.trim() === "" || value.trim() === "" || profileId.includes(REMOTE_SEARCH_ID_SEPARATOR) || value.includes(REMOTE_SEARCH_ID_SEPARATOR)) {
    throw new Error("A remote search filter requires a bounded profile and node-local id.");
  }
  return `${profileId}${REMOTE_SEARCH_ID_SEPARATOR}${value}`;
}

/**
 * Projects only filter identities explicitly qualified for one trusted profile.
 * Bare opaque ids fail closed because equal ids on two nodes need not identify
 * the same target, backend, or session.
 */
export function remoteSessionMessageSearchOptionsForProfile(
  profileId: string,
  options: SessionMessageSearchCollectionOptions
): SessionMessageSearchCollectionOptions | undefined {
  let scope: SessionMessageSearchCollectionOptions["scope"] = { kind: "owner" };
  if (options.scope !== undefined && options.scope.kind !== "owner") {
    const value = remoteSearchFilterValueForProfile(
      profileId,
      options.scope.kind === "session" ? options.scope.sessionId : options.scope.targetId
    );
    if (value === undefined) return undefined;
    scope = options.scope.kind === "session" ? { kind: "session", sessionId: value } : { kind: "target", targetId: value };
  }
  const targetIds = remoteSearchFilterValuesForProfile(profileId, options.filters?.targetIds);
  const sessionIds = remoteSearchFilterValuesForProfile(profileId, options.filters?.sessionIds);
  const backendIds = remoteSearchFilterValuesForProfile(profileId, options.filters?.backendIds);
  if (targetIds === false || sessionIds === false || backendIds === false) return undefined;
  const filters = options.filters;
  return {
    ...options,
    scope,
    ...(filters === undefined ? {} : {
      filters: {
        ...(targetIds === undefined ? {} : { targetIds }),
        ...(sessionIds === undefined ? {} : { sessionIds }),
        ...(backendIds === undefined ? {} : { backendIds }),
        ...(filters.sessionStatus === undefined ? {} : { sessionStatus: filters.sessionStatus }),
        ...(filters.sessionActivityFrom === undefined ? {} : { sessionActivityFrom: filters.sessionActivityFrom }),
        ...(filters.messageCreatedFrom === undefined ? {} : { messageCreatedFrom: filters.messageCreatedFrom }),
        ...(filters.messageCreatedBefore === undefined ? {} : { messageCreatedBefore: filters.messageCreatedBefore })
      }
    })
  };
}

function remoteSearchFilterValuesForProfile(
  profileId: string,
  values: readonly string[] | undefined
): readonly string[] | undefined | false {
  if (values === undefined) return undefined;
  if (values.length === 0) return false;
  const projected: string[] = [];
  for (const value of values) {
    const separator = value.indexOf(REMOTE_SEARCH_ID_SEPARATOR);
    if (separator <= 0 || value.indexOf(REMOTE_SEARCH_ID_SEPARATOR, separator + 1) >= 0) return false;
    if (value.slice(0, separator) !== profileId) continue;
    const localId = value.slice(separator + 1);
    if (localId.trim() === "") return false;
    if (!projected.includes(localId)) projected.push(localId);
  }
  return projected.length === 0 ? false : projected;
}

function remoteSearchFilterValueForProfile(profileId: string, value: string): string | undefined {
  const values = remoteSearchFilterValuesForProfile(profileId, [value]);
  return values === false || values === undefined ? undefined : values[0];
}

function throwIfRemoteSearchAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason ?? new DOMException("Search cancelled", "AbortError");
}

class MachineIdentityError extends Error {}
class MachineAccessDeniedError extends Error {}

export function machineRetryDelayMs(profileId: string, failures: number): number {
  const base = Math.min(120_000, 2_000 * (2 ** Math.min(6, Math.max(0, failures - 1))));
  let hash = 0;
  for (const character of profileId) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  const jitter = 0.85 + (hash % 31) / 100;
  return Math.min(120_000, Math.round(base * jitter));
}

/**
 * An explicit logout is the only path allowed to retire Desktop-managed local
 * authority. Server revocation must finish before Desktop metadata or the
 * local credential is removed; any failure leaves recovery fail-closed.
 */
export async function logoutConnectionProfile(options: {
  readonly profile: ConnectionProfile;
  readonly logoutConnection: (connectionId: string) => Promise<void>;
  readonly completeManagedLogout: () => Promise<void>;
  readonly deleteProfile: () => Promise<void>;
}): Promise<void> {
  try {
    await options.logoutConnection(options.profile.id);
  } catch (error) {
    // Revoking the calling Connection can close its transport before the
    // operation response arrives. Only managed local logout has a second,
    // stronger proof in Desktop; ordinary remote failures remain final.
    if (options.profile.managedLocal !== true) throw error;
  }
  if (options.profile.managedLocal === true) await options.completeManagedLogout();
  await options.deleteProfile();
}

export function shouldDeleteInvalidatedConnectionCredential(profile: ConnectionProfile): boolean {
  return profile.managedLocal !== true;
}

/**
 * Custom instructions are creation-time input. Attaching an existing native
 * session must never retrofit the current owner's instructions onto it.
 */
export function sessionDraftWithPersonalization(draft: NewSessionDraft, prompt: string): NewSessionDraft {
  const clean = { ...draft } as NewSessionDraft & { appendSystemPrompt?: string };
  delete clean.appendSystemPrompt;
  if (draft.nativeStart.kind === "fresh" && prompt.length > 0) clean.appendSystemPrompt = prompt;
  return clean;
}

export interface OpenHttpLinkDependencies {
  readonly url: string;
  readonly preference: LinkOpenPreference;
  readonly browsers: readonly BrowserView[];
  readonly sessionId?: string;
  readonly openPage: (browserId: string, sessionId: string, url: string) => Promise<string>;
  readonly showBrowser: (browserId: string, pageId: string, sessionId: string) => Promise<void> | void;
  readonly openExternal: (url: string) => Promise<void>;
}

export function resolveLinkOpenPreference(
  configured: LinkOpenPreference,
  options?: { readonly forceExternal?: boolean; readonly forceSidebar?: boolean }
): LinkOpenPreference {
  if (options?.forceExternal === true) return "external";
  if (options?.forceSidebar === true) return "sidebar";
  return configured;
}

/**
 * Uses Joko's governed Browser Provider as the in-product destination. Every
 * sidebar open creates a new page; an unavailable or fenced Provider remains a
 * visible error and never changes the user's chosen destination.
 */
export async function openHttpLinkWithPreference(dependencies: OpenHttpLinkDependencies): Promise<void> {
  const url = safeHttpUrl(dependencies.url);
  if (dependencies.preference === "external") {
    await dependencies.openExternal(url);
    return;
  }

  const browser = dependencies.browsers.find((candidate) => candidate.state === "ready");
  if (browser === undefined) throw new Error("The sidebar Browser is unavailable.");
  if (dependencies.sessionId === undefined || dependencies.sessionId.trim() === "") {
    throw new Error("A Session is required to open a sidebar Browser page.");
  }
  const pageId = await dependencies.openPage(browser.id, dependencies.sessionId, url);
  await dependencies.showBrowser(browser.id, pageId, dependencies.sessionId);
}

async function openExternalHttpUrl(url: string): Promise<void> {
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  if (desktop !== undefined) {
    await desktop.openExternal(url);
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened !== null) opened.opener = null;
}

function safeHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Link URL is invalid.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username.length > 0 || url.password.length > 0) {
    throw new Error("Only credential-free HTTP(S) links can be opened.");
  }
  return url.href;
}

export interface DesktopManagedRuntimeProbeDependencies {
  readonly getManagedStatus: () => Promise<JokoDesktopManagedOrchestratorStatus | undefined>;
  readonly probeOrigin: (origin: string) => Promise<{ readonly serverId: string }>;
  readonly readAuthKey: (profile: ConnectionProfile) => Promise<string | undefined>;
  readonly probeRuntime: (origin: string, authKey: string) => Promise<boolean>;
}

export async function probeDesktopManagedRuntimeActivity(
  dependencies: DesktopManagedRuntimeProbeDependencies
): Promise<boolean> {
  const initial = await dependencies.getManagedStatus();
  if (initial?.state === "disabled") return false;
  if (initial?.state !== "ready") throw new Error("The local Joko service runtime state is unavailable.");

  const profile = managedConnectionProfile(initial.connection, []);
  const identity = await dependencies.probeOrigin(profile.origin);
  if (identity.serverId !== profile.serverId) {
    throw new Error("The local Joko service identity changed before the runtime probe.");
  }
  await assertManagedProbeConnectionUnchanged(initial.connection, dependencies.getManagedStatus);

  let authKey = await dependencies.readAuthKey(profile);
  if (authKey === undefined || authKey.length === 0) {
    throw new Error("The local Joko service credential is unavailable.");
  }
  try {
    // Recheck after credential retrieval so a lifecycle handoff cannot send
    // the old bearer to a connection that Desktop no longer owns.
    await assertManagedProbeConnectionUnchanged(initial.connection, dependencies.getManagedStatus);
    const blocksShutdown = await dependencies.probeRuntime(profile.origin, authKey);
    // Discard even a successful answer when the owned runtime changed while
    // the RPC was in flight; only a stable owner probe can prove safety.
    await assertManagedProbeConnectionUnchanged(initial.connection, dependencies.getManagedStatus);
    return blocksShutdown;
  } finally {
    authKey = undefined;
  }
}

async function assertManagedProbeConnectionUnchanged(
  expected: JokoDesktopManagedOrchestratorConnection,
  getManagedStatus: () => Promise<JokoDesktopManagedOrchestratorStatus | undefined>
): Promise<void> {
  const current = await getManagedStatus();
  if (current?.state !== "ready" || !sameManagedOrchestratorConnection(current.connection, expected)) {
    throw new Error("The local Joko service changed during the runtime probe.");
  }
}

function sameManagedOrchestratorConnection(
  left: JokoDesktopManagedOrchestratorConnection,
  right: JokoDesktopManagedOrchestratorConnection
): boolean {
  return left.profileId === right.profileId
    && left.deviceId === right.deviceId
    && left.serverId === right.serverId
    && left.name === right.name
    && left.origin === right.origin;
}

export function managedConnectionProfile(
  value: JokoDesktopManagedOrchestratorConnection,
  persistedProfiles: readonly ConnectionProfile[]
): ConnectionProfile {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value.profileId)) throw new Error("Desktop returned an invalid local Joko connection profile.");
  if (value.deviceId.trim() === "" || value.deviceId.length > 128 || value.serverId.trim() === "" || value.serverId.length > 128) {
    throw new Error("Desktop returned an invalid local Joko service identity.");
  }
  const origin = normalizeOrchestratorOrigin(value.origin);
  if (!isLoopbackHostname(new URL(origin).hostname)) throw new Error("The local Joko service must use a loopback origin.");
  const previous = persistedProfiles.find((profile) => profile.id === value.profileId);
  return {
    id: value.profileId,
    deviceId: value.deviceId,
    serverId: value.serverId,
    name: value.name.trim().slice(0, 256) || "Local Joko",
    origin,
    managedLocal: true,
    ...(previous?.lastConnectedAt === undefined ? {} : { lastConnectedAt: previous.lastConnectedAt })
  };
}

export function automaticConnectionTargetForProfile(profile: ConnectionProfile): AutomaticConnectionTarget {
  return profile.managedLocal === true
    ? { kind: "managedLocal" }
    : { kind: "profile", profileId: profile.id };
}

export async function automaticConnectionPersistenceAvailable(): Promise<boolean> {
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  if (desktop === undefined) return persistentWebSecretEncryptionAvailable();
  try {
    return (await desktop.appInfo.get()).persistentCredentialStorage === true;
  } catch {
    return false;
  }
}

export function automaticConnectionProfile(
  target: AutomaticConnectionTarget | undefined,
  profiles: readonly ConnectionProfile[],
  managedStatus: JokoDesktopManagedOrchestratorStatus | undefined
): ConnectionProfile | undefined {
  if (target?.kind === "profile") {
    return profiles.find((profile) => profile.managedLocal !== true && profile.id === target.profileId);
  }
  if (target?.kind !== "managedLocal" || managedStatus?.state !== "ready") return undefined;
  return profiles.find((profile) => profile.managedLocal === true && profile.id === managedStatus.connection.profileId);
}

export function automaticConnectionTargetMatchesProfile(
  target: AutomaticConnectionTarget | undefined,
  profileId: string,
  profiles: readonly ConnectionProfile[]
): boolean {
  if (target?.kind === "profile") return target.profileId === profileId;
  return target?.kind === "managedLocal" && profiles.some((profile) => profile.id === profileId && profile.managedLocal === true);
}

export function automaticConnectionTargetMatchesDevice(
  target: AutomaticConnectionTarget | undefined,
  deviceId: string,
  profiles: readonly ConnectionProfile[]
): boolean {
  if (target?.kind === "profile") {
    return profiles.some((profile) => profile.id === target.profileId && profile.managedLocal !== true && profile.deviceId === deviceId);
  }
  return target?.kind === "managedLocal"
    && profiles.some((profile) => profile.managedLocal === true && profile.deviceId === deviceId);
}

export function profilesWithManagedConnection(
  profiles: readonly ConnectionProfile[],
  managedProfile: ConnectionProfile
): readonly ConnectionProfile[] {
  return [
    ...profiles.filter((profile) => profile.managedLocal !== true && profile.id !== managedProfile.id),
    managedProfile
  ];
}

export function pendingManagedAutomaticConnectionEligible(
  pending: boolean,
  connectionState: GatewayConnectionState,
  selectedProfile: ConnectionProfile | undefined
): boolean {
  return pending
    && connectionState === "disconnected"
    && (selectedProfile === undefined || selectedProfile.managedLocal === true);
}

export function automaticConnectionCommitCurrent(input: {
  readonly expectedGatewayGeneration: number;
  readonly currentGatewayGeneration: number;
  readonly expectedPreferenceIntent: number;
  readonly currentPreferenceIntent: number;
  readonly expectedProfileId: string;
  readonly activeProfileId: string | undefined;
  readonly connectionState: GatewayConnectionState;
}): boolean {
  return input.currentGatewayGeneration === input.expectedGatewayGeneration
    && input.currentPreferenceIntent === input.expectedPreferenceIntent
    && input.activeProfileId === input.expectedProfileId
    && input.connectionState === "connected";
}

export function managedOrchestratorStatusAfterExplicitPairing(
  adoption: JokoDesktopManagedOrchestratorStatus | undefined,
  profile: ConnectionProfile
): Extract<JokoDesktopManagedOrchestratorStatus, { readonly state: "ready" }> | undefined {
  return adoption?.state === "ready" &&
    adoption.connection.profileId !== profile.id && adoption.connection.deviceId === profile.deviceId &&
    adoption.connection.serverId === profile.serverId
    ? adoption
    : undefined;
}

async function readDesktopManagedOrchestratorStatus(): Promise<JokoDesktopManagedOrchestratorStatus | undefined> {
  const api = window.jokoDesktop?.managedOrchestrator;
  if (api === undefined) return undefined;
  try {
    return await api.getStatus();
  } catch {
    return { state: "retryableError", reason: "startFailed" };
  }
}

async function reconcileManagedConnection(
  local: LocalState,
  connection: JokoDesktopManagedOrchestratorConnection
): Promise<{ readonly profile: ConnectionProfile; readonly profiles: readonly ConnectionProfile[] }> {
  const persistedProfiles = await local.listProfiles();
  const profile = managedConnectionProfile(connection, persistedProfiles);
  const stale = persistedProfiles.filter((candidate) => candidate.managedLocal === true && candidate.id !== profile.id);
  await Promise.all(stale.map((candidate) => local.deleteProfile(candidate.id)));
  return {
    profile,
    profiles: [
      ...persistedProfiles.filter((candidate) => candidate.managedLocal !== true && candidate.id !== profile.id),
      profile
    ]
  };
}

async function tryAdoptRecoveredManagedConnection(
  profile: ConnectionProfile
): Promise<JokoDesktopManagedOrchestratorStatus | undefined> {
  const api = window.jokoDesktop?.managedOrchestrator;
  if (api === undefined) return undefined;
  let hostname: string;
  try {
    hostname = new URL(profile.origin).hostname;
  } catch {
    return undefined;
  }
  if (!isLoopbackHostname(hostname)) return undefined;
  try {
    const status = await api.getStatus();
    if (status.state !== "recoveryRequired") return undefined;
    return await api.adoptConnection({
      profileId: profile.id,
      deviceId: profile.deviceId,
      serverId: profile.serverId,
      name: "Local Joko",
      origin: profile.origin
    });
  } catch {
    // Pairing itself remains a valid normal Connection. A failed adoption must
    // not mutate managed metadata or turn that explicit owner action into a
    // silent bootstrap attempt.
    return undefined;
  }
}

function managedRecoveryStatus(
  reason: Extract<JokoDesktopManagedOrchestratorStatus, { readonly state: "recoveryRequired" }>["reason"]
): Extract<JokoDesktopManagedOrchestratorStatus, { readonly state: "recoveryRequired" }> {
  return { state: "recoveryRequired", reason };
}

async function collectDiscoveredOrchestratorNodes(signal: AbortSignal): Promise<readonly DiscoveredOrchestratorView[]> {
  const desktopScan = window.jokoDesktop?.discovery.scan();
  const rootSources = new Map<string, DiscoveredOrchestratorView["source"]>();
  const addRoot = (value: string, source: DiscoveredOrchestratorView["source"]): void => {
    try {
      rootSources.set(normalizeOrchestratorOrigin(value), source);
    } catch {
      // Discovery input is untrusted bootstrap metadata.
    }
  };
  if (["http:", "https:"].includes(window.location.protocol)) addRoot(window.location.origin, "current");
  const desktopAvailable = desktopScan !== undefined;
  if (desktopAvailable || ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) {
    addRoot("http://127.0.0.1:4318", "current");
    addRoot("http://localhost:4318", "current");
  }
  if (desktopScan !== undefined) {
    const advertised = await desktopScan.catch(() => [] as readonly JokoDesktopDiscoveredNode[]);
    for (const node of advertised.slice(0, 64)) addRoot(node.origin, "desktop");
  }
  if (signal.aborted) return [];
  const roots = [...rootSources.entries()].slice(0, 64);
  const attempts = await Promise.allSettled(roots.map(async ([origin, source]) => {
    const timeout = AbortSignal.timeout(2_000);
    const nodes = await discoverOrchestratorNodesAt(origin, AbortSignal.any([signal, timeout]));
    return nodes.map((node) => node.origin === origin ? { ...node, source } : node);
  }));
  if (signal.aborted) return [];
  const merged = attempts.flatMap((attempt) => attempt.status === "fulfilled" ? attempt.value : []);
  const byOrigin = new Map<string, DiscoveredOrchestratorView>();
  for (const node of merged) {
    const previous = byOrigin.get(node.origin);
    if (previous === undefined || node.lastSeenAt > previous.lastSeenAt || node.source === "current") byOrigin.set(node.origin, node);
  }
  return [...byOrigin.values()].sort((left, right) => {
    if (left.transport !== right.transport) return left.transport === "https" ? -1 : right.transport === "https" ? 1 : 0;
    return left.name.localeCompare(right.name) || left.origin.localeCompare(right.origin);
  });
}

const MAXIMUM_REMEMBERED_EXTENSION_UI_EFFECTS = 4_096;

export function rememberExtensionUiEffect(seen: Map<string, true>, scopedEventId: string): boolean {
  if (seen.has(scopedEventId)) return false;
  seen.set(scopedEventId, true);
  while (seen.size > MAXIMUM_REMEMBERED_EXTENSION_UI_EFFECTS) {
    const oldest = seen.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  return true;
}

export function clearTransientExtensionUiState(current: ControllerState): ControllerState {
  return {
    ...current,
    editorTextUpdate: undefined,
    extensionNotifications: []
  };
}

export function extensionUiRouteSessionId(route: AppRoute): string | undefined {
  return route.kind === "session" || route.kind === "files" ? route.sessionId : undefined;
}

export function extensionOsNotificationTitle(kind: ExtensionNotificationKind): string {
  return kind === "error" ? "Joko · Error" : kind === "warning" ? "Joko · Warning" : "Joko";
}

export function applyExtensionUiEffect(
  effect: ExtensionUiEffect,
  local: LocalState | undefined,
  setState: (update: (current: ControllerState) => ControllerState) => void,
  options: {
    readonly activeSessionId?: string;
    readonly isCurrent?: () => boolean;
    readonly isLatestEditorEffect?: () => boolean;
  } = {}
): void {
  const isCurrent = options.isCurrent ?? (() => true);
  if (!isCurrent()) return;
  if (effect.kind === "notification") {
    setState((current) => isCurrent() ? ({
      ...current,
      extensionNotifications: [
        ...current.extensionNotifications.filter((notification) => notification.eventId !== effect.eventId),
        { eventId: effect.eventId, sessionId: effect.sessionId, text: effect.text, kind: effect.notificationKind }
      ].slice(-3)
    }) : current);
    window.setTimeout(() => {
      if (!isCurrent()) return;
      setState((current) => isCurrent() ? ({
        ...current,
        extensionNotifications: current.extensionNotifications.filter((notification) => notification.eventId !== effect.eventId)
      }) : current);
    }, 10_000);
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(extensionOsNotificationTitle(effect.notificationKind), {
        body: effect.text,
        tag: effect.eventId
      });
    }
    return;
  }
  if (effect.kind === "title") {
    if (options.activeSessionId !== effect.sessionId) return;
    document.title = effect.text.trim().length === 0 ? "Joko" : `${effect.text.trim()} · Joko`;
    return;
  }
  setState((current) => isCurrent() ? ({
    ...current,
    editorTextUpdate: {
      eventId: effect.eventId,
      sessionId: effect.sessionId,
      text: effect.text
    }
  }) : current);
  if (local !== undefined) {
    void local.readDraft(effect.sessionId).then((draft) => {
      if (!isCurrent() || options.isLatestEditorEffect?.() === false) return undefined;
      return local.saveDraft(effect.sessionId, composerDraftWithEditorText(effect.text, draft));
    })
      .catch(() => {
        if (!isCurrent() || options.isLatestEditorEffect?.() === false) return;
        const suffix = ":editor-draft-persistence-error";
        applyExtensionUiEffect({
          eventId: `${effect.eventId.slice(0, 512 - suffix.length)}${suffix}`,
          sessionId: effect.sessionId,
          kind: "notification",
          notificationKind: "error",
          text: "The editor text was updated but could not be saved. Copy it before leaving this task."
        }, undefined, setState, { isCurrent });
      });
  }
}

export function composerDraftWithEditorText(text: string, draft: ComposerDraft | undefined): ComposerDraft {
  const editorDocument = draft?.editorDocument === undefined
    ? undefined
    : appendTextToComposerDocument(composerDocumentKeepingQuotes(draft.editorDocument), text);
  return {
    text,
    attachments: draft?.attachments ?? [],
    ...(draft?.browserComments === undefined ? {} : { browserComments: draft.browserComments }),
    mentions: draft?.mentions ?? [],
    ...(editorDocument === undefined ? {} : { editorDocument }),
    deliveryMode: draft?.deliveryMode ?? "prompt",
    ...(draft?.extraDirectoryIds === undefined ? {} : { extraDirectoryIds: draft.extraDirectoryIds })
  };
}

export function newSessionDraftScope(profile: ConnectionProfile): string {
  return `${profile.serverId}\u0000${profile.id}`;
}

function requireActiveProfile(profile: ConnectionProfile | undefined): ConnectionProfile {
  if (profile === undefined) throw new Error("Connect to a Joko node before saving a new-task draft.");
  return profile;
}

function routeFromLocation(): AppRoute {
  return routeFromHash(window.location.hash);
}

export function routeFromHash(hash: string): AppRoute {
  const files = parseWorkspaceFilesHash(hash);
  if (files !== undefined) return { kind: "files", ...files };
  const normalized = hash.replace(/^#\/?/, "");
  const queryIndex = normalized.indexOf("?");
  const path = queryIndex < 0 ? normalized : normalized.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex < 0 ? "" : normalized.slice(queryIndex + 1));
  const parts = path.split("/").filter(Boolean).map(decodeHashComponent);
  if (parts[0] === "schedules") {
    const scheduleId = query.get("focus")?.trim();
    return {
      kind: "schedules",
      ...(scheduleId === undefined || scheduleId === "" ? {} : { scheduleId })
    };
  }
  if (parts[0] === "projects") return { kind: "projects", ...(parts[1] === undefined ? {} : { projectId: parts[1] }) };
  if (parts[0] === "tools") return { kind: "tools" };
  if (parts[0] === "settings") return { kind: "settings" };
  if (parts[0] === "tasks" && parts[1] === "new") {
    const targetId = query.get("target")?.trim();
    const dialogueBackendId = query.get("dialogue")?.trim();
    return {
      kind: "newSession",
      ...(targetId === undefined || targetId === "" ? {} : { targetId }),
      ...(targetId !== undefined && targetId !== "" || dialogueBackendId === undefined || dialogueBackendId === "" ? {} : { dialogueBackendId })
    };
  }
  if (parts[0] !== "tasks") return { kind: "session" };
  const messageId = query.get("message")?.trim();
  const messageEventId = query.get("event")?.trim();
  const profileId = query.get("profile")?.trim();
  if (parts[1] === undefined) {
    return {
      kind: "session",
      ...(profileId === undefined || profileId === "" ? {} : { profileId })
    };
  }
  return {
    kind: "session",
    sessionId: parts[1],
    ...(profileId === undefined || profileId === "" ? {} : { profileId }),
    ...(messageId === undefined || messageId === "" ? {} : { messageId }),
    ...(messageEventId === undefined || messageEventId === "" ? {} : { messageEventId })
  };
}

export function sessionRouteHash(route: Extract<AppRoute, { readonly kind: "session" }>): string {
  const query = new URLSearchParams();
  if (route.messageEventId !== undefined) query.set("event", route.messageEventId);
  if (route.messageId !== undefined) query.set("message", route.messageId);
  if (route.profileId !== undefined) query.set("profile", route.profileId);
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  if (route.sessionId === undefined) return `#/tasks/${suffix}`;
  return `#/tasks/${encodeURIComponent(route.sessionId)}${suffix}`;
}

export function appRouteHash(route: AppRoute): string {
  if (route.kind === "session") return sessionRouteHash(route);
  if (route.kind === "files") return workspaceFilesHash(route);
  if (route.kind === "newSession") {
    const query = new URLSearchParams();
    if (route.targetId !== undefined) query.set("target", route.targetId);
    else if (route.dialogueBackendId !== undefined) query.set("dialogue", route.dialogueBackendId);
    return `#/tasks/new${query.size === 0 ? "" : `?${query.toString()}`}`;
  }
  if (route.kind === "projects") return route.projectId === undefined ? "#/projects" : `#/projects/${encodeURIComponent(route.projectId)}`;
  if (route.kind === "schedules") {
    const query = new URLSearchParams();
    if (route.scheduleId !== undefined) query.set("focus", route.scheduleId);
    return `#/schedules${query.size === 0 ? "" : `?${query.toString()}`}`;
  }
  return `#/${route.kind}`;
}

function decodeHashComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sameOrchestratorOrigin(left: string, right: string): boolean {
  try {
    return normalizeOrchestratorOrigin(left) === normalizeOrchestratorOrigin(right);
  } catch {
    return false;
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  applyFavicon(dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0d0d0d" : "#f2f2f2");
}

export function trustedReusablePairingProfiles(
  profiles: readonly ConnectionProfile[],
  origin: string,
  serverId: string
): readonly ConnectionProfile[] {
  return profiles
    .filter((profile) => profile.managedLocal !== true
      && profile.serverId === serverId
      && sameOrchestratorOrigin(profile.origin, origin))
    .sort((left, right) => (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0));
}

function applyFavicon(dark: boolean): void {
  const link = document.querySelector<HTMLLinkElement>("#joko-favicon");
  const request = ++faviconRequest;
  const iconUrl = dark ? DARK_APP_ICON_URL : LIGHT_APP_ICON_URL;
  if (link !== null) {
    link.type = "image/svg+xml";
    link.href = iconUrl;
  }
  const desktop = window.jokoDesktop;
  if (desktop === undefined) return;
  const icon = new Image();
  icon.decoding = "async";
  icon.onload = () => {
    if (request !== faviconRequest) return;
    const canvas = document.createElement("canvas");
    canvas.width = FAVICON_SIZE;
    canvas.height = FAVICON_SIZE;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(icon, 0, 0, FAVICON_SIZE, FAVICON_SIZE);
    const dataUrl = canvas.toDataURL("image/png");
    void desktop.setTrayIcon(dataUrl).catch(() => undefined);
  };
  icon.src = iconUrl;
}

function requireLocal(value: LocalState | undefined): LocalState {
  if (value === undefined) throw new Error("Local UI state is not ready.");
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

export type { InteractionView, PermissionMode };
