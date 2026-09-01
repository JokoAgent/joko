import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { AppWithController } from "../App.js";
import { automaticConnectionTargetForProfile } from "../controller.js";
import type { AppController, AppRoute, ControllerState } from "../controller.js";
import {
  DEFAULT_UI_PREFERENCES,
  personalizationPromptForOwner,
  withPersonalizationPrompt,
  type ComposerSendShortcutPreference
} from "../local-state.js";
import { withAppShortcutOverride } from "../app-shortcuts.js";
import type { NavigationLayout } from "../navigation-layout.js";
import { emptySnapshot } from "../model.js";
import { workspaceFilesHash } from "../workspace-files-navigation.js";
import type {
  AppSnapshot,
  BackendView,
  ComposerDraft,
  InteractionResolutionDraft,
  InteractionView,
  NewSessionDraft,
  PermissionMode,
  ProviderLoginFlowView,
  ScheduleDeletionResultView,
  SchedulerRuntimeView,
  ScheduleView,
  SessionView,
  SubagentCapabilitiesView,
  SubagentChildRunView,
  SubagentControlActionView,
  SubagentRunDetailView,
  SubagentRunPageView,
  SubagentRunStateView,
  SubagentRunView,
  SubagentTranscriptEntryView,
  SubagentTranscriptPageView,
  Theme,
  WorkspaceEntryDeleteDraft,
  WorkspaceEntryMoveDraft,
  WorkspaceEntryMutationDraft,
  WorkspaceEntryPageView,
  WorkspaceEntryView,
  WorkspaceFileChangeScopeView,
  WorkspaceFilePreviewView,
  WorkspaceSearchPageView,
  WorkspaceSearchRequestView,
  WorkspaceTextFileWriteDraft,
  WorkspaceTextFileWriteResultView
} from "../model.js";
import { workspaceOpenTabsStore } from "../workspace-open-tabs.js";
import { applyAppearanceTypography, clampCodeSize, clampUiSize, normalizeFontFamily } from "../appearance-settings.js";

const FIXED_NOW = Date.UTC(2026, 7, 22, 4, 0, 0);
const VISUAL_WORKSPACE_ID = "visual-workspace";
const VISUAL_SUBAGENT_SESSION_ID = "session-1";
const VISUAL_SUBAGENT_ROOT_ID = "visual-subagent-orchestrator";
const VISUAL_SUBAGENT_LIST_PAGE_SIZE = 2;
const VISUAL_SUBAGENT_TRANSCRIPT_PAGE_SIZE = 3;

/**
 * Credential-free, memory-only visual QA surface. `main.tsx` imports this
 * module only behind `import.meta.env.DEV` and the exact harness pathname.
 */
export function VisualHarness(): JSX.Element {
  const scenario = useMemo(() => harnessParameters(), []);
  const files = useMemo(() => new VisualWorkspaceFiles(), []);
  const subagents = useMemo(() => new VisualSubagentFixture(), []);
  const drafts = useRef(new Map<string, ComposerDraft>());
  const providerLoginFlows = useRef(new Map<string, ProviderLoginFlowView>());
  const sequence = useRef(100);
  const [state, setState] = useState<ControllerState>(() => initialControllerState(scenario, files));
  const automationSettingsEnteredRef = useRef(false);

  useEffect(() => {
    if (scenario.scenario !== "automation" || automationSettingsEnteredRef.current) return;
    automationSettingsEnteredRef.current = true;
    setState((current) => ({ ...current, route: { kind: "settings" } }));
  }, [scenario.scenario]);

  useEffect(() => {
    document.documentElement.dataset.theme = state.preferences.theme;
    document.documentElement.lang = state.preferences.locale;
    document.documentElement.dataset.visualHarness = scenario.scenario;
    return () => {
      delete document.documentElement.dataset.visualHarness;
      delete document.documentElement.dataset.harnessLastAction;
    };
  }, [scenario.scenario, state.preferences.locale, state.preferences.theme]);

  useEffect(() => {
    applyAppearanceTypography(state.preferences, [document.documentElement, document.body]);
  }, [state.preferences.codeFamily, state.preferences.codeSize, state.preferences.uiFamily, state.preferences.uiSize]);

  useEffect(() => {
    if (scenario.scenario !== "files") return;
    // Keep the visual fixture independent from tabs left by an earlier run.
    workspaceOpenTabsStore.closeTabs(
      VISUAL_WORKSPACE_ID,
      workspaceOpenTabsStore.getTabs(VISUAL_WORKSPACE_ID)
    );
    // Seed a second real tab through the same store used by the production
    // Files route. The active App.tsx tab is added from the URL selection.
    workspaceOpenTabsStore.addTab(VISUAL_WORKSPACE_ID, "README.md");
    workspaceOpenTabsStore.addTab(VISUAL_WORKSPACE_ID, "src/App.tsx");
  }, [scenario.scenario]);

  useEffect(() => () => files.disposeArtifactUrls(), [files]);

  const record = (action: string): void => {
    document.documentElement.dataset.harnessLastAction = action;
  };
  const updateSnapshot = (change: (snapshot: AppSnapshot) => AppSnapshot): void => {
    setState((current) => ({ ...current, snapshot: change(current.snapshot) }));
  };
  const updateSession = (sessionId: string, change: (session: SessionView) => SessionView): void => {
    updateSnapshot((snapshot) => ({
      ...snapshot,
      sessions: snapshot.sessions.map((session) => session.id === sessionId ? change(session) : session)
    }));
  };
  const updateSchedule = (scheduleId: string, change: (schedule: ScheduleView) => ScheduleView): void => {
    updateSnapshot((snapshot) => ({
      ...snapshot,
      schedules: snapshot.schedules.map((schedule) => schedule.id === scheduleId ? change(schedule) : schedule)
    }));
  };
  const syncWorkspaceFiles = (): void => {
    updateSnapshot((snapshot) => ({
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => workspace.id === VISUAL_WORKSPACE_ID
        ? {
            ...workspace,
            revision: files.workspaceRevision,
            dirty: true,
            entries: files.list("")
          }
        : workspace)
    }));
  };

  const controller = useMemo(() => {
    const implemented = {
      state,
      connect: async (profile, options): Promise<void> => {
        record(`connection-connect:${profile.id}:${options?.automatic === true ? "automatic" : "current"}`);
      },
      pair: async (_origin, _code, _deviceName, options): Promise<void> => {
        record(`connection-pair:${options?.automatic === true ? "automatic" : "current"}`);
      },
      forgetProfile: async (profileId): Promise<void> => {
        record(`connection-forget:${profileId}`);
        setState((current) => ({
          ...current,
          profiles: current.profiles.filter((profile) => profile.id !== profileId)
        }));
      },
      refreshDiscoveredNodes: async (): Promise<void> => {
        record("connection-discovery-refresh");
      },
      navigate: (route: AppRoute): void => {
        record(`navigate:${route.kind}${route.kind === "session" && route.sessionId !== undefined ? `:${route.sessionId}` : ""}`);
        if (route.kind === "files" && route.sessionId !== undefined) {
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${workspaceFilesHash({
            sessionId: route.sessionId,
            ...(route.file === undefined ? {} : { file: route.file }),
            ...(route.search === undefined ? {} : { search: route.search }),
            ...(route.line === undefined ? {} : { line: route.line })
          })}`);
        }
        setState((current) => ({ ...current, route }));
      },
      refresh: async (): Promise<void> => { record("refresh"); },
      beginProviderLogin: async (_backendId, providerId, method): Promise<ProviderLoginFlowView> => {
        const now = FIXED_NOW + sequence.current++;
        const id = `visual-provider-login-${sequence.current}`;
        const flow: ProviderLoginFlowView = {
          id,
          providerId,
          method,
          state: "pending",
          updatedAt: now,
          expiresAt: now + 10 * 60_000,
          ...(method === "apiKey"
            ? {
                pendingPrompt: {
                  id: `${id}-credential`,
                  kind: "secret" as const,
                  message: "Enter the Provider API key.",
                  placeholder: "",
                  options: []
                }
              }
            : { verificationUri: "https://example.test/authorize" })
        };
        providerLoginFlows.current.set(id, flow);
        record(`provider-login:begin:${providerId}:${method}`);
        return flow;
      },
      getProviderLoginFlow: async (loginFlowId): Promise<ProviderLoginFlowView> => {
        const flow = providerLoginFlows.current.get(loginFlowId);
        if (flow === undefined) throw new Error("Provider login flow not found.");
        return flow;
      },
      submitProviderLoginInput: async (flow): Promise<ProviderLoginFlowView> => {
        const current = providerLoginFlows.current.get(flow.id);
        if (current === undefined || current.pendingPrompt === undefined) {
          throw new Error("Provider login input is not pending.");
        }
        const { pendingPrompt: _pendingPrompt, error: _error, ...base } = current;
        const completed: ProviderLoginFlowView = {
          ...base,
          state: "completed",
          updatedAt: FIXED_NOW + sequence.current++
        };
        providerLoginFlows.current.set(completed.id, completed);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          providers: snapshot.providers.map((provider) =>
            provider.backendId === "visual-pi" && provider.id === completed.providerId
              ? { ...provider, authenticationState: "authenticated", routingEnabled: true }
              : provider),
          models: snapshot.models.map((model) =>
            model.backendId === "visual-pi" && model.providerId === completed.providerId
              ? { ...model, available: true, routingEnabled: true }
              : model),
          settings: {
            ...snapshot.settings,
            providers: snapshot.settings.providers.map((provider) =>
              provider.id === completed.providerId ? { ...provider, enabled: true } : provider)
          }
        }));
        record(`provider-login:completed:${completed.providerId}`);
        return completed;
      },
      cancelProviderLogin: async (loginFlowId): Promise<ProviderLoginFlowView> => {
        const current = providerLoginFlows.current.get(loginFlowId);
        if (current === undefined) throw new Error("Provider login flow not found.");
        const { pendingPrompt: _pendingPrompt, error: _error, ...base } = current;
        const cancelled: ProviderLoginFlowView = {
          ...base,
          state: "cancelled",
          updatedAt: FIXED_NOW + sequence.current++
        };
        providerLoginFlows.current.set(cancelled.id, cancelled);
        record(`provider-login:cancelled:${cancelled.providerId}`);
        return cancelled;
      },
      disconnect: async (): Promise<void> => { record("disconnect"); },
      retryManagedOrchestrator: async (): Promise<void> => { record("retry-managed"); },
      getVoiceInputCapabilities: async () => ({
        support: "supported" as const,
        limits: {
          supportedMimeTypes: ["audio/pcm"],
          maximumAudioChunkBytes: 1_048_576,
          maximumAudioBytes: 67_108_864,
          maximumAudioChunkDurationMs: 10_000,
          maximumAudioDurationMs: 600_000,
          maximumLocaleCharacters: 35,
          stableWaitMs: 500,
          maximumConcurrentSessions: 8
        },
        supportsLocale: true,
        supportsLiveDrafts: true,
        supportsRefinement: true
      }),
      testVoiceInputConnection: async () => ({ ok: true } as const),
      cancelAutomaticConnectionAttempt: (): void => { record("cancel-automatic-attempt"); },
      setAutomaticConnectionEnabled: async (enabled: boolean): Promise<void> => {
        if (enabled && state.activeProfile === undefined) throw new Error("The visual Orchestrator owner is unavailable.");
        record(`automatic-connection:${enabled ? "on" : "off"}`);
        setState((current) => ({
          ...current,
          preferences: {
            ...current.preferences,
            automaticConnectionTarget: enabled && current.activeProfile !== undefined
              ? automaticConnectionTargetForProfile(current.activeProfile)
              : undefined
          }
        }));
      },
      setLocale: async (locale: ControllerState["preferences"]["locale"]): Promise<void> => {
        setState((current) => ({ ...current, preferences: { ...current.preferences, locale } }));
      },
      setTheme: async (theme: Theme): Promise<void> => {
        setState((current) => ({ ...current, preferences: { ...current.preferences, theme } }));
      },
      setUiFamily: async (uiFamily: string): Promise<void> => {
        setState((current) => ({ ...current, preferences: { ...current.preferences, uiFamily: normalizeFontFamily(uiFamily) } }));
      },
      setCodeFamily: async (codeFamily: string): Promise<void> => {
        setState((current) => ({ ...current, preferences: { ...current.preferences, codeFamily: normalizeFontFamily(codeFamily) } }));
      },
      setUiSize: async (uiSize: number): Promise<void> => {
        setState((current) => ({ ...current, preferences: { ...current.preferences, uiSize: clampUiSize(uiSize) } }));
      },
      setCodeSize: async (codeSize: number): Promise<void> => {
        setState((current) => ({ ...current, preferences: { ...current.preferences, codeSize: clampCodeSize(codeSize) } }));
      },
      setComposerSendShortcut: async (composerSendShortcut: ComposerSendShortcutPreference): Promise<void> => {
        setState((current) => ({ ...current, preferences: { ...current.preferences, composerSendShortcut } }));
      },
      setMessageSearchSort: async (messageSearchSort: ControllerState["preferences"]["messageSearchSort"]): Promise<void> => {
        setState((current) => ({ ...current, preferences: { ...current.preferences, messageSearchSort } }));
      },
      setMessageNavRailEnabled: async (messageNavRailEnabled: boolean): Promise<void> => {
        record(`message-nav-rail:${messageNavRailEnabled ? "on" : "off"}`);
        setState((current) => ({ ...current, preferences: { ...current.preferences, messageNavRailEnabled } }));
      },
      resetMessageNavRailEnabled: async (): Promise<void> => {
        record("message-nav-rail:reset");
        setState((current) => ({ ...current, preferences: { ...current.preferences, messageNavRailEnabled: true } }));
      },
      getPersonalizationPrompt: (): string => personalizationPromptForOwner(
        state.preferences.personalizationPrompts,
        state.activeProfile?.serverId
      ),
      setPersonalizationPrompt: async (value: string): Promise<void> => {
        const ownerId = state.activeProfile?.serverId;
        if (ownerId === undefined) throw new Error("The visual Orchestrator owner is unavailable.");
        record("personalization-prompt:set");
        setState((current) => ({
          ...current,
          preferences: {
            ...current.preferences,
            personalizationPrompts: withPersonalizationPrompt(current.preferences.personalizationPrompts, ownerId, value)
          }
        }));
      },
      resetPersonalizationPrompt: async (): Promise<void> => {
        const ownerId = state.activeProfile?.serverId;
        if (ownerId === undefined) throw new Error("The visual Orchestrator owner is unavailable.");
        record("personalization-prompt:reset");
        setState((current) => ({
          ...current,
          preferences: {
            ...current.preferences,
            personalizationPrompts: withPersonalizationPrompt(current.preferences.personalizationPrompts, ownerId, "")
          }
        }));
      },
      updateMemorySettings: async (patch: {
        readonly makerEnabled?: boolean;
        readonly backendId?: string;
        readonly backendEnabled?: boolean;
      }): Promise<void> => {
        record("memory:update");
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            memory: {
              ...snapshot.settings.memory,
              ...(patch.makerEnabled === undefined ? {} : { makerEnabled: patch.makerEnabled }),
              customized: true,
              backends: snapshot.settings.memory.backends.map((backend) =>
                patch.backendId === backend.backendId && patch.backendEnabled !== undefined
                  ? { ...backend, enabled: patch.backendEnabled }
                  : backend)
            }
          }
        }));
      },
      restoreMemoryDefaults: async (): Promise<void> => {
        record("memory:defaults");
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            memory: {
              ...snapshot.settings.memory,
              makerEnabled: true,
              customized: false,
              backends: snapshot.settings.memory.backends.map((backend) => ({ ...backend, enabled: true }))
            }
          }
        }));
      },
      resetMemory: async (scope: "curated" | "backend", backendId?: string): Promise<{
        readonly removedEntries: number;
        readonly removedTargets: number;
      }> => {
        const current = state.snapshot.settings.memory;
        const digestEntries = current.backends.reduce((total, backend) => total + backend.entryCount, 0);
        const removedEntries = scope === "curated"
          ? Math.max(0, current.entryCount - digestEntries)
          : current.backends.find((backend) => backend.backendId === backendId)?.entryCount ?? 0;
        record(`memory:reset:${scope}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            memory: {
              ...snapshot.settings.memory,
              entryCount: scope === "curated" ? digestEntries : Math.max(0, snapshot.settings.memory.entryCount - removedEntries),
              backends: snapshot.settings.memory.backends.map((backend) =>
                scope === "backend" && backend.backendId === backendId ? { ...backend, entryCount: 0 } : backend)
            }
          }
        }));
        return { removedEntries, removedTargets: 1 };
      },
      updateVisionBridgeSettings: async (patch: Parameters<AppController["updateVisionBridgeSettings"]>[0]): Promise<void> => {
        record("vision-bridge:update");
        updateSnapshot((snapshot) => {
          const defaults = snapshot.models
            .filter((model) => model.inputModalities.length > 0 && !model.inputModalities.includes("image"))
            .map((model) => ({ backendId: model.backendId, providerId: model.providerId, modelId: model.modelId }));
          const current = snapshot.settings.visionBridge;
          const next = patch.resetAll === true
            ? {
                ...current,
                enabled: false,
                targetModels: defaults,
                primary: undefined,
                fallback: undefined,
                customized: false,
                customizedFields: []
              }
            : {
                ...current,
                ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
                ...(patch.targetModels === undefined ? {} : { targetModels: patch.targetModels }),
                ...(patch.primary === undefined ? {} : { primary: patch.primary ?? undefined }),
                ...(patch.fallback === undefined ? {} : { fallback: patch.fallback ?? undefined }),
                ...(patch.resetTargetModels === true ? { targetModels: defaults } : {}),
                customized: true
              };
          return { ...snapshot, settings: { ...snapshot.settings, visionBridge: next } };
        });
      },
      updatePromptRecommendationSettings: async (enabled: boolean): Promise<void> => {
        record(`prompt-recommendation:${enabled ? "on" : "off"}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            promptRecommendation: { ...snapshot.settings.promptRecommendation, enabled, customized: true }
          }
        }));
      },
      resetPromptRecommendationSettings: async (): Promise<void> => {
        record("prompt-recommendation:reset");
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            promptRecommendation: { ...snapshot.settings.promptRecommendation, enabled: true, customized: false }
          }
        }));
      },
      updateLanguageToolSettings: async (enabled: boolean): Promise<void> => {
        record(`language-tools:${enabled ? "on" : "off"}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: { ...snapshot.settings, languageTools: { enabled } }
        }));
      },
      predictNextPrompt: async (): Promise<string> => "Run the focused regression tests next.",
      setSilentEncryptedRetryEnabled: async (enabled: boolean): Promise<void> => {
        record(`silent-encrypted-retry:${enabled ? "on" : "off"}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            personalization: {
              ...snapshot.settings.personalization,
              silentEncryptedRetryEnabled: enabled,
              silentEncryptedRetryCustomized: true
            }
          }
        }));
      },
      resetSilentEncryptedRetry: async (): Promise<void> => {
        record("silent-encrypted-retry:reset");
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            personalization: {
              ...snapshot.settings.personalization,
              silentEncryptedRetryEnabled: true,
              silentEncryptedRetryCustomized: false
            }
          }
        }));
      },
      setSessionRuntimeFallbackEnabled: async (enabled: boolean): Promise<void> => {
        record(`session-runtime-fallback:${enabled ? "on" : "off"}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            personalization: {
              ...snapshot.settings.personalization,
              sessionRuntimeFallbackEnabled: enabled,
              sessionRuntimeFallbackCustomized: true
            }
          }
        }));
      },
      resetSessionRuntimeFallback: async (): Promise<void> => {
        record("session-runtime-fallback:reset");
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            personalization: {
              ...snapshot.settings.personalization,
              sessionRuntimeFallbackEnabled: false,
              sessionRuntimeFallbackCustomized: false
            }
          }
        }));
      },
      setLinkOpenPreference: async (linkOpenPreference: ControllerState["preferences"]["linkOpenPreference"]): Promise<void> => {
        record(`link-open:${linkOpenPreference}`);
        setState((current) => ({ ...current, preferences: { ...current.preferences, linkOpenPreference } }));
      },
      resetLinkOpenPreference: async (): Promise<void> => {
        record("link-open:reset");
        setState((current) => ({ ...current, preferences: { ...current.preferences, linkOpenPreference: "sidebar" } }));
      },
      setStreamFadeEnabled: async (streamFadeEnabled: boolean): Promise<void> => {
        record(`stream-fade:${streamFadeEnabled ? "on" : "off"}`);
        setState((current) => ({ ...current, preferences: { ...current.preferences, streamFadeEnabled } }));
      },
      resetStreamFadeEnabled: async (): Promise<void> => {
        record("stream-fade:reset");
        setState((current) => ({ ...current, preferences: { ...current.preferences, streamFadeEnabled: true } }));
      },
      openHttpLink: async (url: string, options?: { readonly forceExternal?: boolean; readonly forceSidebar?: boolean; readonly sessionId?: string }): Promise<void> => {
        const destination = options?.forceExternal === true
          ? "external"
          : options?.forceSidebar === true ? "sidebar" : state.preferences.linkOpenPreference;
        record(`open-link:${destination}:${new URL(url).origin}`);
        if (destination === "external") return;
        const browser = state.snapshot.browsers.find((candidate) => candidate.state === "ready");
        const sessionId = options?.sessionId;
        if (browser === undefined) throw new Error("The sidebar Browser is unavailable.");
        if (sessionId === undefined || sessionId.trim() === "") throw new Error("A Session is required to open a sidebar Browser page.");
        const pageId = `visual-link-${sequence.current++}`;
        setState((current) => ({
          ...current,
          route: { kind: "session", sessionId },
          preferences: { ...current.preferences, inspectorOpen: true },
          browserInspectorFocusRequest: { sessionId, browserId: browser.id, pageId, requestId: sequence.current++ },
          snapshot: {
            ...current.snapshot,
            browsers: current.snapshot.browsers.map((candidate) => candidate.id === browser.id ? {
              ...candidate,
              activePageId: pageId,
              pages: [...candidate.pages, {
                id: pageId,
                title: new URL(url).hostname,
                url,
                state: "ready",
                canGoBack: false,
                canGoForward: false,
                recoverable: false,
                lastKnownGeneration: candidate.generation,
                lastActivityAt: FIXED_NOW
              }]
            } : candidate)
          }
        }));
      },
      setAppShortcutOverride: async (id: Parameters<AppController["setAppShortcutOverride"]>[0], value: Parameters<AppController["setAppShortcutOverride"]>[1]): Promise<void> => {
        setState((current) => ({
          ...current,
          preferences: {
            ...current.preferences,
            appShortcutOverrides: withAppShortcutOverride(current.preferences.appShortcutOverrides, id, value)
          }
        }));
      },
      resetAppShortcutOverrides: async (): Promise<void> => {
        setState((current) => ({
          ...current,
          preferences: {
            ...current.preferences,
            appShortcutOverrides: {}
          }
        }));
      },
      setInspectorOpen: async (inspectorOpen: boolean): Promise<void> => {
        setState((current) => ({ ...current, preferences: { ...current.preferences, inspectorOpen } }));
      },
      setNavigationOpen: async (navigationOpen: boolean): Promise<void> => {
        setState((current) => ({
          ...current,
          preferences: {
            ...current.preferences,
            navigationOpen,
            navigationMode: navigationOpen ? "expanded" : "hidden"
          }
        }));
      },
      setNavigationLayout: async ({ mode, width }: NavigationLayout): Promise<void> => {
        setState((current) => ({
          ...current,
          preferences: {
            ...current.preferences,
            navigationOpen: mode !== "hidden",
            navigationMode: mode,
            navigationWidth: width
          }
        }));
      },
      dismissExtensionNotification: (): void => undefined,
      readDraft: async (sessionId: string): Promise<ComposerDraft | undefined> => drafts.current.get(sessionId),
      saveDraft: async (sessionId: string, draft: ComposerDraft): Promise<void> => {
        drafts.current.set(sessionId, draft);
      },
      send: async (sessionId: string, draft: ComposerDraft): Promise<void> => {
        record(`send:${sessionId}:${draft.deliveryMode}`);
        updateSnapshot((snapshot) => {
          const current = snapshot.timelineBySession.get(sessionId) ?? [];
          const timelineBySession = new Map(snapshot.timelineBySession);
          timelineBySession.set(sessionId, [...current, {
            id: `harness-message-${sequence.current}`,
            sequence: BigInt(sequence.current++),
            kind: "user" as const,
            createdAt: FIXED_NOW,
            text: draft.text
          }]);
          return { ...snapshot, timelineBySession };
        });
      },
      reobserveReview: async (reviewRunId: string): Promise<void> => {
        record(`review:reobserve:${reviewRunId}`);
        updateSnapshot((snapshot) => {
          const reviewRuns = snapshot.reviewRuns.map((review) => review.id === reviewRunId
            ? { ...review, freshness: "current" as const, freshnessCheckedAt: FIXED_NOW, revision: review.revision + 1n }
            : review);
          const timelineBySession = new Map(snapshot.timelineBySession);
          for (const [sessionId, items] of timelineBySession) {
            timelineBySession.set(sessionId, items.map((item) => item.review?.id === reviewRunId
              ? { ...item, review: { ...item.review, freshness: "current" as const, freshnessCheckedAt: FIXED_NOW, revision: item.review.revision + 1n } }
              : item));
          }
          return { ...snapshot, reviewRuns, timelineBySession };
        });
      },
      setPermission: async (sessionId: string, mode: PermissionMode): Promise<void> => {
        record(`permission:${sessionId}:${mode}`);
        updateSession(sessionId, (session) => ({ ...session, permissionMode: mode }));
      },
      setPlanMode: async (sessionId: string, enabled: boolean): Promise<void> => {
        updateSession(sessionId, (session) => ({ ...session, planMode: enabled }));
      },
      setModel: async (sessionId: string, providerId: string, modelId: string, effort: string | undefined, fastMode: boolean): Promise<void> => {
        updateSession(sessionId, (session) => ({ ...session, effort, fastMode, model: state.snapshot.models.find((model) => model.providerId === providerId && model.modelId === modelId) ?? session.model }));
      },
      updateBackendSettings: async (backendId: string, patch: Parameters<AppController["updateBackendSettings"]>[1]): Promise<void> => {
        const access = patch.modelAccessUpdate;
        record(`backend-settings:${backendId}${access === undefined ? "" : `:${access.providerId}:${access.modelId ?? "provider"}:${access.enabled ? "on" : "off"}`}`);
        if (access === undefined) return;
        updateSnapshot((snapshot) => {
          const current = snapshot.settings.backendSettings.find((settings) => settings.backendId === backendId) ?? {
            backendId,
            enabled: true,
            permissionMode: "ask" as const,
            planMode: false
          };
          const disabledProviderIds = new Set(current.modelAccess?.disabledProviderIds ?? []);
          const disabledModels = new Map<string, { providerId: string; modelId: string }>((current.modelAccess?.disabledModels ?? []).map((model) => [
            `${model.providerId}\u0000${model.modelId}`,
            model
          ] as const));
          if (access.modelId === undefined) {
            if (access.enabled) disabledProviderIds.delete(access.providerId);
            else disabledProviderIds.add(access.providerId);
          } else {
            const key = `${access.providerId}\u0000${access.modelId}`;
            if (access.enabled) disabledModels.delete(key);
            else disabledModels.set(key, { providerId: access.providerId, modelId: access.modelId });
          }
          const nextBackendSettings = snapshot.settings.backendSettings.filter((settings) => settings.backendId !== backendId);
          nextBackendSettings.push({
            ...current,
            modelAccess: {
              disabledProviderIds: [...disabledProviderIds],
              disabledModels: [...disabledModels.values()]
            }
          });
          const routeEnabled = (providerId: string, modelId?: string): boolean =>
            !disabledProviderIds.has(providerId)
            && (modelId === undefined || !disabledModels.has(`${providerId}\u0000${modelId}`));
          return {
            ...snapshot,
            settings: { ...snapshot.settings, backendSettings: nextBackendSettings },
            providers: snapshot.providers.map((provider) => provider.backendId === backendId
              ? { ...provider, routingEnabled: routeEnabled(provider.id) }
              : provider),
            models: snapshot.models.map((model) => model.backendId === backendId
              ? { ...model, routingEnabled: routeEnabled(model.providerId, model.modelId) }
              : model)
          };
        });
      },
      refreshProviderModels: async (backendId: string, providerId?: string): Promise<void> => {
        record(`provider-models:refresh:${backendId}:${providerId ?? "all"}`);
      },
      refreshProviderCredential: async (backendId: string, providerId: string): Promise<void> => {
        record(`provider-credential:refresh:${backendId}:${providerId}`);
      },
      logoutProvider: async (backendId: string, providerId: string): Promise<void> => {
        record(`provider-logout:${backendId}:${providerId}`);
      },
      saveProviderCredentialSurface: async (backendId: string, providerId: string, surfaceId: string, _secret: string): Promise<void> => {
        record(`provider-credential-surface:save:${backendId}:${providerId}:${surfaceId}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          providers: snapshot.providers.map((provider) =>
            provider.backendId === backendId && provider.id === providerId
              ? {
                  ...provider,
                  credentialSurfaces: provider.credentialSurfaces.map((surface) =>
                    surface.id === surfaceId ? { ...surface, configured: true } : surface)
                }
              : provider)
        }));
      },
      clearProviderCredentialSurface: async (backendId: string, providerId: string, surfaceId: string): Promise<void> => {
        record(`provider-credential-surface:clear:${backendId}:${providerId}:${surfaceId}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          providers: snapshot.providers.map((provider) =>
            provider.backendId === backendId && provider.id === providerId
              ? {
                  ...provider,
                  credentialSurfaces: provider.credentialSurfaces.map((surface) =>
                    surface.id === surfaceId ? { ...surface, configured: false } : surface)
                }
              : provider)
        }));
      },
      listCommands: async () => state.snapshot.commands,
      loadSessionTimelinePage: async (sessionId: string) => ({ items: state.snapshot.timelineBySession.get(sessionId) ?? [] }),
      updateMessageSearchSettings: async (semanticIndexEnabled: boolean): Promise<void> => {
        record(`semantic-index:${semanticIndexEnabled ? "on" : "off"}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            revision: snapshot.settings.revision + 1n,
            messageSearch: { ...snapshot.settings.messageSearch, semanticIndexEnabled, customized: true }
          }
        }));
      },
      resetMessageSearchSettings: async (): Promise<void> => {
        record("semantic-index:reset");
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            revision: snapshot.settings.revision + 1n,
            messageSearch: { ...snapshot.settings.messageSearch, semanticIndexEnabled: true, customized: false }
          }
        }));
      },
      updatePiSettings: async (backendId: string, patch: Parameters<AppController["updatePiSettings"]>[1]): Promise<void> => {
        if (!state.snapshot.settings.pi.some((settings) => settings.backendId === backendId)) {
          throw new Error("The visual Pi backend does not exist.");
        }
        const threshold = patch.autoCompactionThresholdPercent;
        if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 50 || threshold > 95)) {
          throw new Error("The visual Pi compaction threshold must be between 50 and 95 percent.");
        }
        record(`pi-settings:${backendId}${threshold === undefined ? "" : `:${threshold}`}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            revision: snapshot.settings.revision + 1n,
            pi: snapshot.settings.pi.map((settings) => settings.backendId === backendId
              ? patch.resetAutoCompactionThresholdPercent === true
                ? { ...settings, autoCompactionThresholdPercent: 75, autoCompactionThresholdCustomized: false }
                : {
                    ...settings,
                    ...patch,
                    ...(patch.autoCompactionThresholdPercent === undefined
                      ? {}
                      : { autoCompactionThresholdCustomized: true })
                  }
              : settings)
          }
        }));
      },
      updateBrowserSettings: async (browserProviderId: string, patch: Parameters<AppController["updateBrowserSettings"]>[1]): Promise<void> => {
        record(`automation-browser:update:${browserProviderId}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            revision: snapshot.settings.revision + 1n,
            browsers: snapshot.settings.browsers.map((settings) => settings.browserProviderId === browserProviderId
              ? { ...settings, ...patch }
              : settings)
          }
        }));
      },
      showBrowserAutomation: async (browserProviderId: string): Promise<void> => {
        record(`automation-browser:show:${browserProviderId}`);
      },
      restartBrowser: async (browserProviderId: string): Promise<void> => {
        record(`automation-browser:restart:${browserProviderId}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          browsers: snapshot.browsers.map((browser) => browser.id === browserProviderId
            ? { ...browser, state: "ready", generation: browser.generation + 1n }
            : browser)
        }));
      },
      openBrowserPage: async (browserId: string, _sessionId: string, url: string): Promise<string> => {
        const pageId = "visual-page-new";
        record(`browser-open:${browserId}:${pageId}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          browsers: snapshot.browsers.map((browser) => browser.id === browserId
            ? { ...browser, activePageId: pageId, pages: [...browser.pages, {
              id: pageId,
              title: "New page",
              url,
              state: "ready" as const,
              canGoBack: false,
              canGoForward: false,
              recoverable: false,
              lastKnownGeneration: browser.generation
            }] }
            : browser)
        }));
        return pageId;
      },
      recoverBrowserPage: async (browserId: string, sessionId: string, pageId: string, url: string): Promise<string> => {
        record(`browser-restore:${browserId}:${sessionId}:${pageId}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          browsers: snapshot.browsers.map((browser) => browser.id === browserId
            ? { ...browser, activePageId: pageId, pages: browser.pages.map((page) => page.id === pageId
              ? { ...page, url, state: "ready" as const, recoverable: false, lastKnownGeneration: browser.generation }
              : page) }
            : browser)
        }));
        return pageId;
      },
      focusBrowserPage: async (browserId: string, pageId: string): Promise<string> => {
        record(`browser-focus:${browserId}:${pageId}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          browsers: snapshot.browsers.map((browser) => browser.id === browserId ? { ...browser, activePageId: pageId } : browser)
        }));
        return pageId;
      },
      closeBrowserPage: async (browserId: string, pageId: string): Promise<string | undefined> => {
        let activePageId: string | undefined;
        record(`browser-close:${browserId}:${pageId}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          browsers: snapshot.browsers.map((browser) => {
            if (browser.id !== browserId) return browser;
            const pages = browser.pages.filter((page) => page.id !== pageId);
            activePageId = pages[0]?.id;
            return { ...browser, pages, ...(activePageId === undefined ? { activePageId: undefined } : { activePageId }) };
          })
        }));
        return activePageId;
      },
      updateComputerAutomationSettings: async (enabled: boolean): Promise<void> => {
        record(`automation-computer:${enabled ? "on" : "off"}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            revision: snapshot.settings.revision + 1n,
            computerAutomation: {
              ...snapshot.settings.computerAutomation,
              enabled,
              ...(enabled && !snapshot.settings.computerAutomation.installed ? {
                installed: true,
                driverVersion: "1.0.0",
                daemonRunning: true,
                ready: true,
                runtimeState: "ready" as const,
                failureReason: ""
              } : {})
            }
          }
        }));
      },
      beginBrowserTakeover: async (browserId: string, pageId: string): Promise<void> => {
        record(`browser-takeover:${browserId}:${pageId}`);
      },
      endBrowserTakeover: async (browserId: string): Promise<void> => {
        record(`browser-release:${browserId}`);
      },
      captureBrowserScreenshot: async (browserId: string, pageId: string): Promise<string> => {
        record(`browser-capture:${browserId}:${pageId}`);
        return "visual-blob:assets/preview.png";
      },
      performBrowserTakeoverAction: async (browserId: string, pageId: string, action: { readonly kind: string }): Promise<string> => {
        record(`browser-action:${browserId}:${pageId}:${action.kind}`);
        return "visual-blob:assets/preview.png";
      },
      uploadBrowserFile: async (browserId: string, pageId: string, file: File): Promise<void> => {
        record(`browser-upload:${browserId}:${pageId}:${file.name}`);
      },
      listBrowserActivity: async () => [{
        id: "visual-browser-activity",
        pageId: "visual-page",
        kind: "navigation" as const,
        description: "Opened the deterministic Browser fixture",
        occurredAt: FIXED_NOW - 2_000
      }],
      listBrowserTransfers: async () => [],
      updateBrowserCommentDesign: async () => [],
      installComputerAutomation: async (): Promise<void> => {
        record("automation-computer:install");
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            revision: snapshot.settings.revision + 1n,
            computerAutomation: {
              ...snapshot.settings.computerAutomation,
              installed: true,
              driverVersion: "1.0.0",
              daemonRunning: true,
              ready: true,
              runtimeState: "ready",
              failureReason: ""
            }
          }
        }));
      },
      probeComputerAutomation: async (fresh = true): Promise<void> => {
        if (fresh) record("automation-computer:probe");
      },
      checkComputerAutomationUpdate: async (fresh = false): Promise<void> => {
        if (fresh) record("automation-computer:update-check");
      },
      updateComputerAutomationDriver: async (joinOnly = false): Promise<void> => {
        record(`automation-computer:update:${joinOnly ? "join" : "start"}`);
        if (joinOnly) return;
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            revision: snapshot.settings.revision + 1n,
            computerAutomation: {
              ...snapshot.settings.computerAutomation,
              driverVersion: snapshot.settings.computerAutomation.updateLatestVersion
                || snapshot.settings.computerAutomation.driverVersion,
              updateCurrentVersion: snapshot.settings.computerAutomation.updateLatestVersion
                || snapshot.settings.computerAutomation.driverVersion,
              updateAvailable: false,
              updateInProgress: false,
              updatePhase: "done"
            }
          }
        }));
      },
      requestComputerAutomationPermission: async (permission: Parameters<AppController["requestComputerAutomationPermission"]>[0]): Promise<void> => {
        record(`automation-computer:permission:${permission}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            revision: snapshot.settings.revision + 1n,
            computerAutomation: {
              ...snapshot.settings.computerAutomation,
              ...(permission === "screenRecording" || permission === "all" ? {
                screenRecordingPermission: "granted",
                screenRecordingCapturable: true
              } : {}),
              ...(permission === "accessibility" || permission === "all" ? { accessibilityPermission: "granted" } : {})
            }
          }
        }));
      },
      cancelComputerAutomationPermission: async (): Promise<void> => {
        record("automation-computer:permission-cancel");
      },
      openComputerAutomationPermissionSettings: async (permission): Promise<void> => {
        record(`automation-computer:permission-settings:${permission}`);
      },
      updateAndroidAutomationSettings: async (enabled: boolean): Promise<void> => {
        record(`automation-android:${enabled ? "on" : "off"}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            revision: snapshot.settings.revision + 1n,
            androidAutomation: {
              ...snapshot.settings.androidAutomation,
              enabled,
              runtimeState: enabled ? "ready" as const : "disabled" as const,
              failureReason: ""
            }
          }
        }));
      },
      prepareAndroidAdb: async (): Promise<void> => {
        record("automation-android:prepare");
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            revision: snapshot.settings.revision + 1n,
            androidAutomation: {
              ...snapshot.settings.androidAutomation,
              adbAvailable: true,
              preparationReady: true,
              preparationError: "",
              runtimeState: "ready",
              failureReason: ""
            }
          }
        }));
      },
      probeAndroidAutomation: async (fresh = true): Promise<void> => {
        if (fresh) record("automation-android:probe");
      },
      selectAndroidAutomationDevice: async (deviceSerial?: string): Promise<void> => {
        record(`automation-android:device:${deviceSerial ?? "automatic"}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            revision: snapshot.settings.revision + 1n,
            androidAutomation: {
              ...snapshot.settings.androidAutomation,
              configuredDefaultDeviceSerial: deviceSerial ?? "",
              defaultDeviceSerial: deviceSerial ?? snapshot.settings.androidAutomation.devices
                .find((device) => device.state === "device")?.deviceSerial ?? ""
            }
          }
        }));
      },
      setAndroidAdbPath: async (serverPath?: string): Promise<void> => {
        record(`automation-android:adb-path:${serverPath === undefined ? "automatic" : "custom"}`);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            revision: snapshot.settings.revision + 1n,
            androidAutomation: {
              ...snapshot.settings.androidAutomation,
              adbPathOverride: serverPath ?? "",
              adbPath: serverPath ?? "D:\\visual\\platform-tools\\adb.exe",
              adbPathSource: serverPath === undefined ? "prepared" as const : "custom" as const
            }
          }
        }));
      },
      listWorkspaceEntries: async (workspaceId: string, parentPath: string) => {
        assertVisualWorkspace(workspaceId);
        return files.list(parentPath);
      },
      listWorkspaceEntryPage: async (workspaceId: string, parentPath: string, pageToken?: string, pageSize?: number) => {
        assertVisualWorkspace(workspaceId);
        return files.listPage(parentPath, pageToken, pageSize);
      },
      listWorkspaceFiles: async (workspaceId: string, signal?: AbortSignal) => {
        assertVisualWorkspace(workspaceId);
        if (signal?.aborted === true) throw abortError();
        return files.index();
      },
      watchWorkspaceFileChanges: async function* (scope: WorkspaceFileChangeScopeView, signal?: AbortSignal): AsyncGenerator<never, void, void> {
        if (scope.kind === "workspace") assertVisualWorkspace(scope.workspaceId);
        if (signal?.aborted === true) return;
        await new Promise<void>((resolve) => {
          if (signal === undefined) return;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      readWorkspaceFile: async (workspaceId: string, path: string) => {
        assertVisualWorkspace(workspaceId);
        return files.read(path);
      },
      writeWorkspaceTextFile: async (workspaceId: string, draft: WorkspaceTextFileWriteDraft) => {
        assertVisualWorkspace(workspaceId);
        const result = files.write(draft);
        syncWorkspaceFiles();
        record(`workspace-write:${draft.path}`);
        return result;
      },
      searchWorkspace: async (workspaceId: string, query: string) => {
        assertVisualWorkspace(workspaceId);
        return files.search({ query, caseSensitive: false, regularExpression: false }).matches;
      },
      searchWorkspacePage: async (workspaceId: string, request: WorkspaceSearchRequestView, signal?: AbortSignal) => {
        assertVisualWorkspace(workspaceId);
        if (signal?.aborted === true) throw abortError();
        return files.search(request);
      },
      streamWorkspaceSearch: async function* (workspaceId: string, query: string, caseSensitive: boolean, signal?: AbortSignal) {
        assertVisualWorkspace(workspaceId);
        if (signal?.aborted === true) throw abortError();
        const page = files.search({ query, caseSensitive, regularExpression: false, pageSize: 1_000 });
        for (const match of page.matches) {
          yield { kind: "match" as const, match };
        }
        yield {
          kind: "end" as const,
          truncated: page.truncated,
          totalMatches: page.totalMatches,
          totalFiles: page.totalFiles,
          revision: page.revision
        };
      },
      createWorkspaceEntry: async (draft: WorkspaceEntryMutationDraft): Promise<void> => {
        assertVisualWorkspace(draft.workspaceId);
        files.create(draft);
        syncWorkspaceFiles();
        record(`workspace-create:${draft.kind}:${draft.path}`);
      },
      moveWorkspaceEntry: async (draft: WorkspaceEntryMoveDraft): Promise<void> => {
        assertVisualWorkspace(draft.workspaceId);
        files.move(draft);
        syncWorkspaceFiles();
        record(`workspace-move:${draft.sourcePath}:${draft.destinationPath}`);
      },
      copyWorkspaceEntry: async (draft: WorkspaceEntryMoveDraft): Promise<void> => {
        assertVisualWorkspace(draft.workspaceId);
        files.copy(draft);
        syncWorkspaceFiles();
        record(`workspace-copy:${draft.sourcePath}:${draft.destinationPath}`);
      },
      deleteWorkspaceEntry: async (draft: WorkspaceEntryDeleteDraft): Promise<void> => {
        assertVisualWorkspace(draft.workspaceId);
        files.delete(draft);
        syncWorkspaceFiles();
        record(`workspace-delete:${draft.path}`);
      },
      renameSession: async (sessionId: string, name: string): Promise<void> => updateSession(sessionId, (session) => ({ ...session, name })),
      pinSession: async (sessionId: string, pinned: boolean): Promise<void> => updateSession(sessionId, (session) => ({ ...session, pinned })),
      archiveSession: async (sessionId: string, archived: boolean): Promise<void> => updateSession(sessionId, (session) => ({ ...session, archived })),
      deleteSession: async (sessionId: string): Promise<void> => updateSnapshot((snapshot) => ({ ...snapshot, sessions: snapshot.sessions.filter((session) => session.id !== sessionId) })),
      abort: async (runId: string): Promise<void> => {
        record(`abort:${runId}`);
        updateSnapshot((snapshot) => ({ ...snapshot, sessions: snapshot.sessions.map((session) => session.activeRunId === runId ? { ...session, state: "idle" as const, activeRunId: undefined } : session) }));
      },
      retry: async (runId: string): Promise<void> => { record(`retry:${runId}`); },
      cancelQueueItem: async (queueItemId: string): Promise<void> => { record(`queue-cancel:${queueItemId}`); },
      setQueueItemEditLock: async (queueItemId: string, _lockToken: string, locked: boolean): Promise<void> => { record(`queue-edit-lock:${queueItemId}:${String(locked)}`); },
      setQueueInteractionLock: async (sessionId: string, _lockToken: string, locked: boolean): Promise<void> => { record(`queue-interaction-lock:${sessionId}:${String(locked)}`); },
      editQueueItem: async (queueItemId: string): Promise<void> => { record(`queue-edit:${queueItemId}`); },
      reorderQueueItem: async (queueItemId: string): Promise<void> => { record(`queue-reorder:${queueItemId}`); },
      steerQueueItemNow: async (queueItemId: string): Promise<void> => { record(`queue-steer:${queueItemId}`); },
      pauseQueue: async (sessionId: string): Promise<void> => { record(`pause-queue:${sessionId}`); },
      resumeQueue: async (sessionId: string): Promise<void> => { record(`resume-queue:${sessionId}`); },
      executeUserShell: async (sessionId: string): Promise<void> => { record(`user-shell:${sessionId}`); },
      abortUserShell: async (sessionId: string): Promise<void> => { record(`abort-user-shell:${sessionId}`); },
      resolveInteraction: async (interaction: InteractionView, resolution: InteractionResolutionDraft): Promise<void> => {
        record(`resolve:${interaction.id}:${resolution.kind}`);
        updateSnapshot((snapshot) => ({ ...snapshot, interactions: snapshot.interactions.filter((candidate) => candidate.id !== interaction.id) }));
      },
      dismissInteraction: async (interaction: InteractionView): Promise<void> => {
        record(`dismiss:${interaction.id}`);
        updateSnapshot((snapshot) => ({ ...snapshot, interactions: snapshot.interactions.filter((candidate) => candidate.id !== interaction.id) }));
      },
      runSchedule: async (scheduleId: string): Promise<void> => { record(`schedule-run:${scheduleId}`); },
      setScheduleEnabled: async (scheduleId: string, enabled: boolean): Promise<void> => {
        updateSchedule(scheduleId, (schedule) => ({ ...schedule, enabled }));
        record(`schedule-enabled:${scheduleId}:${enabled}`);
      },
      getSchedulerRuntime: async (): Promise<SchedulerRuntimeView> => visualSchedulerRuntime(),
      listScheduleRunHistory: async (scheduleId: string) => {
        const history = state.snapshot.schedules.find((schedule) => schedule.id === scheduleId)?.history ?? [];
        return { history, totalSize: history.length };
      },
      markScheduleRunRead: async (scheduleId: string, triggerId: string): Promise<void> => {
        updateSchedule(scheduleId, (schedule) => {
          const history = schedule.history.map((run) => run.id === triggerId ? { ...run, readAt: FIXED_NOW } : run);
          return { ...schedule, history, unreadRunCount: visualUnreadScheduleRunCount(history) };
        });
        record(`schedule-run-read:${scheduleId}:${triggerId}`);
      },
      markScheduleRunsRead: async (scheduleId: string): Promise<number> => {
        const schedule = state.snapshot.schedules.find((candidate) => candidate.id === scheduleId);
        const count = schedule === undefined ? 0 : visualUnreadScheduleRunCount(schedule.history);
        updateSchedule(scheduleId, (current) => ({
          ...current,
          unreadRunCount: 0,
          history: current.history.map((run) => visualScheduleRunUnread(run) ? { ...run, readAt: FIXED_NOW } : run)
        }));
        return count;
      },
      markAllScheduleRunsRead: async (): Promise<number> => {
        const count = state.snapshot.schedules.reduce((total, schedule) => total + visualUnreadScheduleRunCount(schedule.history), 0);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          schedules: snapshot.schedules.map((schedule) => ({
            ...schedule,
            unreadRunCount: 0,
            history: schedule.history.map((run) => visualScheduleRunUnread(run) ? { ...run, readAt: FIXED_NOW } : run)
          }))
        }));
        return count;
      },
      deleteScheduleRun: async (scheduleId: string, triggerId: string): Promise<void> => {
        updateSchedule(scheduleId, (schedule) => {
          const history = schedule.history.filter((run) => run.id !== triggerId);
          return { ...schedule, history, unreadRunCount: visualUnreadScheduleRunCount(history) };
        });
      },
      restartScheduleRun: async (scheduleId: string, triggerId: string): Promise<void> => {
        record(`schedule-run-restart:${scheduleId}:${triggerId}`);
      },
      deleteSchedule: async (scheduleId: string, disposition: "keep" | "archive" | "delete"): Promise<ScheduleDeletionResultView> => {
        const generatedSessionIds = state.snapshot.sessions
          .filter((session) => session.automationOrigin?.scheduleId === scheduleId)
          .map((session) => session.id);
        updateSnapshot((snapshot) => ({
          ...snapshot,
          schedules: snapshot.schedules.filter((schedule) => schedule.id !== scheduleId),
          sessions: disposition === "delete"
            ? snapshot.sessions.filter((session) => !generatedSessionIds.includes(session.id))
            : disposition === "archive"
              ? snapshot.sessions.map((session) => generatedSessionIds.includes(session.id) ? { ...session, archived: true } : session)
              : snapshot.sessions
        }));
        record(`schedule-delete:${scheduleId}:${disposition}`);
        return {
          scheduleId,
          disposition,
          generatedSessionIds,
          completedSessionIds: disposition === "keep" ? [] : generatedSessionIds,
          failures: [],
          inflightCount: 1
        };
      },
      getArtifactUrl: async (blobId: string): Promise<string> => files.acquireArtifactUrl(blobId),
      releaseArtifactUrl: (blobId: string): void => files.releaseArtifactUrl(blobId),
      downloadArtifact: async (blobId: string, name: string): Promise<void> => { record(`artifact-download:${blobId}:${name}`); },
      listSubagentRuns: async (
        sessionId: string,
        runState?: SubagentRunStateView,
        pageToken?: string,
        pageSize?: number
      ): Promise<SubagentRunPageView> => subagents.listRuns(sessionId, runState, pageToken, pageSize),
      getSubagentRun: async (sessionId: string, subagentRunId: string): Promise<SubagentRunDetailView> => (
        subagents.getRun(sessionId, subagentRunId)
      ),
      listSubagentTranscript: async (
        sessionId: string,
        subagentRunId: string,
        childId?: string,
        pageToken?: string,
        pageSize?: number
      ): Promise<SubagentTranscriptPageView> => (
        subagents.listTranscript(sessionId, subagentRunId, childId, pageToken, pageSize)
      ),
      controlSubagent: async (
        sessionId: string,
        subagentRunId: string,
        action: SubagentControlActionView,
        message?: string,
        childId?: string
      ): Promise<void> => {
        subagents.control(sessionId, subagentRunId, action, message, childId);
        record(`subagent-control:${action}:${subagentRunId}:${childId ?? "all"}`);
      },
      cloneSession: async (sessionId: string): Promise<string> => sessionId,
      probeTargetWorktree: async (targetId: string) => ({
        targetId,
        eligibility: "unavailable" as const,
        canRefreshRemote: false
      }),
      listTargetWorktreeSources: async () => [],
      discoverNativeSessions: async () => [],
      scanNativeSessionCatalog: async (_backendId, options) => {
        options?.signal?.throwIfAborted();
        return {
          entries: [
            {
              id: "visual-native-joko-a",
              reference: "visual-native://joko-a",
              title: "Complete import workflow",
              workingDirectory: "D:\\joko",
              projectDirectory: "D:\\joko",
              createdAt: FIXED_NOW - 60_000,
              modifiedAt: FIXED_NOW - 30_000,
              archived: false,
              placement: "project" as const,
              targetId: "visual-target",
              projectTargetId: "visual-target"
            },
            {
              id: "visual-native-joko-b",
              reference: "visual-native://joko-b",
              title: "Review provider state",
              workingDirectory: "D:\\joko\\.worktrees\\provider-state",
              projectDirectory: "D:\\joko",
              createdAt: FIXED_NOW - 120_000,
              modifiedAt: FIXED_NOW - 90_000,
              archived: true,
              placement: "project" as const,
              targetId: "visual-target",
              projectTargetId: "visual-target"
            },
            {
              id: "visual-native-prover",
              reference: "visual-native://prover",
              title: "Verify durable events",
              workingDirectory: "D:\\prover",
              projectDirectory: "D:\\prover",
              createdAt: FIXED_NOW - 210_000,
              modifiedAt: FIXED_NOW - 180_000,
              archived: false,
              placement: "project" as const
            },
            {
              id: "visual-native-dialogue",
              reference: "visual-native://dialogue",
              title: "Investigate a standalone question",
              workingDirectory: "D:\\scratch",
              createdAt: FIXED_NOW - 270_000,
              modifiedAt: FIXED_NOW - 240_000,
              archived: false,
              placement: "dialogue" as const
            }
          ],
          rejectedCount: 40,
          existingCount: 2,
          snapshotToken: "visual-catalog-snapshot"
        };
      },
      createSession: async (draft: NewSessionDraft): Promise<string> => {
        const id = `session-${sequence.current++}`;
        const next: SessionView = {
          id,
          backendId: "visual-backend",
          targetId: draft.targetId,
          name: draft.name,
          state: "idle",
          generation: 1n,
          pinned: false,
          archived: false,
          model: state.snapshot.models.find((candidate) => candidate.providerId === draft.providerId && candidate.modelId === draft.modelId),
          effort: draft.effort,
          fastMode: draft.fastMode,
          permissionMode: draft.permissionMode,
          planMode: draft.planMode,
          updatedAt: FIXED_NOW + sequence.current
        };
        updateSnapshot((snapshot) => ({ ...snapshot, sessions: [...snapshot.sessions, next] }));
        record(`session-create:${id}`);
        return id;
      }
    } satisfies Partial<AppController>;
    return new Proxy(implemented, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        return async (): Promise<undefined> => undefined;
      }
    }) as unknown as AppController;
  }, [state]);

  return <AppWithController
    controller={controller}
    initialInspectorSubagentFocusRequest={scenario.scenario === "subagents"
      ? { sessionId: VISUAL_SUBAGENT_SESSION_ID, runId: "", requestId: 1 }
      : undefined}
  />;
}

const VISUAL_SUBAGENT_LONG_REPORT = [
  "## Cross-layer verification checkpoint",
  "",
  "The delegated audit compared durable service behavior, restart reconciliation, UI controls, and recovery evidence. The report is intentionally long so the mounted panel exercises real scrolling and Markdown rendering instead of a compact placeholder.",
  "",
  ...Array.from({ length: 12 }, (_, index) => (
    `${index + 1}. Verified capability group ${index + 1}: native history, queued delivery, tool lifecycle, provider routing, or mounted interaction evidence remained attributable to the same durable generation.`
  )),
  "",
  "Acceptance tail marker: every visible claim is backed by a deterministic fixture entry."
].join("\n");

/** Stateful, credential-free projection used only by the mounted visual scenario. */
class VisualSubagentFixture {
  #runs: SubagentRunView[];
  readonly #details = new Map<string, SubagentRunDetailView>();
  readonly #transcripts = new Map<string, SubagentTranscriptEntryView[]>();
  #sequence = 1_000;
  #tailDelivered = false;

  constructor() {
    const root = visualSubagentRun(VISUAL_SUBAGENT_ROOT_ID, "Coordinate complete product coverage", "running", 500, {
      parentRunId: "visual-run",
      parentTaskId: "visual-product-verification",
      parentToolCallId: "visual-tool-delegate",
      logicalAgentId: "visual-logical-orchestrator",
      providerRunIds: ["provider-root-7"],
      description: "Own the complete behavioral and visual acceptance pass across parallel delegated work.",
      assignment: "Reconcile every applicable product feature, preserve durable recovery truth, and return only evidence-backed gaps.",
      summary: "Four current child generations are auditing runtime behavior, visual evidence, approvals, and provider failures.",
      readOnly: false,
      route: { providerId: "visual-provider", modelId: "vision-model", thinkingLevel: "high" },
      usage: {
        inputTokens: 18_440,
        outputTokens: 7_820,
        cacheReadTokens: 4_100,
        totalTokens: 30_360,
        toolUses: 17,
        durationMs: 11 * 60_000,
        costUsd: 0.1842
      }
    });
    const reviewer = visualSubagentRun("visual-subagent-runtime-reviewer", "Audit native runtime coverage", "completed", 1_100, {
      parentSubagentRunId: root.id,
      logicalAgentId: "visual-logical-runtime-reviewer",
      providerRunIds: ["provider-runtime-2"],
      summary: "Mapped the native command surface and durable lifecycle behavior.",
      readOnly: true,
      endedAt: FIXED_NOW - 70_000,
      capabilities: visualSubagentCapabilities({ stop: false, steer: false, followUp: false, resume: true }),
      usage: { totalTokens: 9_420, toolUses: 5, durationMs: 6 * 60_000, costUsd: 0.071 }
    });
    const nestedFailure = visualSubagentRun("visual-subagent-provider-probe", "Probe provider recovery", "failed", 1_500, {
      parentSubagentRunId: reviewer.id,
      summary: "The provider rejected a deliberately expired credential.",
      readOnly: true,
      endedAt: FIXED_NOW - 55_000,
      error: visualSubagentError("AUTH_TOKEN_EXPIRED", "The visual provider token expired during the recovery probe.", "authentication", "blocked"),
      capabilities: visualSubagentCapabilities({ stop: false, steer: false, followUp: false, resume: true })
    });
    const queued = visualSubagentRun("visual-subagent-narrow-layout", "Capture narrow layout", "queued", 1_700, {
      parentSubagentRunId: root.id,
      assignment: "Capture the mounted panel below the responsive breakpoint after the wide frame is approved.",
      summary: "Waiting for the paired wide-layout capture.",
      readOnly: true,
      capabilities: visualSubagentCapabilities({ steer: false, followUp: false, resume: false })
    });
    const completed = visualSubagentRun("visual-subagent-history-proof", "Verify restart recovery", "completed", 2_200, {
      summary: "Confirmed transcript and result recovery after a full client remount.",
      readOnly: false,
      endedAt: FIXED_NOW - 8 * 60_000,
      capabilities: visualSubagentCapabilities({ stop: false, steer: false, followUp: false, resume: true })
    });
    const failed = visualSubagentRun("visual-subagent-service-failure", "Classify service failure", "failed", 2_800, {
      summary: "A typed service-unavailable path remains visible and resumable.",
      readOnly: true,
      endedAt: FIXED_NOW - 9 * 60_000,
      error: visualSubagentError("PROVIDER_503", "The delegated provider is temporarily unavailable.", "provider", "retryable"),
      capabilities: visualSubagentCapabilities({ stop: false, steer: false, followUp: false, resume: true })
    });
    const stopped = visualSubagentRun("visual-subagent-stopped", "Preserve stopped work", "stopped", 3_300, {
      summary: "Stopped history remains inspectable without looking active.",
      readOnly: false,
      endedAt: FIXED_NOW - 10 * 60_000,
      capabilities: visualSubagentCapabilities({ stop: false, steer: false, followUp: false, resume: true })
    });
    this.#runs = [root, reviewer, nestedFailure, queued, completed, failed, stopped];

    for (const run of this.#runs) {
      this.#details.set(run.id, visualSubagentDetail(run));
      this.#transcripts.set(run.id, visualSubagentTerminalTranscript(run));
    }

    const analysisV1: SubagentChildRunView = {
      id: "visual-child-analysis-v1",
      identityAliases: ["provider-analysis-original"],
      role: "runtime-auditor",
      title: "Runtime coverage · generation 1",
      assignment: "Enumerate the native command and lifecycle surface.",
      state: "completed",
      route: { providerId: "visual-provider", modelId: "text-model", thinkingLevel: "medium" },
      usage: { totalTokens: 5_800, toolUses: 3, durationMs: 180_000, costUsd: 0.032 },
      readOnly: true,
      result: "The first generation completed the native command inventory before a resumed verification pass.",
      startedAt: FIXED_NOW - 10 * 60_000,
      endedAt: FIXED_NOW - 7 * 60_000
    };
    const analysisV2: SubagentChildRunView = {
      id: "visual-child-analysis-v2",
      parentChildId: analysisV1.id,
      identityAliases: [analysisV1.id, "provider-analysis-original", "provider-analysis-resumed"],
      role: "runtime-auditor",
      title: "Runtime coverage · resumed",
      assignment: "Resume the inventory and bind every claim to mounted product evidence.",
      state: "running",
      route: { providerId: "visual-provider", modelId: "vision-model", thinkingLevel: "high" },
      usage: { totalTokens: 8_640, toolUses: 7, durationMs: 420_000, costUsd: 0.086 },
      readOnly: true,
      result: "Durable analysis checkpoint: the resumed generation found no unclassified native command.",
      startedAt: FIXED_NOW - 7 * 60_000
    };
    const approval: SubagentChildRunView = {
      id: "visual-child-browser-approval",
      identityAliases: ["provider-browser-approval"],
      role: "visual-auditor",
      title: "Browser evidence",
      assignment: "Capture paired wide and narrow frames, then request approval before storing the evidence.",
      state: "running",
      route: { providerId: "visual-provider", modelId: "vision-model", thinkingLevel: "medium" },
      usage: { totalTokens: 3_280, toolUses: 4, durationMs: 260_000, costUsd: 0.041 },
      readOnly: false,
      awaitingApproval: true,
      startedAt: FIXED_NOW - 6 * 60_000
    };
    const tests: SubagentChildRunView = {
      id: "visual-child-tests",
      identityAliases: ["provider-tests-current"],
      role: "test-runner",
      title: "Focused tests",
      assignment: "Exercise pagination, tail refresh, control delivery, and restart-visible durable state.",
      state: "completed",
      route: { providerId: "visual-provider", modelId: "text-model", thinkingLevel: "low" },
      usage: { totalTokens: 2_960, toolUses: 6, durationMs: 210_000, costUsd: 0.019 },
      readOnly: false,
      result: "Focused delegated-run tests passed across pagination and control boundaries.",
      startedAt: FIXED_NOW - 5 * 60_000,
      endedAt: FIXED_NOW - 90_000
    };
    const childFailure: SubagentChildRunView = {
      id: "visual-child-provider-failure",
      identityAliases: ["provider-child-failure"],
      role: "provider-probe",
      title: "Provider failure path",
      assignment: "Prove that a failed child remains attributable and resumable.",
      state: "failed",
      route: { providerId: "visual-provider", modelId: "text-model", thinkingLevel: "medium" },
      readOnly: true,
      error: visualSubagentError("PROVIDER_RATE_LIMITED", "The provider rate limited the delegated verification request.", "provider", "retryable"),
      startedAt: FIXED_NOW - 4 * 60_000,
      endedAt: FIXED_NOW - 2 * 60_000
    };
    this.#details.set(root.id, {
      run: root,
      activity: [
        { sequence: 1, kind: "started", state: "running", summary: "Created four parallel verification lineages.", occurredAt: FIXED_NOW - 12 * 60_000 },
        { sequence: 2, kind: "resumed", state: "running", summary: "Runtime audit resumed as a new durable generation.", occurredAt: FIXED_NOW - 7 * 60_000 },
        { sequence: 3, kind: "question", state: "running", summary: "Visual evidence is waiting for approval.", lastToolName: "browser.capture", occurredAt: FIXED_NOW - 90_000 }
      ],
      children: [analysisV1, analysisV2, approval, tests, childFailure],
      returnedResult: "Durable coordinator result: verified child work remains visible even while one current generation is awaiting approval.",
      childrenObserved: true
    });
    this.#transcripts.set(root.id, [
      visualSubagentEntry(1, "parent", "Coordinate complete product verification and preserve every durable control boundary."),
      visualSubagentEntry(2, "subagent", "Generation 1 mapped the native runtime commands and handed its identities to the resumed verifier.", analysisV1.id),
      visualSubagentSystemEntry(3, "turn-ended", "The first runtime audit generation ended.", analysisV1.id),
      { ...visualSubagentEntry(4, "parent", "Resume with mounted evidence and check the recovery paths.", analysisV2.id), controlAction: "resume" },
      visualSubagentEntry(5, "subagent", VISUAL_SUBAGENT_LONG_REPORT, analysisV2.id),
      {
        ...visualSubagentEntry(6, "tool", "Run focused delegated-run tests", analysisV2.id),
        toolName: "test",
        toolCallId: "visual-tool-test",
        toolPhase: "start",
        toolInputJson: "{\"suite\":\"subagent-visual-harness\",\"mode\":\"focused\"}"
      },
      {
        ...visualSubagentEntry(7, "tool", "Pagination assertions passed; control assertions are running.", analysisV2.id),
        toolName: "test",
        toolCallId: "visual-tool-test",
        toolPhase: "update"
      },
      {
        ...visualSubagentEntry(8, "tool", "7 focused checks passed", analysisV2.id),
        toolName: "test",
        toolCallId: "visual-tool-test",
        toolPhase: "end"
      },
      visualSubagentSystemEntry(9, "control-requested", "A control request was sent from the parent task.", approval.id, [{ key: "action", value: "follow_up" }]),
      visualSubagentEntry(10, "subagent", tests.result ?? "Focused delegated-run tests passed.", tests.id),
      visualSubagentSystemEntry(11, "turn-ended", "The focused test child completed.", tests.id)
    ]);
  }

  listRuns(
    sessionId: string,
    state: SubagentRunStateView | undefined,
    pageToken: string | undefined,
    pageSize: number | undefined
  ): SubagentRunPageView {
    assertVisualSubagentSession(sessionId);
    const filtered = state === undefined ? this.#runs : this.#runs.filter((run) => run.state === state);
    const prefix = `visual-subagent-runs:${state ?? "all"}:`;
    const offset = visualFixturePageOffset(pageToken, prefix);
    const limit = visualFixturePageSize(pageSize, VISUAL_SUBAGENT_LIST_PAGE_SIZE);
    const end = Math.min(filtered.length, offset + limit);
    return {
      runs: filtered.slice(offset, end),
      ...(end < filtered.length ? { nextPageToken: `${prefix}${end}` } : {}),
      totalSize: filtered.length
    };
  }

  getRun(sessionId: string, runId: string): SubagentRunDetailView {
    assertVisualSubagentSession(sessionId);
    const detail = this.#details.get(runId);
    if (detail === undefined) throw new Error("The visual delegated run does not exist.");
    return detail;
  }

  listTranscript(
    sessionId: string,
    runId: string,
    childId: string | undefined,
    pageToken: string | undefined,
    pageSize: number | undefined
  ): SubagentTranscriptPageView {
    assertVisualSubagentSession(sessionId);
    if (!this.#details.has(runId)) throw new Error("The visual delegated run does not exist.");
    const childScope = childId ?? "all";
    const pagePrefix = `visual-subagent-transcript:${runId}:${childScope}:`;
    const tailPrefix = `visual-subagent-tail:${runId}:${childScope}:`;
    const tailRead = pageToken?.startsWith(tailPrefix) === true;
    if (tailRead && runId === VISUAL_SUBAGENT_ROOT_ID && childId === undefined && !this.#tailDelivered) {
      this.#tailDelivered = true;
      this.#appendTranscript(runId, visualSubagentEntry(
        this.#nextSequence(),
        "subagent",
        "Live tail checkpoint: the restarted current generation reconnected and appended this entry without replacing earlier pages.",
        "visual-child-analysis-v2"
      ));
    }
    const allEntries = this.#transcripts.get(runId) ?? [];
    const entries = childId === undefined
      ? allEntries
      : allEntries.filter((entry) => entry.childId === undefined || entry.childId === childId);
    const prefix = tailRead ? tailPrefix : pagePrefix;
    const offset = visualFixturePageOffset(pageToken, prefix);
    const limit = visualFixturePageSize(pageSize, VISUAL_SUBAGENT_TRANSCRIPT_PAGE_SIZE);
    const end = Math.min(entries.length, offset + limit);
    return {
      entries: entries.slice(offset, end),
      ...(end < entries.length ? { nextPageToken: `${prefix}${end}` } : {}),
      tailPageToken: `${tailPrefix}${entries.length}`,
      totalSize: entries.length
    };
  }

  control(
    sessionId: string,
    runId: string,
    action: SubagentControlActionView,
    message: string | undefined,
    childId: string | undefined
  ): void {
    assertVisualSubagentSession(sessionId);
    const detail = this.getRun(sessionId, runId);
    const occurredAt = FIXED_NOW + this.#sequence;
    let children = detail.children;
    if (childId !== undefined) {
      let found = false;
      children = detail.children.map((child) => {
        if (child.id !== childId) return child;
        found = true;
        return {
          ...child,
          state: action === "stop" ? "stopped" as const : "running" as const,
          ...(action === "stop" ? { endedAt: occurredAt } : { endedAt: undefined }),
          awaitingApproval: false
        };
      });
      if (!found) throw new Error("The visual delegated child does not exist.");
    }
    const state = childId === undefined && action === "stop" ? "stopped" as const : "running" as const;
    const run = {
      ...detail.run,
      state,
      updatedAt: occurredAt,
      revision: detail.run.revision + 1n,
      ...(state === "stopped" ? { endedAt: occurredAt } : { endedAt: undefined })
    };
    const activityKind = action === "stop"
      ? "stopped" as const
      : action === "steer" ? "steered" as const : action === "resume" ? "resumed" as const : "followedUp" as const;
    this.#details.set(runId, {
      ...detail,
      run,
      children,
      activity: [...detail.activity, {
        sequence: this.#nextSequence(),
        kind: activityKind,
        state,
        summary: `${action} control delivered to ${childId ?? "the whole delegated run"}.`,
        occurredAt
      }]
    });
    this.#runs = this.#runs.map((candidate) => candidate.id === runId ? run : candidate);
    if (message?.trim()) {
      this.#appendTranscript(runId, {
        ...visualSubagentEntry(this.#nextSequence(), "parent", message.trim(), childId),
        controlAction: action
      });
    }
    this.#appendTranscript(runId, visualSubagentSystemEntry(
      this.#nextSequence(),
      action === "stop" ? "stop-requested" : "control-requested",
      action === "stop" ? "A stop was requested from the parent task." : "A control request was sent from the parent task.",
      childId,
      [{ key: "action", value: action }]
    ));
  }

  #appendTranscript(runId: string, entry: SubagentTranscriptEntryView): void {
    this.#transcripts.set(runId, [...(this.#transcripts.get(runId) ?? []), entry]);
  }

  #nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }
}

function visualSubagentRun(
  id: string,
  title: string,
  state: SubagentRunStateView,
  updatedOffsetMs: number,
  overrides: Partial<SubagentRunView> = {}
): SubagentRunView {
  return {
    id,
    sessionId: VISUAL_SUBAGENT_SESSION_ID,
    identityAliases: [],
    providerRunIds: [],
    state,
    title,
    capabilities: visualSubagentCapabilities(),
    startedAt: FIXED_NOW - 12 * 60_000 - updatedOffsetMs,
    updatedAt: FIXED_NOW - updatedOffsetMs,
    revision: BigInt(Math.max(1, Math.round(updatedOffsetMs))),
    ...overrides
  };
}

function visualSubagentCapabilities(
  patch: Partial<SubagentCapabilitiesView> = {}
): SubagentCapabilitiesView {
  return {
    viewActivity: true,
    viewReturnedResult: true,
    viewFullTranscript: true,
    stop: true,
    steer: true,
    followUp: true,
    resume: true,
    parentContext: "live",
    ...patch
  };
}

function visualSubagentDetail(run: SubagentRunView): SubagentRunDetailView {
  return {
    run,
    activity: [{
      sequence: 1,
      kind: run.state === "failed" ? "failed" : run.state === "completed" ? "completed" : run.state === "stopped" ? "stopped" : "started",
      state: run.state,
      summary: run.summary ?? run.description ?? run.title,
      occurredAt: run.updatedAt
    }],
    children: [],
    ...(run.state === "completed" ? { returnedResult: run.summary ?? `${run.title} completed.` } : {}),
    childrenObserved: true
  };
}

function visualSubagentTerminalTranscript(run: SubagentRunView): SubagentTranscriptEntryView[] {
  return [
    visualSubagentEntry(1, "parent", run.assignment ?? run.description ?? `Complete ${run.title.toLowerCase()}.`),
    ...(run.state === "queued" ? [] : [visualSubagentEntry(2, "subagent", run.summary ?? `${run.title} reported its durable state.`)]),
    ...(run.state === "running" || run.state === "queued"
      ? []
      : [visualSubagentSystemEntry(3, "turn-ended", "The delegated turn ended.")])
  ];
}

function visualSubagentEntry(
  sequence: number,
  role: SubagentTranscriptEntryView["role"],
  content: string,
  childId?: string
): SubagentTranscriptEntryView {
  return {
    id: `visual-subagent-entry-${sequence}-${childId ?? "root"}`,
    sequence,
    role,
    content,
    occurredAt: FIXED_NOW - 12 * 60_000 + sequence * 10_000,
    ...(childId === undefined ? {} : { childId })
  };
}

function visualSubagentSystemEntry(
  sequence: number,
  kind: string,
  content: string,
  childId?: string,
  params: readonly { readonly key: string; readonly value: string }[] = []
): SubagentTranscriptEntryView {
  return {
    ...visualSubagentEntry(sequence, "system", content, childId),
    systemEvent: { kind, params }
  };
}

function visualSubagentError(
  code: string,
  message: string,
  phase: string,
  severity: "retryable" | "blocked"
): NonNullable<SubagentRunView["error"]> {
  return {
    code,
    message,
    phase,
    severity,
    retryable: severity === "retryable",
    recovery: severity === "retryable"
      ? [{ id: "retry", kind: "retry", label: "Retry delegated work" }]
      : [{ id: "reauthenticate", kind: "reauthenticate", label: "Reconnect provider" }]
  };
}

function assertVisualSubagentSession(sessionId: string): void {
  if (sessionId !== VISUAL_SUBAGENT_SESSION_ID) throw new Error("The visual delegated-run session changed unexpectedly.");
}

function visualFixturePageOffset(pageToken: string | undefined, prefix: string): number {
  if (pageToken === undefined || pageToken === "") return 0;
  if (!pageToken.startsWith(prefix)) throw new Error("The visual fixture page token does not match this query.");
  const offset = Number(pageToken.slice(prefix.length));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("The visual fixture page token is invalid.");
  return offset;
}

function visualFixturePageSize(pageSize: number | undefined, maximum: number): number {
  if (pageSize !== undefined && (!Number.isSafeInteger(pageSize) || pageSize < 1)) {
    throw new Error("The visual fixture page size is invalid.");
  }
  return Math.min(pageSize ?? maximum, maximum);
}

interface VisualFileRecord {
  readonly kind: "file" | "directory";
  readonly text?: string;
  readonly bytes?: Uint8Array;
  readonly mediaType?: string;
  readonly blobId?: string;
  readonly revision: string;
}

/**
 * A deterministic, memory-only workspace used exclusively by the visual
 * harness. It deliberately exercises the same revision fences, directory
 * pagination, search projection, and structural mutations as the real route.
 */
class VisualWorkspaceFiles {
  readonly #entries = new Map<string, VisualFileRecord>();
  readonly #artifactUrls = new Map<string, { readonly url: string; refs: number }>();
  #sequence = 1;

  constructor() {
    this.#seedFile("README.md", "# Sample workspace\n\nThis project demonstrates the Files route with a tree, document, and task rail visible together.\n", "text/markdown");
    this.#seedDirectory("guides");
    this.#seedFile("guides/STYLE_GUIDE.md", "# Style guide\n\nUse restrained surfaces, compact geometry, and one clear accent.\n", "text/markdown");
    this.#seedDirectory("src");
    this.#seedFile("src/App.tsx", "import type { JSX } from \"react\";\n\nexport function App(): JSX.Element {\n  return <main>Joko workspace</main>;\n}\n", "text/typescript");
    this.#seedDirectory("src/components");
    this.#seedFile("src/components/SessionPane.tsx", "export function SessionPane() {\n  return <section aria-label=\"Task conversation\" />;\n}\n", "text/typescript");
    this.#seedDirectory("public");
    this.#seedFile("public/mark.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" rx=\"16\" fill=\"#635bff\"/><circle cx=\"32\" cy=\"32\" r=\"13\" fill=\"white\"/></svg>", "image/svg+xml");
    this.#seedDirectory("assets");
    this.#seedBinary("assets/preview.png", visualBase64Bytes(VISUAL_PNG_BASE64), "image/png");
    this.#seedBinary("assets/manual.pdf", visualPdfBytes(), "application/pdf");
    this.#seedBinary("assets/clip.webm", visualBase64Bytes(VISUAL_WEBM_BASE64), "video/webm");
    this.#seedBinary("assets/archive.bin", new Uint8Array([0, 1, 2, 3, 127, 128, 254, 255]), "application/octet-stream");
    this.#seedFile("assets/architecture.drawio", visualDrawioXml(), "application/xml");
    this.#seedFile("docs/RICH_PREVIEW.md", [
      "# Rich Files preview",
      "",
      "Inline **formatting**, `code`, a local raster, a table, and Mermaid all stay source-preserving.",
      "",
      "![Deterministic preview](../assets/preview.png)",
      "",
      "| Surface | Status |",
      "| --- | --- |",
      "| Files | verified |",
      "| Pi | connected |",
      "",
      "```mermaid",
      "flowchart LR",
      "  UI[Files UI] --> Orchestrator",
      "  Orchestrator --> Pi",
      "```",
      ""
    ].join("\n"), "text/markdown");
    this.#seedDirectory("search-fixtures");
    for (let index = 1; index <= 80; index += 1) {
      this.#seedFile(`search-fixtures/result-${String(index).padStart(3, "0")}.txt`, `virtual workspace match ${index}\nsecond workspace match ${index}\n`, "text/plain");
    }
    this.#seedFile("package.json", "{\n  \"name\": \"joko\",\n  \"private\": true\n}\n", "application/json");
    this.#seedFile("README.md", "# Joko\n\nA deterministic Joko + Pi verification workspace.\n", "text/markdown");
  }

  get workspaceRevision(): string {
    return `visual-${this.#sequence}`;
  }

  list(parentPath: string): readonly WorkspaceEntryView[] {
    const parent = normalizeVisualPath(parentPath, true);
    const prefix = parent === "" ? "" : `${parent}/`;
    return [...this.#entries.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map(([path, record]) => this.#view(path, record))
      .sort((left, right) => left.kind === right.kind
        ? left.name.localeCompare(right.name)
        : left.kind === "directory" ? -1 : 1);
  }

  listPage(parentPath: string, pageToken?: string, pageSize = 500): WorkspaceEntryPageView {
    const entries = this.list(parentPath);
    const offset = parseVisualPageToken(pageToken);
    const size = Math.max(1, Math.min(1_000, Math.trunc(pageSize)));
    const page = entries.slice(offset, offset + size);
    const nextOffset = offset + page.length;
    return {
      entries: page,
      ...(nextOffset < entries.length ? { nextPageToken: String(nextOffset) } : {}),
      totalSize: entries.length,
      revision: this.workspaceRevision
    };
  }

  index(): { readonly paths: readonly string[]; readonly truncated: boolean; readonly revision: string } {
    return {
      paths: [...this.#entries.entries()]
        .filter(([, record]) => record.kind === "file")
        .map(([path]) => path),
      truncated: false,
      revision: this.workspaceRevision
    };
  }

  read(path: string): WorkspaceFilePreviewView {
    const normalized = normalizeVisualPath(path);
    const record = this.#required(normalized);
    if (record.kind !== "file") throw new Error("The selected workspace entry is not a file.");
    const name = visualBasename(normalized);
    if (record.text !== undefined) {
      return {
        path: normalized,
        name,
        kind: record.mediaType?.startsWith("image/") === true && record.mediaType !== "image/svg+xml" ? "image" : "text",
        text: record.text,
        language: visualLanguage(normalized),
        revision: record.revision,
        mediaType: record.mediaType,
        byteSize: utf8Length(record.text),
        modifiedAt: FIXED_NOW,
        truncated: false
      };
    }
    return {
      path: normalized,
      name,
      kind: record.mediaType?.startsWith("image/") === true ? "image" : "blob",
      blobId: record.blobId,
      mediaType: record.mediaType,
      summary: "Deterministic binary visual fixture",
      byteSize: record.bytes?.byteLength,
      modifiedAt: FIXED_NOW,
      truncated: false
    };
  }

  acquireArtifactUrl(blobId: string): string {
    const retained = this.#artifactUrls.get(blobId);
    if (retained !== undefined) {
      retained.refs += 1;
      return retained.url;
    }
    const record = [...this.#entries.values()].find((candidate) => candidate.blobId === blobId);
    if (record?.bytes === undefined) throw new Error("The visual artifact does not exist.");
    const copy = new Uint8Array(record.bytes.byteLength);
    copy.set(record.bytes);
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: record.mediaType ?? "application/octet-stream" }));
    this.#artifactUrls.set(blobId, { url, refs: 1 });
    return url;
  }

  releaseArtifactUrl(blobId: string): void {
    const retained = this.#artifactUrls.get(blobId);
    if (retained === undefined) return;
    retained.refs -= 1;
    if (retained.refs > 0) return;
    URL.revokeObjectURL(retained.url);
    this.#artifactUrls.delete(blobId);
  }

  disposeArtifactUrls(): void {
    for (const retained of this.#artifactUrls.values()) URL.revokeObjectURL(retained.url);
    this.#artifactUrls.clear();
  }

  write(draft: WorkspaceTextFileWriteDraft): WorkspaceTextFileWriteResultView {
    const path = normalizeVisualPath(draft.path);
    const current = this.#required(path);
    if (current.kind !== "file" || current.text === undefined) throw new Error("Only text files can be saved.");
    if (draft.expectedRevision !== current.revision) throw new Error("The workspace file changed on disk.");
    const revision = this.#nextRevision();
    this.#entries.set(path, { ...current, text: draft.text, revision });
    return { path, name: visualBasename(path), revision };
  }

  search(request: WorkspaceSearchRequestView): WorkspaceSearchPageView {
    const query = request.query;
    if (query === "") return { matches: [], truncated: false, totalMatches: 0, totalFiles: 0, revision: this.workspaceRevision };
    let matcher: (line: string) => readonly [number, number][];
    if (request.regularExpression) {
      const expression = new RegExp(query, request.caseSensitive ? "gu" : "giu");
      matcher = (line) => {
        const ranges: [number, number][] = [];
        expression.lastIndex = 0;
        for (const match of line.matchAll(expression)) {
          const start = match.index ?? 0;
          ranges.push([start, start + Math.max(match[0].length, 1)]);
          if (match[0].length === 0) expression.lastIndex += 1;
        }
        return ranges;
      };
    } else {
      const needle = request.caseSensitive ? query : query.toLocaleLowerCase();
      matcher = (line) => {
        const haystack = request.caseSensitive ? line : line.toLocaleLowerCase();
        const ranges: [number, number][] = [];
        let offset = 0;
        while (offset <= haystack.length - needle.length) {
          const start = haystack.indexOf(needle, offset);
          if (start < 0) break;
          ranges.push([start, start + needle.length]);
          offset = start + Math.max(needle.length, 1);
        }
        return ranges;
      };
    }
    const allMatches: WorkspaceSearchPageView["matches"][number][] = [];
    const matchedFiles = new Set<string>();
    for (const [path, record] of [...this.#entries.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (record.kind !== "file" || record.text === undefined) continue;
      let byteOffset = 0;
      const lines = record.text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const ranges = matcher(line);
        const firstRange = ranges[0];
        if (firstRange !== undefined) {
          const [startColumn, endColumn] = firstRange;
          const submatches = ranges.map(([start, end]) => ({
            startByte: utf8Length(line.slice(0, start)),
            endByte: utf8Length(line.slice(0, end))
          }));
          const startByte = byteOffset + submatches[0]!.startByte;
          const endByte = byteOffset + submatches[0]!.endByte;
          allMatches.push({
            path,
            line: index + 1,
            preview: line,
            submatches,
            range: {
              startByte,
              endByte,
              startLine: index + 1,
              startColumn: startColumn + 1,
              endLine: index + 1,
              endColumn: endColumn + 1
            },
            revision: record.revision
          });
          matchedFiles.add(path);
        }
        byteOffset += utf8Length(line) + (index < lines.length - 1 ? 1 : 0);
      }
    }
    const offset = parseVisualPageToken(request.pageToken);
    const pageSize = Math.max(1, Math.min(500, Math.trunc(request.pageSize ?? 100)));
    const page = allMatches.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      matches: page,
      ...(nextOffset < allMatches.length ? { nextPageToken: String(nextOffset) } : {}),
      truncated: nextOffset < allMatches.length,
      totalMatches: allMatches.length,
      totalFiles: matchedFiles.size,
      revision: this.workspaceRevision
    };
  }

  create(draft: WorkspaceEntryMutationDraft): void {
    const path = normalizeVisualPath(draft.path);
    if (this.#entries.has(path)) throw new Error("A workspace entry already exists at that path.");
    this.#requireParent(path);
    const revision = this.#nextRevision();
    this.#entries.set(path, draft.kind === "directory"
      ? { kind: "directory", revision }
      : { kind: "file", text: "", mediaType: "text/plain", revision });
  }

  move(draft: WorkspaceEntryMoveDraft): void {
    const source = normalizeVisualPath(draft.sourcePath);
    const destination = normalizeVisualPath(draft.destinationPath);
    const current = this.#required(source);
    if (current.revision !== draft.expectedRevision) throw new Error("The workspace entry changed on disk.");
    this.#copyOrMove(source, destination, true);
  }

  copy(draft: WorkspaceEntryMoveDraft): void {
    const source = normalizeVisualPath(draft.sourcePath);
    const destination = normalizeVisualPath(draft.destinationPath);
    const current = this.#required(source);
    if (current.revision !== draft.expectedRevision) throw new Error("The workspace entry changed on disk.");
    this.#copyOrMove(source, destination, false);
  }

  delete(draft: WorkspaceEntryDeleteDraft): void {
    const path = normalizeVisualPath(draft.path);
    const current = this.#required(path);
    if (current.revision !== draft.expectedRevision) throw new Error("The workspace entry changed on disk.");
    const descendants = [...this.#entries.keys()].filter((candidate) => candidate.startsWith(`${path}/`));
    if (descendants.length > 0 && !draft.confirmRecursive) throw new Error("Recursive deletion requires confirmation.");
    this.#entries.delete(path);
    descendants.forEach((candidate) => this.#entries.delete(candidate));
    this.#nextRevision();
  }

  #copyOrMove(source: string, destination: string, move: boolean): void {
    if (source === destination || destination.startsWith(`${source}/`)) throw new Error("A directory cannot be moved into itself.");
    if (this.#entries.has(destination)) throw new Error("A workspace entry already exists at the destination.");
    this.#requireParent(destination);
    const affected = [...this.#entries.entries()].filter(([path]) => path === source || path.startsWith(`${source}/`));
    if (affected.length === 0) throw new Error("The workspace entry does not exist.");
    for (const [path, record] of affected) {
      const suffix = path.slice(source.length);
      this.#entries.set(`${destination}${suffix}`, { ...record, revision: this.#nextRevision() });
    }
    if (move) affected.forEach(([path]) => this.#entries.delete(path));
  }

  #view(path: string, record: VisualFileRecord): WorkspaceEntryView {
    return {
      path,
      name: visualBasename(path),
      kind: record.kind,
      ...(record.kind === "file"
        ? { size: record.text === undefined ? record.bytes?.byteLength ?? 0 : utf8Length(record.text) }
        : {}),
      revision: record.revision,
      mediaType: record.mediaType,
      generated: false
    };
  }

  #required(path: string): VisualFileRecord {
    const record = this.#entries.get(path);
    if (record === undefined) throw new Error("The workspace entry does not exist.");
    return record;
  }

  #requireParent(path: string): void {
    const slash = path.lastIndexOf("/");
    if (slash < 0) return;
    const parent = this.#entries.get(path.slice(0, slash));
    if (parent?.kind !== "directory") throw new Error("The destination directory does not exist.");
  }

  #seedDirectory(path: string): void {
    this.#entries.set(path, { kind: "directory", revision: this.#nextRevision() });
  }

  #seedFile(path: string, text: string, mediaType: string): void {
    this.#entries.set(path, { kind: "file", text, mediaType, revision: this.#nextRevision() });
  }

  #seedBinary(path: string, bytes: Uint8Array, mediaType: string): void {
    this.#entries.set(path, {
      kind: "file",
      bytes,
      mediaType,
      blobId: `visual-blob:${path}`,
      revision: this.#nextRevision()
    });
  }

  #nextRevision(): string {
    this.#sequence += 1;
    return `visual-${this.#sequence}`;
  }
}

function assertVisualWorkspace(workspaceId: string): void {
  if (workspaceId !== VISUAL_WORKSPACE_ID) throw new Error("The visual harness workspace changed unexpectedly.");
}

function normalizeVisualPath(path: string, allowRoot = false): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (normalized === "" && allowRoot) return "";
  if (normalized === "" || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Invalid visual workspace path.");
  }
  return normalized;
}

function visualBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function visualLanguage(path: string): string | undefined {
  if (/\.tsx?$/iu.test(path)) return "typescript";
  if (/\.mdx?$/iu.test(path)) return "markdown";
  if (/\.json$/iu.test(path)) return "json";
  if (/\.svg$/iu.test(path)) return "xml";
  return undefined;
}

function parseVisualPageToken(pageToken: string | undefined): number {
  if (pageToken === undefined || pageToken === "") return 0;
  const offset = Number(pageToken);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid visual workspace page token.");
  return offset;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function visualBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function visualPdfBytes(): Uint8Array {
  const firstPage = "BT /F1 24 Tf 72 720 Td (Joko Files PDF page 1) Tj ET";
  const secondPage = "BT /F1 24 Tf 72 720 Td (Every PDF page renders) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${firstPage.length} >>\nstream\n${firstPage}\nendstream`,
    `<< /Length ${secondPage.length} >>\nstream\n${secondPage}\nendstream`
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(utf8Length(source));
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = utf8Length(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

function visualDrawioXml(): string {
  return "<mxfile host=\"Joko\"><diagram name=\"Page-1\"><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/><mxCell id=\"2\" value=\"Files\" style=\"rounded=1;whiteSpace=wrap;html=1;\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"80\" y=\"80\" width=\"120\" height=\"60\" as=\"geometry\"/></mxCell><mxCell id=\"3\" value=\"Pi\" style=\"ellipse;whiteSpace=wrap;html=1;\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"280\" y=\"80\" width=\"80\" height=\"60\" as=\"geometry\"/></mxCell><mxCell id=\"4\" edge=\"1\" parent=\"1\" source=\"2\" target=\"3\"><mxGeometry relative=\"1\" as=\"geometry\"/></mxCell></root></mxGraphModel></diagram></mxfile>";
}

const VISUAL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAACXBIWXMAAAABAAAAAQBPJcTWAAAFPUlEQVR4nO3dXY7cRBSGYRcMygULYNfccMcGWADLg+SgGSVoEKD8TLuqvlPPo76YtJTutN2vj+0k9rgWqblvN+rjG9aY+8Z//wHWvO1Viz7wss87/mOlz3jfa42n6wAzVyT7qDHar/r+AbdfhZzccPOAe688vkTvhjsH3Hi18VWqb8NtA+66wvg21bThngG3XFW8UXVsuGHA/VYSj1LtGu4WcLPVw8NVr4ZbBdxpxXCfatRwn4DbrBImqC4NNwm4x8pgpmrRcIeAG6wGlqj8huMDTl8BrFXhDWcHHL3o2UQlNxwccO5CZzcV23BqwKGLm21VZsORAScuaPZXgQ1HBgykBhy3jSRIpQ3hsICzFi6JKqrhpICDFivRKqfhpICB1IBTtoj0UCFDOCPgiEVJM5XQcEDA+y9EuqrtGw4IGEgNePPtH+3V3kN464B3XnCcozZueOuAgdSAt93mcaDadQhvGvCeC4uT1ZYNbxowkBrwhts5uLYcwjsGDKQGvNsWDnYewnsFvNWigf0b3itgIDXgfbZqkDKENwoYSA14k+0ZZA3hXQIGUgPeYUsGiUN4i4CB1ICXb8MgdwivDxhIDdj4JV0tHcImMARbGbDxSw81xrVoCJvAEEzAEGxZwPaf6WQ8n8lasBdtAkOwNQFX1VjyxtBrCJvAEEzAEGxBwEuO9aHlXrQJDMFmB2z80tuYO4RNYAgmYAg2NWD7z5xgTNyLNoEhmIAhmIAh2LyAHQBzjjHrMNgEhmAChmAChmCTAnYAzGnGlMNgExiCCRiCCRiCzQjYATBnGvcfBpvAHG28+vlNsY01l2kUMAQTMAQTMAS7PWBnsNhZvTruHW84jv2/17n7PJYJDMEEDMEEDMEEDMEEDMHuDdgpaBh3nog2gSGYgCGYgCGYgCGYgCGYgCGYgCGYgCGYgCGYgCGYgCGYgCGYgCGYgDnaeND1nB/1Ol9LwBBMwBBMwBBMwBytbr4u9N0EDMEEDMEEDMEEDMEEDMEEDMEEDMEEDMEEDMEEDMEEDMEEDMEEDMGecm9tDBFuTcAEhmAChmAChmAChmAC5mjj1fWr3nK2qe11oZ2I5mR189/CmMAQTMAQTMAcrV7/YtFx7FsIGILNCNh5LM5U9/87YhMYggkYggkYgk0K2GEwp6kp/5HWBIZgAoZgAoZg8wJ2GMw5ataVpExgCCZgCCZgCDY1YIfBnKAmXkrZBIZgAoZgswO2F01vNfdWJCYwBFsQsCFMVzX9TmAmMAQTMARbE/DzZezddpReasVX2gSGYE/PG42nfz5+mPLMb+ONr/NhXH9eHx9/fPrhs8/8Xt/yu97+zI+ffnj/stinLehx/fqwV/4wpi6yb3pm/PSvZ97P+Dr/fF2/jAe/8suX5TMf3gSGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYAKGYE/j+nSd97m+6jYy43F3nannD7zAore96oEf+Lvrevfy2Pnzjke+2pd/8e65LdL3L4938RO4Xu4pvPpPwVlGwlcuI2ANM9lIqDcpYCA7YDvSzDFCxm9YwBpmgpFTb17AGuZWI6reyICB7IAdDHOHkTZ+UwPWMA83AusNDljDPFBovdkBa5jD640PWMOcXG+HgDXMsfU2CVjDnFlvn4A1zIH1tgpYw5xWb7eANcxR9TYMWMOcU2/PgDXMIfW2DVjDnFBv54A1TPt6mwesYa7W9fYPWMOHG63rva7rL2iOQ+wT+qBUAAAAAElFTkSuQmCC";
const VISUAL_WEBM_BASE64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAJrEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggJV7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAxV0GNTGF2ZjYyLjEyLjEwMUSJiEB/QAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYhzuhrsgip0M5yBACK1nIN1bmSIgQCGhVZfVlA5g4EBI+ODhAT3kNXgkLCBoLqBWpqBAlWwhFW5gQESVMNnQIBzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYyLjEyLjEwMXNz2mPAi2PFiHO6GuyCKnQzZ8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4yOC4xMDEgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuNTAwMDAwMDAwAB9DtnVApOeBAKOsgQAAgIJJg0IACfAFlgA4JBwYQgAAMGAAAGf7///o7/f//+fZ/lNRUyilzwCjlYEAUwCGAECSnABJQAADIAAAWfmG4KOVgQCnAIYAQJKcAErAAAMgAABZ+Ybgo5WBAPoAhgBAkpwAScAAAyAAAFn5huCjlYEBTQCGAECSnABIoAADIAAAWfmG4KOVgQGhAIYAQJKcAEeAAAMgAABZ+YbgHFO7a5G7j7OBALeK94EB8YIBq/CBAw==";

function abortError(): Error {
  return typeof DOMException === "undefined"
    ? new Error("The workspace search was cancelled.")
    : new DOMException("The workspace search was cancelled.", "AbortError");
}

interface HarnessParameters {
  readonly scenario: "session" | "question" | "long-question" | "files" | "review" | "personalization" | "providers" | "voice" | "automation" | "scheduler" | "connection" | "connections" | "browser" | "background" | "subagents";
  readonly theme: Theme;
  readonly running: boolean;
  readonly queue: boolean;
  readonly queueLock: "none" | "edit" | "interaction";
  readonly queueSource: "user" | "schedule" | "backend" | "retry";
  readonly interaction: boolean;
  readonly composerSendShortcut: ComposerSendShortcutPreference;
  readonly computerUpdate: "none" | "available" | "downloading" | "installing";
  readonly computerPlatform: "win32" | "darwin";
}

function harnessParameters(): HarnessParameters {
  const query = new URLSearchParams(window.location.search);
  const scenarioValue = query.get("scenario");
  const shortcutValue = query.get("shortcut");
  const themeValue = query.get("theme");
  const updateValue = query.get("computerUpdate");
  return {
    scenario: scenarioValue === "question"
      || scenarioValue === "long-question"
      || scenarioValue === "files"
      || scenarioValue === "review"
      || scenarioValue === "personalization"
      || scenarioValue === "providers"
      || scenarioValue === "voice"
      || scenarioValue === "automation"
      || scenarioValue === "scheduler"
      || scenarioValue === "connection"
      || scenarioValue === "connections"
      || scenarioValue === "browser"
      || scenarioValue === "background"
      || scenarioValue === "subagents"
      ? scenarioValue
      : "session",
    theme: themeValue === "dark" ? "dark" : "light",
    running: query.get("running") === "1",
    queue: query.get("queue") === "1",
    queueLock: query.get("queueLock") === "edit"
      ? "edit"
      : query.get("queueLock") === "interaction" ? "interaction" : "none",
    queueSource: query.get("queueSource") === "schedule"
      ? "schedule"
      : query.get("queueSource") === "backend"
        ? "backend"
        : query.get("queueSource") === "retry" ? "retry" : "user",
    interaction: query.get("interaction") !== "0",
    composerSendShortcut: shortcutValue === "modifier-enter" || shortcutValue === "modifierEnter" ? "modifier-enter" : "enter",
    computerUpdate: updateValue === "available" || updateValue === "downloading" || updateValue === "installing"
      ? updateValue
      : "none",
    computerPlatform: query.get("platform") === "darwin" ? "darwin" : "win32"
  };
}

function initialControllerState(parameters: HarnessParameters, files: VisualWorkspaceFiles): ControllerState {
  const activeProfile = {
    id: "visual-profile",
    deviceId: "visual-desktop",
    serverId: "visual-server",
    name: "Visual Harness",
    origin: "http://127.0.0.1"
  };
  const managedConnectionProfile = {
    id: "visual-managed-profile",
    deviceId: "visual-managed-device",
    serverId: "visual-managed-server",
    name: "This computer",
    origin: "http://127.0.0.1:4318",
    managedLocal: true
  } as const;
  const savedConnectionProfile = {
    id: "visual-saved-profile",
    deviceId: "visual-saved-device",
    serverId: "visual-saved-server",
    name: "Studio node",
    origin: "https://studio.example.test",
    lastConnectedAt: FIXED_NOW - 60_000
  } as const;
  const connectionScenario = parameters.scenario === "connection";
  return {
    ready: true,
    connectionState: connectionScenario ? "disconnected" : "connected",
    profiles: connectionScenario
      ? [managedConnectionProfile, savedConnectionProfile]
      : parameters.scenario === "connections" ? [activeProfile] : [],
    machineCaches: [],
    machinePresenceByProfile: { [activeProfile.id]: "current" },
    activeProfile: connectionScenario ? undefined : activeProfile,
    discoveredNodes: connectionScenario
      ? [{
          serverId: "visual-nearby-server",
          name: "Nearby review node",
          origin: "https://nearby.example.test",
          version: "0.1.0",
          apiVersion: "v1",
          pairingEnabled: true,
          lastSeenAt: FIXED_NOW,
          source: "orchestrator",
          transport: "https"
        }]
      : [],
    discoveryState: connectionScenario ? "ready" : "idle",
    discoveryError: connectionScenario ? "Nearby node discovery timed out. Refresh to try again." : undefined,
    managedOrchestratorStatus: connectionScenario
      ? { state: "recoveryRequired", reason: "credentialRejected" }
      : undefined,
    automaticConnectionAvailable: true,
    snapshot: visualSnapshot(parameters, files),
    route: parameters.scenario === "files"
      ? { kind: "files", sessionId: "session-1", file: "src/App.tsx" }
      : parameters.scenario === "personalization" || parameters.scenario === "providers" || parameters.scenario === "voice" || parameters.scenario === "connections"
        ? { kind: "settings" }
        : parameters.scenario === "automation"
          ? { kind: "session", sessionId: "session-1" }
          : parameters.scenario === "scheduler"
            ? { kind: "schedules", scheduleId: "visual-schedule-daily" }
          : parameters.scenario === "browser"
            ? { kind: "tools" }
          : { kind: "session", sessionId: "session-1" },
    preferences: {
      ...DEFAULT_UI_PREFERENCES,
      locale: "en",
      theme: parameters.theme,
      inspectorOpen: parameters.scenario === "subagents",
      navigationOpen: true,
      navigationMode: "expanded",
      navigationWidth: 260,
      composerSendShortcut: parameters.composerSendShortcut,
      messageSearchSort: "relevance"
    },
    error: connectionScenario ? "The saved node rejected this connection. Pair again to restore access." : undefined,
    extensionNotifications: []
  };
}

function visualSnapshot(parameters: HarnessParameters, files: VisualWorkspaceFiles): AppSnapshot {
  const browserTakeoverNow = Date.now();
  const base = emptySnapshot();
  const model = {
    backendId: "visual-backend",
    providerId: "visual-provider",
    providerName: "Joko Visual",
    modelId: "vision-model",
    name: "Vision Model",
    available: true,
    supportsImages: true,
    inputModalities: ["text", "image", "file"] as const,
    outputModalities: ["text"] as const,
    supportsFast: true,
    efforts: ["low", "medium", "high"],
    contextWindow: 128_000,
    maximumOutputTokens: 16_384,
    inputCostMicrosPerMillion: 0,
    outputCostMicrosPerMillion: 0,
    currencyCode: "USD"
  };
  const textModel = {
    ...model,
    modelId: "text-model",
    name: "Text Model",
    supportsImages: false,
    inputModalities: ["text"] as const
  };
  const capabilities = new Map<string, BackendView["capabilities"] extends ReadonlyMap<string, infer Capability> ? Capability : never>([
    ["turn.abort", capability("turn.abort")],
    ["turn.follow_up", capability("turn.follow_up")],
    ["turn.steer", capability("turn.steer")],
    ["input.image", capability("input.image", [], 8 * 1024 * 1024, 4)],
    ["input.file", capability("input.file", [], 8 * 1024 * 1024, 4)],
    ["permission.change", capability("permission.change")],
    ["permission.modes", capability("permission.modes", ["ask", "auto", "bypassPermissions", "planMode"])],
    ["model.switch", capability("model.switch")],
    ["model.effort", capability("model.effort")],
    ["model.fast_mode", capability("model.fast_mode")],
    ["provider.managed_catalog", capability("provider.managed_catalog")],
    ["runtime.commands", capability("runtime.commands")],
    ["runtime.user_shell", capability("runtime.user_shell")],
    ["context.compact", capability("context.compact")],
    ["context.silent_encrypted_retry", capability("context.silent_encrypted_retry")],
    ["memory.curated", capability("memory.curated")],
    ["memory.compaction_digest", capability("memory.compaction_digest")],
    ["session.export", capability("session.export")],
    ["session.clone", capability("session.clone")],
    ["session.discovery", capability("session.discovery")],
    ["session.catalog", capability("session.catalog")],
    ["session.resume", capability("session.resume")],
    ["background.tasks", capability("background.tasks")],
    ["subagents.list", capability("subagents.list")],
    ["subagents.detail", capability("subagents.detail")],
    ["subagents.transcript", capability("subagents.transcript")],
    ["subagents.control", capability("subagents.control")],
    ["workspace.files", capability("workspace.files")],
    ["workspace.files.write", capability("workspace.files.write")]
  ]);
  const providerConfiguration: AppSnapshot["settings"]["providers"][number] = {
    id: "api",
    name: "api",
    kind: "apiKey",
    compatibility: "openaiResponses",
    endpoint: "",
    credentialId: "",
    enabled: false,
    keyless: false,
    authHeader: false,
    environmentName: "",
    modelCount: 0,
    headers: [],
    models: []
  };
  const providerCatalogModel = (
    backendId: string,
    modelId: string,
    name: string,
    overrides: Partial<AppSnapshot["models"][number]> = {}
  ): AppSnapshot["models"][number] => ({
    ...model,
    backendId,
    providerId: "openai",
    providerName: "OpenAI",
    modelId,
    name,
    supportsImages: false,
    inputModalities: ["text"],
    outputModalities: ["text"],
    contextWindow: 272_000,
    maximumOutputTokens: 32_000,
    ...overrides
  });
  const providerModels: AppSnapshot["models"] = [
    providerCatalogModel("visual-code", "gpt-5.6-luna", "GPT-5.6-Luna"),
    providerCatalogModel("visual-code", "gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"),
    providerCatalogModel("visual-code", "gpt-5.6-sol", "GPT-5.6-Sol"),
    providerCatalogModel("visual-code", "gpt-5.6-sol-long", "GPT-5.6-Sol (1M · Higher usage)", { contextWindow: 1_000_000 }),
    providerCatalogModel("visual-code", "gpt-5.6-terra", "GPT-5.6-Terra"),
    providerCatalogModel("visual-code", "gpt-5.5", "GPT-5.5", { defaultVisible: false }),
    providerCatalogModel("visual-code", "gpt-5.4", "GPT-5.4", { defaultVisible: false }),
    providerCatalogModel("visual-code", "gpt-5.4-mini", "GPT-5.4-Mini", { defaultVisible: false })
  ];
  const providerRuntimes: AppSnapshot["providers"] = [
    {
      backendId: "visual-code",
      id: "openai",
      name: "OpenAI",
      kind: "subscription",
      accessProduct: "ChatGPT",
      compatibility: providerConfiguration.compatibility,
      authenticationState: "authenticated" as const,
      endpoint: "",
      ownerManaged: false,
      routingEnabled: true,
      supportsLogin: false,
      loginMethods: [],
      supportsLogout: true,
      supportsRefresh: true,
      supportsModelRefresh: true,
      credentialSurfaces: [{
        id: "image-generation",
        capability: "imageGeneration",
        kind: "apiKey",
        configured: false,
        models: [{ modelId: "gpt-image-2", name: "GPT Image 2" }]
      }],
      capabilities: new Set<string>()
    },
    {
      backendId: "visual-pi",
      id: providerConfiguration.id,
      name: providerConfiguration.name,
      kind: providerConfiguration.kind,
      accessProduct: "API",
      compatibility: providerConfiguration.compatibility,
      authenticationState: "signedOut",
      endpoint: "",
      ownerManaged: true,
      routingEnabled: false,
      supportsLogin: true,
      loginMethods: ["apiKey"],
      supportsLogout: false,
      supportsRefresh: true,
      supportsModelRefresh: true,
      credentialSurfaces: [],
      capabilities: new Set<string>()
    },
    {
      backendId: "visual-local-cli",
      id: "anthropic-cli",
      name: "Anthropic",
      kind: "subscription",
      accessProduct: "Claude",
      compatibility: "anthropic",
      authenticationState: "signedOut",
      endpoint: "",
      ownerManaged: false,
      routingEnabled: true,
      supportsLogin: true,
      loginMethods: ["subscription"],
      supportsLogout: true,
      supportsRefresh: true,
      supportsModelRefresh: false,
      credentialSurfaces: [],
      capabilities: new Set<string>()
    }
  ];
  const providerBackends: AppSnapshot["backends"] = [
    { id: "visual-code", name: "Codex", version: "dev", health: "healthy", installationState: "installed", capabilities },
    { id: "visual-pi", name: "Pi", version: "dev", health: "healthy", installationState: "installed", capabilities },
    { id: "visual-local-cli", name: "Claude Code", version: "dev", health: "healthy", installationState: "installed", capabilities }
  ];
  const filesSessionNames = ["End-to-end visual verification", "Polish file browser interactions", "Verify Pi RPC contract"];
  const sessions: SessionView[] = Array.from({ length: parameters.scenario === "files" ? filesSessionNames.length : 9 }, (_, index) => ({
    id: `session-${index + 1}`,
    backendId: "visual-backend",
    targetId: "visual-target",
    name: parameters.scenario === "files"
      ? filesSessionNames[index] ?? `Deterministic task ${index + 1}`
      : index === 0 ? "End-to-end visual verification" : `Deterministic task ${index + 1}`,
    state: index === 0 && (parameters.running || parameters.scenario === "subagents") ? "running" : "idle",
    generation: 1n,
    pinned: index === 0,
    archived: false,
    model,
    effort: "medium",
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: FIXED_NOW - index * 60_000,
    ...(index === 0 && (parameters.running || parameters.scenario === "subagents") ? { activeRunId: "visual-run" } : {}),
    ...(parameters.scenario === "scheduler" && (index === 1 || index === 2) ? {
      automationOrigin: {
        kind: "scheduler" as const,
        scheduleId: "visual-schedule-daily",
        scheduleName: "Daily product health"
      }
    } : {})
  }));
  const timelineBySession = new Map(base.timelineBySession);
  timelineBySession.set("session-1", [
    { id: "message-1", sequence: 1n, kind: "user", createdAt: FIXED_NOW - 4_000, text: "Inspect the coding interface across runtime, interaction, and recovery surfaces." },
    { id: "message-2", sequence: 2n, kind: "assistant", createdAt: FIXED_NOW - 2_000, text: "The deterministic harness renders the real Joko components.\n\n- Keyboard behavior\n- Responsive geometry\n- Question wizard", streaming: parameters.running },
    ...(parameters.scenario === "subagents" ? [{
      id: "subagent-running",
      sequence: 3n,
      kind: "background" as const,
      createdAt: FIXED_NOW - 12 * 60_000,
      background: {
        id: VISUAL_SUBAGENT_ROOT_ID,
        title: "Coordinate complete product coverage",
        state: "running" as const,
        detail: "Parallel delegated work is reconciling runtime behavior, visual evidence, and recovery paths.",
        parentTaskId: "visual-product-verification",
        runId: "visual-run",
        progressRatio: 0.74,
        startedAt: FIXED_NOW - 12 * 60_000
      }
    }] : []),
    ...(parameters.scenario === "background" ? [{
      id: "background-running",
      sequence: 3n,
      kind: "background" as const,
      createdAt: FIXED_NOW - 8 * 60_000,
      background: {
        id: "research-runner",
        title: "Map runtime compatibility",
        state: "running" as const,
        detail: "Comparing lifecycle commands and optional capabilities",
        parentTaskId: "visual-audit",
        runId: "visual-run",
        progressRatio: 0.62,
        startedAt: FIXED_NOW - 8 * 60_000
      }
    }, {
      id: "background-completed",
      sequence: 4n,
      kind: "background" as const,
      createdAt: FIXED_NOW - 22 * 60_000,
      background: {
        id: "ui-audit",
        title: "Inspect interaction states",
        state: "completed" as const,
        detail: "Documented list, detail, loading, empty, and error states",
        parentTaskId: "visual-audit",
        runId: "visual-run",
        progressRatio: 1,
        startedAt: FIXED_NOW - 22 * 60_000,
        endedAt: FIXED_NOW - 13 * 60_000
      }
    }, {
      id: "background-failed",
      sequence: 5n,
      kind: "background" as const,
      createdAt: FIXED_NOW - 35 * 60_000,
      background: {
        id: "provider-check",
        title: "Verify provider chain",
        state: "failed" as const,
        detail: "Provider credentials are unavailable in this deterministic harness",
        parentTaskId: "visual-audit",
        runId: "visual-run",
        startedAt: FIXED_NOW - 35 * 60_000,
        endedAt: FIXED_NOW - 34 * 60_000,
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: "A real provider is required for this acceptance gate.",
          phase: "provider",
          severity: "blocked" as const,
          retryable: false,
          recovery: []
        }
      }
    }] : []),
    ...(parameters.scenario === "review" ? [{
      id: "review-completed",
      sequence: 3n,
      kind: "review" as const,
      createdAt: FIXED_NOW - 90_000,
      review: {
        id: "visual-review",
        sourceSessionId: "session-1",
        reviewerSessionId: "session-2",
        state: "completed" as const,
        freshness: "stale" as const,
        freshnessCheckedAt: FIXED_NOW - 30_000,
        targetKind: "mixed" as const,
        evidence: {
          sealSha256: "7f2e760e4cc9fdb11901e8f6e1dc901ed760350b0e44be71d28e80e1c73165af",
          capturedAt: FIXED_NOW - 120_000
        },
        result: "### Review conclusion\n\nThe inspected evidence is current and the first-stage read-only review completed without blocking findings.",
        createdAt: FIXED_NOW - 120_000,
        updatedAt: FIXED_NOW - 30_000,
        endedAt: FIXED_NOW - 30_000,
        revision: 2n
      }
    }] : [])
  ]);
  const interactions = parameters.scenario === "session"
    || parameters.scenario === "background"
    || parameters.scenario === "personalization"
    || parameters.scenario === "automation"
    || parameters.scenario === "browser"
    || parameters.scenario === "review"
    || parameters.scenario === "subagents"
    || !parameters.interaction
    ? []
    : [questionInteraction(parameters.scenario === "long-question")];
  const browserSettings = {
    browserProviderId: "visual-browser",
    profileDisplayName: "Agent browser",
    takeoverTimeoutSeconds: 900,
    allowUploads: true,
    allowDownloads: true,
    automationTarget: "external" as const,
    support: "supported" as const,
    supportReason: "",
    detectedBrowser: "Google Chrome",
    targetSettings: [{ targetId: "visual-target", enabled: true }],
    backendHealth: {
      active: true,
      status: "ready" as const,
      canRecover: true
    }
  };
  const settings = parameters.scenario === "providers"
    ? {
        ...base.settings,
        revision: 1n,
        providers: [providerConfiguration],
        backendSettings: providerBackends.map((backend) => ({
          backendId: backend.id,
          enabled: true,
          permissionMode: "ask" as const,
          planMode: false,
          modelAccess: {
            disabledProviderIds: [],
            disabledModels: []
          }
        }))
      }
    : parameters.scenario === "personalization"
    ? {
        ...base.settings,
        revision: 1n,
        pi: [{
          backendId: "visual-backend",
          autoCompaction: true,
          autoCompactionThresholdPercent: 75,
          autoCompactionThresholdCustomized: false,
          autoRetry: true,
          steeringMode: "all" as const,
          followUpMode: "all" as const
        }],
        messageSearch: {
          ...base.settings.messageSearch,
          semanticIndexEnabled: true,
          vectorAvailable: true,
          embeddingProviderAvailable: true,
          doneCount: 24
        },
        memory: {
          makerEnabled: true,
          makerSupported: true,
          makerReason: "",
          customized: false,
          entryCount: 5,
          backends: [{
            backendId: "visual-backend",
            enabled: true,
            supported: true,
            reason: "",
            entryCount: 2
          }]
        },
        visionBridge: {
          enabled: true,
          targetModels: [{ backendId: textModel.backendId, providerId: textModel.providerId, modelId: textModel.modelId }],
          primary: { backendId: model.backendId, providerId: model.providerId, modelId: model.modelId },
          available: true,
          unavailableReason: "",
          customized: true,
          customizedFields: ["enabled", "primary"]
        },
        promptRecommendation: {
          enabled: true,
          available: true,
          unavailableReason: "",
          customized: false
        }
      }
    : parameters.scenario === "voice"
      ? {
          ...base.settings,
          revision: 1n,
          providers: [{
            id: "visual-text-provider",
            name: "Visual text provider",
            kind: "managed" as const,
            compatibility: "openaiResponses" as const,
            endpoint: "https://provider.invalid/v1",
            credentialId: "",
            enabled: true,
            keyless: true,
            authHeader: false,
            environmentName: "",
            modelCount: 1,
            headers: [],
            models: [{
              modelId: "visual-refiner",
              name: "Visual Refiner",
              reasoning: false,
              inputModalities: ["text" as const],
              contextWindowTokens: 128_000,
              maximumOutputTokens: 4_096,
              inputCostMicrosPerMillion: 1_000_000,
              outputCostMicrosPerMillion: 4_000_000,
              cacheReadCostMicrosPerMillion: 0,
              cacheWriteCostMicrosPerMillion: 0,
              thinkingLevels: [],
              supportsFastMode: false
            }]
          }],
          voiceInput: {
            ...base.settings.voiceInput,
            enabled: true,
            protocol: "openAiCompatibleRealtime" as const,
            endpoint: "wss://speech.invalid/v1/realtime?intent=transcription",
            model: "gpt-realtime-whisper",
            keyless: true,
            refinementEnabled: true,
            refinerProviderId: "visual-text-provider",
            refinerModelId: "visual-refiner",
            revision: 1n
          }
        }
    : parameters.scenario === "automation"
      ? {
          ...base.settings,
          revision: 1n,
          browsers: [browserSettings],
          computerAutomation: {
            enabled: parameters.computerUpdate !== "none",
            support: "supported" as const,
            supportReason: "",
            installed: parameters.computerUpdate !== "none",
            driverVersion: parameters.computerUpdate === "none" ? "" : "1.0.0",
            daemonRunning: parameters.computerUpdate !== "none",
            accessibilityPermission: parameters.computerPlatform === "darwin" ? "granted" as const : "notRequired" as const,
            screenRecordingPermission: parameters.computerPlatform === "darwin" ? "granted" as const : "notRequired" as const,
            screenRecordingCapturable: true,
            ready: parameters.computerUpdate !== "none",
            runtimeState: parameters.computerUpdate === "none" ? "unavailable" as const : "ready" as const,
            failureReason: parameters.computerUpdate === "none" ? "The local driver is not installed." : "",
            platform: parameters.computerPlatform,
            updateCurrentVersion: parameters.computerUpdate === "none" ? "" : "1.0.0",
            updateLatestVersion: parameters.computerUpdate === "none" ? "" : "1.1.0",
            updateAvailable: parameters.computerUpdate !== "none",
            updateInProgress: parameters.computerUpdate === "downloading" || parameters.computerUpdate === "installing",
            updatePhase: parameters.computerUpdate === "downloading"
              ? "downloading" as const
              : parameters.computerUpdate === "installing" ? "installing" as const : "idle" as const,
            ...(parameters.computerUpdate === "downloading" ? {
              updateDownloadedBytes: 42,
              updateTotalBytes: 100
            } : {})
          },
          androidAutomation: {
            enabled: true,
            support: "supported" as const,
            supportReason: "",
            adbAvailable: true,
            adbPath: "D:\\visual\\platform-tools\\adb.exe",
            adbPathSource: "prepared" as const,
            preparationSupported: true,
            preparationReady: true,
            preparationError: "",
            adbVersion: "1.0.41",
            devices: [{
              deviceSerial: "emulator-5554",
              state: "device",
              product: "sdk_gphone64_x86_64",
              model: "Pixel_8",
              device: "emu64xa",
              transportId: "1",
              usb: ""
            }, {
              deviceSerial: "R5CW11TEST",
              state: "unauthorized",
              product: "",
              model: "Galaxy_S24",
              device: "",
              transportId: "2",
              usb: "1-2"
            }],
            defaultDeviceSerial: "emulator-5554",
            configuredDefaultDeviceSerial: "",
            adbPathOverride: "",
            issue: "unspecified" as const,
            failureReason: "",
            platform: "win32",
            runtimeState: "ready" as const,
            statusObserved: true
          }
        }
      : parameters.scenario === "browser"
        ? { ...base.settings, revision: 1n, browsers: [browserSettings] }
        : base.settings;
  return {
    ...base,
    revision: 1n,
    cursor: 2n,
    generation: 1n,
    server: { name: "Visual Joko", version: "dev", health: "healthy" },
    backends: parameters.scenario === "providers"
      ? [{ id: "visual-backend", name: "Visual backend", version: "dev", health: "healthy", capabilities }, ...providerBackends]
      : [{ id: "visual-backend", name: "Visual backend", version: "dev", health: "healthy", capabilities }],
    models: parameters.scenario === "providers" ? [model, textModel, ...providerModels] : [model, textModel],
    providers: parameters.scenario === "providers" ? providerRuntimes : parameters.scenario === "personalization" ? [{
      backendId: "visual-backend",
      id: "visual-provider",
      name: "Joko Visual",
      kind: "managed",
      compatibility: "openaiResponses",
      authenticationState: "authenticated",
      endpoint: "https://provider.invalid/v1",
      ownerManaged: true,
      supportsLogin: false,
      loginMethods: [],
      supportsLogout: true,
      supportsRefresh: true,
      supportsModelRefresh: false,
      credentialSurfaces: [],
      capabilities: new Set()
    }] : [],
    managedModelRuntimes: parameters.scenario === "personalization" ? [{
      id: "visual-local-runtime",
      name: "Ollama",
      state: "absent",
      source: "none",
      capabilities: {
        canInstall: true,
        canCancelInstall: false,
        canStart: false,
        canListModels: false,
        canPullModels: false,
        canDeleteModels: false,
        canPausePulls: false,
        canResumePulls: false,
        canCancelPulls: false,
        supportsCustomModels: false,
        supportsCuratedCatalog: false,
        supportsModelPreflight: false
      },
      installPreflight: {
        allowed: true,
        memory: "unknown",
        disk: "unknown",
        requiredDiskBytes: 0
      },
      installedModels: [],
      catalog: [],
      transfers: [],
      revision: 0n
    }] : [],
    targets: [{ id: "visual-target", backendId: "visual-backend", name: "Joko workspace", workspaceId: "visual-workspace", workspaceName: "Joko workspace", trusted: true, pinned: true, archived: false }],
    sessions,
    schedules: parameters.scenario === "scheduler" ? visualSchedulerSchedules() : [],
    timelineBySession,
    reviewRuns: parameters.scenario === "review" ? [{
      id: "visual-review",
      sourceSessionId: "session-1",
      reviewerSessionId: "session-2",
      state: "completed",
      freshness: "stale",
      freshnessCheckedAt: FIXED_NOW - 30_000,
      targetKind: "mixed",
      evidence: {
        sealSha256: "7f2e760e4cc9fdb11901e8f6e1dc901ed760350b0e44be71d28e80e1c73165af",
        capturedAt: FIXED_NOW - 120_000
      },
      result: "### Review conclusion\n\nThe inspected evidence is current and the first-stage read-only review completed without blocking findings.",
      createdAt: FIXED_NOW - 120_000,
      updatedAt: FIXED_NOW - 30_000,
      endedAt: FIXED_NOW - 30_000,
      revision: 2n
    }] : [],
    backgroundTasks: parameters.scenario === "background" ? [
      { id: "research-runner", sessionId: "session-1", state: "running" },
      { id: "ui-audit", sessionId: "session-1", state: "completed" },
      { id: "provider-check", sessionId: "session-1", state: "failed" }
    ] : [],
    queue: parameters.queue ? [{ id: "visual-queue", sessionId: "session-1", revision: 1n, generation: 1n, source: parameters.queueSource, mode: "followUp", text: "Queued visual follow-up", state: "queued", editLocked: parameters.queueLock === "edit", ordinal: 1, createdAt: FIXED_NOW }] : [],
    queueControls: parameters.queue ? [{ sessionId: "session-1", revision: 1n, generation: 1n, state: "active", interactionLocked: parameters.queueLock === "interaction", queuedItemCount: 1 }] : [],
    interactions,
    devices: parameters.scenario === "connections"
      ? [{
          id: "visual-desktop",
          name: "Desktop",
          kind: "desktop",
          platform: "win32",
          appVersion: "0.1.0",
          revoked: false,
          remoteControlEnabled: true,
          presence: "online",
          lastSeenAt: FIXED_NOW
        }]
      : [],
    remoteConnections: parameters.scenario === "connections"
      ? [
          {
            id: "visual-profile",
            deviceId: "visual-desktop",
            name: "Desktop local instance",
            state: "connected",
            lastSeenAt: FIXED_NOW
          },
          ...Array.from({ length: 8 }, (_, index) => ({
            id: `visual-revoked-${index}`,
            deviceId: "visual-desktop",
            name: "Desktop local instance",
            state: "revoked" as const,
            lastSeenAt: FIXED_NOW - (index + 1) * 60_000
          }))
        ]
      : [],
    browsers: parameters.scenario === "automation"
      ? [{ id: "visual-browser", name: "Agent browser", state: "ready", generation: 1n, pages: [] }]
      : parameters.scenario === "browser"
        ? [{
            id: "visual-browser",
            name: "Agent browser",
            state: "ready",
            generation: 4n,
            takeover: {
              id: "visual-takeover",
              pageId: "visual-page",
              connectionId: "visual-profile",
              state: "active",
              generation: 4n,
              startedAt: browserTakeoverNow - 8_000,
              expiresAt: browserTakeoverNow + 600_000
            },
            pages: [{
              id: "visual-page",
              sessionId: "session-1",
              title: "Joko Browser fixture",
              url: "https://example.test/docs",
              state: "ready",
              screenshotBlobId: "visual-blob:assets/preview.png",
              lastActivityAt: FIXED_NOW - 2_000,
              canGoBack: true,
              canGoForward: false,
              recoverable: false,
              lastKnownGeneration: 4n
            }]
          }]
        : [],
    settings,
    workspaces: [{
      id: "visual-workspace",
      targetId: "visual-target",
      name: "Joko workspace",
      kind: "userProject",
      serverPath: "D:\\joko",
      trusted: true,
      branch: "visual-harness",
      dirty: false,
      revision: files.workspaceRevision,
      entries: files.list("")
    }],
    resources: [{
      id: "visual-skill",
      backendId: "visual-backend",
      targetId: "visual-target",
      name: "ui-audit",
      kind: "skill",
      scope: "project",
      state: "loaded",
      enabled: true,
      source: "visual",
      discoveredRevision: "1",
      compatibilityDetails: [],
      runtimeRequirements: [],
      warnings: [],
      disabledLifecycleScripts: [],
      canToggle: true,
      requiresExtensionApproval: false,
      postMutationNotice: false
    }],
    commands: [
      { id: "command-review", name: "review", description: "Review the current changes", source: "backend", loaded: true },
      { id: "command-test", name: "test", description: "Run the narrow checks", source: "backend", loaded: true }
    ]
  };
}

function capability(name: string, options: readonly string[] = [], maximumBytes?: number, maximumItems?: number) {
  return { name, supported: true, options, ...(maximumBytes === undefined ? {} : { maximumBytes }), ...(maximumItems === undefined ? {} : { maximumItems }) };
}

function visualSchedulerSchedules(): readonly ScheduleView[] {
  const persistentHistory: ScheduleView["history"] = [{
    id: "history-completed-unread",
    runId: "visual-run-costed",
    sessionId: "session-2",
    state: "completed",
    scheduledAt: FIXED_NOW - 65 * 60_000,
    triggeredAt: FIXED_NOW - 64 * 60_000,
    finishedAt: FIXED_NOW - 61 * 60_000,
    durationMs: 180_000,
    resultText: "All product health checks passed and the release summary was published.",
    zeroCost: false,
    costAttribution: "mixed",
    cost: {
      amount: 0.428,
      currency: "USD",
      approximate: false,
      kind: "actual-cost",
      estimateReasons: []
    },
    estimatedValue: {
      amount: 1.25,
      currency: "USD",
      approximate: true,
      kind: "value-estimate",
      estimateReasons: ["subscription-value", "reference-price"]
    },
    preRun: {
      status: "passed",
      decision: "run",
      exitCode: 0,
      durationMs: 420,
      stdout: "health gate passed",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false
    }
  }, {
    id: "history-completed-read",
    runId: "visual-run-previous",
    sessionId: "session-2",
    state: "completed",
    scheduledAt: FIXED_NOW - 25 * 60 * 60_000,
    triggeredAt: FIXED_NOW - 25 * 60 * 60_000,
    finishedAt: FIXED_NOW - 25 * 60 * 60_000 + 92_000,
    durationMs: 92_000,
    resultText: "Previous daily check completed.",
    zeroCost: false,
    costAttribution: "direct",
    cost: {
      amount: 0.19,
      currency: "USD",
      approximate: false,
      kind: "actual-cost",
      estimateReasons: []
    },
    readAt: FIXED_NOW - 24 * 60 * 60_000
  }, {
    id: "history-interrupted",
    runId: "visual-run-interrupted",
    sessionId: "",
    state: "interrupted",
    scheduledAt: FIXED_NOW - 36 * 60_000,
    triggeredAt: FIXED_NOW - 36 * 60_000,
    finishedAt: FIXED_NOW - 36 * 60_000 + 85,
    durationMs: 85,
    zeroCost: true,
    costAttribution: "zero",
    error: "The pre-run process could not start.",
    preRun: {
      status: "failed",
      decision: "block",
      durationMs: 85,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
      spawnError: "Executable was not found in the selected workspace."
    }
  }, {
    id: "history-skipped",
    runId: "visual-run-skipped",
    sessionId: "",
    state: "skipped",
    scheduledAt: FIXED_NOW - 12 * 60_000,
    triggeredAt: FIXED_NOW - 12 * 60_000,
    finishedAt: FIXED_NOW - 12 * 60_000 + 32,
    durationMs: 32,
    resultText: "No relevant changes were detected.",
    zeroCost: true,
    costAttribution: "zero"
  }];
  const daily: ScheduleView = {
    id: "visual-schedule-daily",
    name: "Daily product health",
    source: "user",
    backendId: "visual-backend",
    targetId: "visual-target",
    sessionMode: "persistent",
    sessionId: "session-2",
    enabled: true,
    kind: "cron",
    expression: "0 9 * * *",
    timezone: "Asia/Shanghai",
    inputText: "Check the current product health and summarize actionable regressions.",
    executionMode: "agent",
    model: { providerId: "visual-provider", modelId: "vision-model", effort: "medium", fastMode: false },
    permissionMode: "ask",
    planMode: false,
    useWorktree: false,
    refreshWorktreeRemote: false,
    extraDirectoryIds: [],
    silentWhenIdle: false,
    notifyDesktop: true,
    overlapPolicy: "queue",
    misfirePolicy: "runOnce",
    nextRunAt: FIXED_NOW + 5 * 60 * 60_000,
    lastRun: { state: "completed", at: FIXED_NOW - 61 * 60_000 },
    unreadRunCount: visualUnreadScheduleRunCount(persistentHistory),
    history: persistentHistory
  };
  const projectHistory: ScheduleView["history"] = [{
    id: "history-project-failed",
    runId: "visual-project-failed",
    sessionId: "session-3",
    state: "failed",
    scheduledAt: FIXED_NOW - 2 * 60 * 60_000,
    triggeredAt: FIXED_NOW - 2 * 60 * 60_000,
    finishedAt: FIXED_NOW - 2 * 60 * 60_000 + 4_500,
    durationMs: 4_500,
    zeroCost: false,
    costAttribution: "unavailable",
    error: "The configured provider was temporarily unavailable."
  }];
  return [daily, {
    ...daily,
    id: "visual-schedule-project",
    name: "Project release notes",
    source: "project",
    projectConfigId: "release-notes",
    projectConfigPath: ".joko/automations/schedules.json",
    sessionMode: "fresh",
    sessionId: undefined,
    expression: "30 17 * * 5",
    inputText: "Prepare release notes from this project.",
    useWorktree: true,
    worktreeSourceRef: "main",
    nextRunAt: FIXED_NOW + 2 * 24 * 60 * 60_000,
    lastRun: { state: "failed", at: FIXED_NOW - 2 * 60 * 60_000 },
    unreadRunCount: visualUnreadScheduleRunCount(projectHistory),
    history: projectHistory
  }];
}

function visualSchedulerRuntime(): SchedulerRuntimeView {
  return {
    instanceId: "visual-scheduler-runtime",
    processId: 4242,
    inFlight: 1,
    slotsInUse: 1,
    maxConcurrentRuns: 3,
    runs: [{
      scheduleId: "visual-schedule-daily",
      scheduleName: "Daily product health",
      runId: "visual-live-schedule-run",
      source: "runNow",
      executionMode: "agent",
      startedAt: FIXED_NOW - 12_000,
      phase: "running",
      lastProgressAt: FIXED_NOW - 1_000
    }],
    waiting: []
  };
}

function visualScheduleRunUnread(run: ScheduleView["history"][number]): boolean {
  return run.readAt === undefined && (
    run.state === "completed"
    || run.state === "failed"
    || run.state === "aborted"
    || run.state === "interrupted"
  );
}

function visualUnreadScheduleRunCount(history: ScheduleView["history"]): number {
  return history.filter(visualScheduleRunUnread).length;
}

function questionInteraction(long: boolean): InteractionView {
  const longOptions = Array.from({ length: 14 }, (_, index) => ({
    id: `option-${index + 1}`,
    label: `Detailed visual choice ${index + 1}`,
    description: "A deliberately long option description used to verify that the real question card scrolls without moving its action row."
  }));
  return {
    id: long ? "visual-long-question" : "visual-question",
    sessionId: "session-1",
    generation: 1n,
    kind: "question",
    title: long ? "Choose from long options" : "Confirm the implementation details",
    message: "This deterministic question contains no credentials or external data.",
    options: [],
    fields: long ? [{
      id: "long-choice",
      label: "Choose one option",
      description: "The action row should remain visible while this list scrolls.",
      required: true,
      kind: "single",
      options: longOptions,
      multiline: false,
      sensitive: false,
      minimumSelections: 0
    }] : [
      { id: "summary", label: "Audit summary", description: "Required before continuing.", required: true, kind: "text", options: [], placeholder: "Type a deterministic answer", multiline: true, sensitive: false, minimumSelections: 0 },
      { id: "density", label: "Navigation density", required: true, kind: "single", options: [{ id: "compact", label: "Compact", description: "Use 32px rows." }, { id: "comfortable", label: "Comfortable" }], multiline: false, sensitive: false, minimumSelections: 0 },
      { id: "evidence", label: "Evidence to retain", required: true, kind: "multiple", options: [{ id: "geometry", label: "Geometry" }, { id: "keyboard", label: "Keyboard" }, { id: "motion", label: "Motion" }], multiline: false, sensitive: false, minimumSelections: 1, maximumSelections: 2 },
      { id: "approved", label: "Approve the result?", required: true, kind: "boolean", options: [], multiline: false, sensitive: false, minimumSelections: 0 }
    ],
    planSteps: [],
    createdAt: FIXED_NOW
  };
}
