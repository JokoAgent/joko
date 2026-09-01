import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { capabilityNames } from "@joko/contracts";
import {
  ArrowLeft,
  Bell,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CirclePlus,
  Database,
  Eye,
  EyeOff,
  FileInput,
  Info,
  KeyRound,
  Keyboard,
  ListOrdered,
  Mic,
  Monitor,
  MonitorCog,
  MonitorUp,
  MoreHorizontal,
  MousePointerClick,
  Moon,
  Network,
  Pencil,
  Power,
  RotateCcw,
  RefreshCw,
  Search,
  Server,
  Shield,
  Sun,
  Sparkles,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import type { AppController } from "../controller.js";
import { currentAppShortcutPlatform } from "../app-shortcuts.js";
import { composerVoiceShortcutsConflict } from "../composer-voice-shortcut-conflict.js";
import { isConversationModel } from "../model-capabilities.js";
import { isModelVisible, modelPreferenceOwnerId, providerPreferenceKey, setModelVisible, setProviderDisplayOrder, useModelPickerOwnerPreferences } from "../model-picker-preferences.js";
import type { AppSnapshot, ArtifactStorageCleanupView, ArtifactStorageMaintenanceView, ArtifactStorageReconcileView, ArtifactStorageScanView, BackendView, CredentialDraft, Locale, McpServerView, ModelInputModalityView, ModelView, NativeSessionCatalogEntryView, NativeSessionCatalogView, PermissionMode, ProviderConfigurationView, ProviderCredentialSurfaceView, ProviderDraft, ProviderLoginFlowView, ProviderLoginMethodView, ProviderModelConfigurationView, ProviderRuntimeView, RemoteConnectionView, ResourceDraft, TaskHistoryCleanupProgressView, TaskHistoryCleanupView, TaskHistoryMaintenanceSupportView, TaskHistoryRetentionView, TaskHistoryScanView, Theme } from "../model.js";
import { emptyResourceAcquisitionDraft, normalizeResourceDraft, resourceDraftIsValid } from "../resource-draft.js";
import type { RunAction, Translator } from "./types.js";
import { Button, ErrorBanner, IconButton, Modal, ModalBackButton, Pill, SegmentedControl, Spinner, StatusDot, Tip, cx, formatRelativeTime, CheckboxControl, SelectControl, SwitchControl } from "./ui.js";
import { ProviderLoginDialog } from "./ProviderLoginDialog.js";
import { ProviderMark } from "./ProviderMark.js";
import { ProviderFlowBackButton, ProviderFlowFooter, ProviderWizardProgress } from "./ProviderFlow.js";
import { AppShortcutsSettings } from "./AppShortcutsSettings.js";
import { DesktopAutoRelaunchSetting } from "./DesktopAutoRelaunchSetting.js";
import { DesktopBetaChannelSetting } from "./DesktopBetaChannelSetting.js";
import { PersonalizationMemorySettings } from "./PersonalizationMemorySettings.js";
import { PromptRecommendationCell } from "./PromptRecommendationCell.js";
import { SilentEncryptedRetryCell } from "./SilentEncryptedRetryCell.js";
import { SessionRuntimeFallbackCell } from "./SessionRuntimeFallbackCell.js";
import { VisionBridgeSection } from "./VisionBridgeSection.js";
import { AutomationSettings } from "./AutomationSettings.js";
import { VoiceInputSettings } from "./VoiceInputSettings.js";
import { RuntimeProcessMonitor } from "./RuntimeProcessMonitor.js";
import { RemoteHostsSettings } from "./RemoteHostsSettings.js";
import { ModelPicker } from "./ModelPicker.js";
import { ModelPriceOverrideDialog, type ModelPriceVariant } from "./ModelPriceOverrideDialog.js";
import { PiPackagesSection } from "./PiPackagesSection.js";
import {
  subscribeActivationClickPreference,
  writeActivationClickPreference
} from "../window-activation-click.js";
import { ManagedModelRuntimeSettings } from "./ManagedModelRuntimeSettings.js";
import { RuntimeGovernanceSettings } from "./RuntimeGovernanceSettings.js";
import { ToolPolicySettings } from "./ToolPolicySettings.js";
import { DeviceControlSettings } from "./DeviceControlSettings.js";
import { NativeTaskStatusSettings } from "./NativeTaskStatusSettings.js";
import { McpServerEditor } from "./McpServerEditor.js";
import { ProviderOrderList } from "./ProviderOrderList.js";
import { sha256Hex } from "../web-crypto.js";
import { moveTablistSelection } from "./tablist-navigation.js";
import { resolveNewSessionExecutionOptions } from "./new-session-options.js";
import { advertisedPermissionModes, planModeSupported } from "./backend-control-capabilities.js";
import { MorphPopover } from "./MorphPopover.js";
import { timelineCodeHighlight } from "./timeline-code-highlighting.js";
import { resetWindowLayout } from "../layout-reset-orchestration.js";
import { readVoiceInputPreferences } from "../voice-input-preferences.js";

export const SETTINGS_NAV_SECTION_IDS = [
  "general",
  "personalization",
  "providers",
  "voice",
  "shortcuts",
  "taskStatus",
  "import",
  "connections",
  "tools",
  "automation",
  "about"
] as const;
type SettingsSection = typeof SETTINGS_NAV_SECTION_IDS[number];
type SettingsSubsection = "appearance" | "policy" | "pi" | "backends" | "credentials" | "remoteHosts" | "mcp" | "diagnostics" | "runtime";
interface SettingsLocation {
  readonly section: SettingsSection;
  readonly subsection?: SettingsSubsection;
}
export interface SettingsSuccessNotice { readonly id: number; readonly text: string }
export interface SettingsSuccessQueue {
  readonly active: readonly SettingsSuccessNotice[];
  readonly waiting: readonly SettingsSuccessNotice[];
}
const MAX_ACTIVE_SETTINGS_SUCCESS_NOTICES = 3;

export function enqueueSettingsSuccessNotice(
  current: SettingsSuccessQueue,
  notice: SettingsSuccessNotice
): SettingsSuccessQueue {
  return current.active.length < MAX_ACTIVE_SETTINGS_SUCCESS_NOTICES
    ? { ...current, active: [notice, ...current.active] }
    : { ...current, waiting: [...current.waiting, notice] };
}

export function finishSettingsSuccessNotice(current: SettingsSuccessQueue, id: number): SettingsSuccessQueue {
  if (!current.active.some((notice) => notice.id === id)) return current;
  const remaining = current.active.filter((notice) => notice.id !== id);
  const next = current.waiting[0];
  return next === undefined
    ? { active: remaining, waiting: current.waiting }
    : { active: [next, ...remaining], waiting: current.waiting.slice(1) };
}
const SETTINGS_SECTIONS = new Set<string>(SETTINGS_NAV_SECTION_IDS);
const SETTINGS_SUBSECTION_PARENTS: Readonly<Record<SettingsSubsection, SettingsSection>> = {
  appearance: "general",
  policy: "general",
  pi: "general",
  backends: "about",
  credentials: "providers",
  remoteHosts: "connections",
  mcp: "tools",
  diagnostics: "about",
  runtime: "about"
};
const SETTINGS_SUBSECTIONS = new Set<string>(Object.keys(SETTINGS_SUBSECTION_PARENTS));

export function SettingsPage({ controller, snapshot, activeTargetId, locale, t, runAction, onImportPortableSession }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly activeTargetId?: string;
  readonly locale: Locale;
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onImportPortableSession?: () => void;
}): JSX.Element {
  const nativeTaskStatusVisible = typeof window !== "undefined" && window.jokoDesktop?.capabilities.includes("native.taskStatus") === true;
  const [location, setLocation] = useState<SettingsLocation>(() => availableSettingsLocationFromHash(
    typeof window === "undefined" ? "" : window.location.hash,
    nativeTaskStatusVisible
  ));
  const { section, subsection } = location;
  const [compactSettings, setCompactSettings] = useState(() => settingsViewportIsCompact());
  const [mobileIndexOpen, setMobileIndexOpen] = useState(() => settingsViewportIsCompact() && settingsHashIsRoot(
    typeof window === "undefined" ? "" : window.location.hash
  ));
  const [successNotices, setSuccessNotices] = useState<SettingsSuccessQueue>({ active: [], waiting: [] });
  const successNoticeIdRef = useRef(0);
  useEffect(() => {
    const syncSectionFromLocation = (): void => {
      setLocation(availableSettingsLocationFromHash(window.location.hash, nativeTaskStatusVisible));
      if (compactSettings) setMobileIndexOpen(settingsHashIsRoot(window.location.hash));
    };
    window.addEventListener("hashchange", syncSectionFromLocation);
    return () => window.removeEventListener("hashchange", syncSectionFromLocation);
  }, [compactSettings, nativeTaskStatusVisible]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 720px)");
    const syncViewport = (): void => {
      setCompactSettings(media.matches);
      setMobileIndexOpen(media.matches && settingsHashIsRoot(window.location.hash));
    };
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, []);
  const selectSection = (next: SettingsSection): void => {
    setLocation({ section: next });
    if (compactSettings) setMobileIndexOpen(false);
    const hash = `#/settings/${next}`;
    if (window.location.hash !== hash) window.history.replaceState(window.history.state, "", hash);
  };
  const selectSubsection = (next: SettingsSubsection): void => {
    const parent = SETTINGS_SUBSECTION_PARENTS[next];
    setLocation({ section: parent, subsection: next });
    const hash = `#/settings/${parent}/${next}`;
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  };
  const closeNestedSettings = (): void => {
    setLocation({ section: "general" });
    const hash = "#/settings/general";
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  };
  const showSuccess = useCallback((text: string): void => {
    successNoticeIdRef.current += 1;
    const notice = { id: successNoticeIdRef.current, text };
    setSuccessNotices((current) => enqueueSettingsSuccessNotice(current, notice));
  }, []);
  const finishSuccess = useCallback((id: number): void => {
    setSuccessNotices((current) => finishSettingsSuccessNotice(current, id));
  }, []);
  const personalizationRunAction = useCallback<RunAction>((key, action) => {
    runAction(key, async () => {
      await action();
      const message = personalizationSuccessMessage(key, t);
      if (message !== undefined) showSuccess(message);
    });
  }, [runAction, showSuccess, t]);
  const sections: readonly { id: SettingsSection; label: string; icon: JSX.Element }[] = [
    { id: "general", label: t("settings.general"), icon: <Bell /> },
    { id: "personalization", label: t("settings.personalization"), icon: <Sparkles /> },
    { id: "providers", label: t("settings.providers"), icon: <Server /> },
    { id: "voice", label: t("settings.voiceInput"), icon: <Mic /> },
    { id: "shortcuts", label: t("settings.shortcuts"), icon: <Keyboard /> },
    ...(nativeTaskStatusVisible ? [{ id: "taskStatus" as const, label: t("settings.nativeTaskStatus.title"), icon: <MonitorUp /> }] : []),
    { id: "import", label: t("portable.importTitle"), icon: <FileInput /> },
    { id: "connections", label: t("settings.connections"), icon: <Network /> },
    { id: "tools", label: t("settings.toolPolicies.nav"), icon: <Wrench /> },
    { id: "automation", label: t("settings.automation"), icon: <MonitorCog /> },
    { id: "about", label: t("settings.about"), icon: <Info /> }
  ];
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    if (subsection === undefined || subsection === "pi") {
      content.scrollTo?.({ top: 0 });
      return;
    }
    content.querySelector<HTMLElement>(`#settings-subsection-${subsection}`)?.scrollIntoView?.({ block: "start" });
  }, [section, subsection]);
  const leaveSettings = (): void => {
    if (compactSettings && !mobileIndexOpen) {
      setMobileIndexOpen(true);
      window.history.replaceState(null, "", "#/settings");
      return;
    }
    controller.navigate({ kind: "session" });
  };
  return (
    <main className={cx("route-page", "settings-page", compactSettings && (mobileIndexOpen ? "settings-page--mobile-index" : "settings-page--mobile-detail"))} data-mobile-mode={compactSettings ? mobileIndexOpen ? "index" : "detail" : undefined}>
      {successNotices.active.length > 0 && <div className="settings-success-notifications" aria-label={t("settings.sessionNotifications")}>
        {successNotices.active.map((notice) => <SettingsSuccessToast
          key={notice.id}
          notice={notice}
          onDone={() => finishSuccess(notice.id)}
        />)}
      </div>}
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <header className="settings-sidebar__header">
            <IconButton className="settings-back" label={compactSettings && !mobileIndexOpen ? t("settings.mobileBackToList") : t("settings.back")} onClick={leaveSettings}><ArrowLeft aria-hidden="true" /></IconButton>
            <h1>{t("settings.title")}</h1>
          </header>
          <nav className="settings-nav" aria-label={t("settings.title")} role="tablist" aria-orientation="vertical">{sections.map((item) => <button type="button" role="tab" id={`settings-tab-${item.id}`} aria-controls={`settings-panel-${item.id}`} aria-selected={section === item.id} tabIndex={section === item.id ? 0 : -1} className={section === item.id ? "is-active" : ""} key={item.id} onClick={() => selectSection(item.id)} onKeyDown={(event) => moveTablistSelection(event, "vertical")}>{item.icon}<span>{item.label}</span></button>)}</nav>
        </aside>
        <div className={cx("settings-content-scroll", (section === "providers" || section === "import") && "settings-content-scroll--workbench")} ref={contentRef} key={section}>
          <div className={cx("settings-content", (section === "providers" || section === "import") && "settings-content--workbench")} id={`settings-panel-${section}`} role="tabpanel" aria-labelledby={`settings-tab-${section}`} tabIndex={0}>
            {section === "general" && (subsection === "pi"
              ? <><SettingsNestedBack label={t("settings.general")} onClick={closeNestedSettings} /><PiSettings controller={controller} snapshot={snapshot} runAction={runAction} t={t} /></>
              : <>
                <SettingsHeading title={t("settings.general")} body={t("settings.generalBody")} />
                <SettingsPageSection id="appearance"><SettingsSectionHeading title={t("settings.appearance")} body={t("settings.appearanceBody")} /><AppearanceSettings controller={controller} locale={locale} theme={controller.state.preferences.theme} onSuccess={showSuccess} onOpenPi={() => selectSubsection("pi")} showHeading={false} t={t} /></SettingsPageSection>
                <SettingsPageSection id="general"><SettingsSectionHeading title={t("settings.applicationBehavior")} body={t("settings.applicationBehaviorBody")} /><GeneralSettings controller={controller} snapshot={snapshot} runAction={runAction} onSuccess={showSuccess} showHeading={false} t={t} /></SettingsPageSection>
                <SettingsPageSection id="policy"><SettingsSectionHeading title={t("settings.policy")} body={t("settings.policyBody")} /><PolicySettings controller={controller} snapshot={snapshot} runAction={runAction} showHeading={false} t={t} /></SettingsPageSection>
              </>)}
            {section === "personalization" && <PersonalizationSettings controller={controller} snapshot={snapshot} runAction={personalizationRunAction} onSuccess={showSuccess} t={t} />}
            {section === "shortcuts" && <AppShortcutsSettings controller={controller} overrides={controller.state.preferences.appShortcutOverrides} t={t} />}
            {section === "voice" && <VoiceInputSettings controller={controller} t={t} />}
            {section === "taskStatus" && <><SettingsHeading title={t("settings.nativeTaskStatus.title")} body={t("settings.nativeTaskStatus.body")} /><NativeTaskStatusSettings t={t} showHeading={false} /></>}
            {section === "connections" && <><SettingsHeading title={t("settings.connections")} body={t("settings.connectionsBody")} /><SettingsPageSection id="connections"><ConnectionSettings controller={controller} snapshot={snapshot} locale={locale} t={t} runAction={runAction} showHeading={false} /></SettingsPageSection><SettingsPageSection id="remoteHosts"><RemoteHostsSettings controller={controller} snapshot={snapshot} activeTargetId={activeTargetId} runAction={runAction} t={t} /></SettingsPageSection></>}
            {section === "providers" && <SettingsPageSection id="providers"><ProviderSettings controller={controller} snapshot={snapshot} runAction={runAction} onSuccess={showSuccess} initialView={subsection === "credentials" ? "credentials" : undefined} t={t} /></SettingsPageSection>}
            {section === "tools" && <><SettingsHeading title={t("settings.toolPolicies.nav")} body={t("settings.toolsBody")} /><SettingsPageSection id="tools"><SettingsSectionHeading title={t("settings.toolPolicies.title")} body={t("settings.toolPolicies.body")} /><ToolPolicySettings controller={controller} snapshot={snapshot} activeTargetId={activeTargetId} runAction={runAction} showHeading={false} t={t} /></SettingsPageSection><SettingsPageSection id="mcp"><McpSettings controller={controller} snapshot={snapshot} runAction={runAction} t={t} /></SettingsPageSection></>}
            {section === "automation" && <AutomationSettings controller={controller} snapshot={snapshot} activeTargetId={activeTargetId} runAction={runAction} onSuccess={showSuccess} t={t} />}
            {section === "import" && <TaskImportSettings controller={controller} snapshot={snapshot} onImportPortable={onImportPortableSession} runAction={runAction} onSuccess={showSuccess} t={t} />}
            {section === "about" && <><SettingsPageSection id="about"><AboutSettings controller={controller} snapshot={snapshot} t={t} /></SettingsPageSection><SettingsPageSection id="backends"><SettingsSectionHeading title={t("settings.backends")} body={t("settings.backendsBody")} /><BackendSettings controller={controller} snapshot={snapshot} runAction={runAction} showHeading={false} t={t} /></SettingsPageSection><SettingsPageSection id="diagnostics"><DiagnosticSettings controller={controller} snapshot={snapshot} runAction={runAction} t={t} /></SettingsPageSection><SettingsPageSection id="runtime"><RuntimeProcessMonitor controller={controller} snapshot={snapshot} runAction={runAction} t={t} /></SettingsPageSection></>}
          </div>
        </div>
      </div>
    </main>
  );
}

function SettingsPageSection({ id, children }: {
  readonly id: SettingsSection | SettingsSubsection;
  readonly children: ReactNode;
}): JSX.Element {
  return <div className="settings-page-section" id={`settings-subsection-${id}`}>{children}</div>;
}

function SettingsNestedBack({ label, onClick }: { readonly label: string; readonly onClick: () => void }): JSX.Element {
  return <button type="button" className="settings-nested-back" onClick={onClick}><ArrowLeft aria-hidden="true" /><span>{label}</span></button>;
}

function SettingsSuccessToast({ notice, onDone }: {
  readonly notice: SettingsSuccessNotice;
  readonly onDone: () => void;
}): JSX.Element {
  const [mounted, setMounted] = useState(false);
  const [exiting, setExiting] = useState(false);
  const dismissTimer = useRef<number | undefined>(undefined);
  const removeTimer = useRef<number | undefined>(undefined);
  const expiresAt = useRef(0);
  const pausedRemaining = useRef<number | undefined>(undefined);
  const onDoneRef = useRef(onDone);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  const startDismissTimer = useCallback((duration: number): void => {
    expiresAt.current = Date.now() + duration;
    dismissTimer.current = window.setTimeout(() => {
      dismissTimer.current = undefined;
      setExiting(true);
      removeTimer.current = window.setTimeout(() => onDoneRef.current(), 300);
    }, duration);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMounted(true));
    startDismissTimer(1_200);
    return () => {
      window.cancelAnimationFrame(frame);
      if (dismissTimer.current !== undefined) window.clearTimeout(dismissTimer.current);
      if (removeTimer.current !== undefined) window.clearTimeout(removeTimer.current);
    };
  }, [startDismissTimer]);

  const pause = (): void => {
    if (dismissTimer.current === undefined || exiting) return;
    window.clearTimeout(dismissTimer.current);
    dismissTimer.current = undefined;
    pausedRemaining.current = Math.max(expiresAt.current - Date.now(), 1_000);
  };
  const resume = (): void => {
    if (pausedRemaining.current === undefined || exiting) return;
    const remaining = pausedRemaining.current;
    pausedRemaining.current = undefined;
    startDismissTimer(remaining);
  };

  return <div
      className="settings-success-notification"
      role="status"
      aria-live="polite"
      data-state={exiting ? "exiting" : "entering"}
      data-visible={mounted && !exiting ? "true" : "false"}
      onMouseEnter={pause}
      onMouseLeave={resume}
    >
      <CircleCheck aria-hidden="true" />
      <span>{notice.text}</span>
  </div>;
}

/**
 * Native About must remain reachable even before a Orchestrator connection exists.
 * Keep this surface independent of controller-only settings so the desktop
 * application menu never falls through to a connection or recovery screen.
 */
export function StandaloneAboutPage({ snapshot, t }: {
  readonly snapshot: AppSnapshot;
  readonly t: Translator;
}): JSX.Element {
  return (
    <main id="main-content" className="route-page settings-page settings-page--standalone" tabIndex={-1}>
      <div className="settings-standalone-scroll">
        <div className="settings-content">
          <AboutSettings snapshot={snapshot} t={t} />
        </div>
      </div>
    </main>
  );
}

function SettingsHeading({ title, body }: { readonly title: string; readonly body: string }): JSX.Element {
  return <header className="settings-heading"><h2>{title}</h2><p>{body}</p></header>;
}

function SettingsSectionHeading({ title, body, actions }: { readonly title: string; readonly body?: string; readonly actions?: ReactNode }): JSX.Element {
  return <header className={cx("settings-section-heading", actions !== undefined && "settings-section-heading--with-actions")}><div className="settings-section-heading__copy"><h3>{title}</h3>{body !== undefined && <p>{body}</p>}</div>{actions !== undefined && <div className="settings-section-heading__actions">{actions}</div>}</header>;
}

interface SettingsSaveFeedback {
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly commit: (
    action: () => Promise<void>,
    messages: { readonly success: string; readonly failure: string }
  ) => Promise<void>;
  readonly dismissError: () => void;
}

function useSettingsSaveFeedback(onSuccess: (text: string) => void): SettingsSaveFeedback {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const generationRef = useRef(0);
  useEffect(() => () => { generationRef.current += 1; }, []);
  const commit = useCallback(async (
    action: () => Promise<void>,
    messages: { readonly success: string; readonly failure: string }
  ): Promise<void> => {
    const generation = ++generationRef.current;
    setPending(true);
    setError(undefined);
    try {
      await action();
      if (generationRef.current === generation) onSuccess(messages.success);
    } catch {
      if (generationRef.current === generation) setError(messages.failure);
    } finally {
      if (generationRef.current === generation) setPending(false);
    }
  }, [onSuccess]);
  const dismissError = useCallback(() => setError(undefined), []);
  return {
    pending,
    error,
    commit,
    dismissError
  };
}

export function AppearanceSettings({ controller, locale, theme, onSuccess, onOpenPi, showHeading = true, t }: { readonly controller: AppController; readonly locale: Locale; readonly theme: Theme; readonly onSuccess: (text: string) => void; readonly onOpenPi: () => void; readonly showHeading?: boolean; readonly t: Translator }): JSX.Element {
  const appearance = controller.state.preferences;
  const themeSave = useSettingsSaveFeedback(onSuccess);
  const localeSave = useSettingsSaveFeedback(onSuccess);
  const themePickerRef = useRef<HTMLDivElement>(null);
  const restoreThemeKeyboardFocusRef = useRef(false);
  const [layoutResetBusy, setLayoutResetBusy] = useState(false);
  const [layoutResetError, setLayoutResetError] = useState<string>();
  const saveTheme = (next: Theme): void => {
    if (next === theme) return;
    void themeSave.commit(
      () => controller.setTheme(next),
      { success: t("settings.themeSaveSuccess"), failure: t("settings.themeSaveFailed") }
    );
  };
  const moveThemeSelection = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing || themeSave.pending) return;
    const picker = themePickerRef.current;
    const buttons = picker === null ? [] : [...picker.querySelectorAll<HTMLButtonElement>('button[role="radio"]')];
    const currentIndex = buttons.indexOf(event.currentTarget);
    if (currentIndex < 0 || buttons.length === 0) return;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (currentIndex - 1 + buttons.length) % buttons.length
          : event.key === "ArrowRight" || event.key === "ArrowDown"
            ? (currentIndex + 1) % buttons.length
            : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = buttons[nextIndex];
    restoreThemeKeyboardFocusRef.current = true;
    next?.focus();
    next?.click();
  };
  useEffect(() => {
    if (themeSave.pending || !restoreThemeKeyboardFocusRef.current) return;
    restoreThemeKeyboardFocusRef.current = false;
    themePickerRef.current?.querySelector<HTMLButtonElement>('button[role="radio"][aria-checked="true"]')?.focus();
  }, [theme, themeSave.error, themeSave.pending]);
  const saveLocale = (next: Locale): void => {
    if (next === locale) return;
    void localeSave.commit(
      () => controller.setLocale(next),
      { success: t("settings.localeSaveSuccess"), failure: t("settings.localeSaveFailed") }
    );
  };
  const resetLayout = async (): Promise<void> => {
    if (layoutResetBusy) return;
    setLayoutResetBusy(true);
    setLayoutResetError(undefined);
    try {
      const desktop = window.jokoDesktop;
      const failure = await resetWindowLayout({
        resetClient: controller.resetLayoutPreferences,
        ...(desktop?.capabilities.includes("layout.reset") === true
          ? { resetNative: () => desktop.layout.reset() }
          : {})
      });
      if (failure !== undefined) {
        setLayoutResetError(t(failure === "native"
          ? "settings.layoutResetNativeFailed"
          : failure === "client"
            ? "settings.layoutResetClientFailed"
            : "settings.layoutResetFailed"));
        return;
      }
      onSuccess(t("settings.layoutResetSuccess"));
    } catch {
      setLayoutResetError(t("settings.layoutResetFailed"));
    } finally {
      setLayoutResetBusy(false);
    }
  };
  return (
    <>
      {showHeading && <SettingsHeading title={t("settings.appearance")} body={t("settings.appearanceBody")} />}
      <div className="settings-card-stack">
      <section className="settings-card">
        <div className="setting-row">
          <div><strong>{t("settings.theme")}</strong><span>{t("settings.themeBody")}</span>{themeSave.pending && <span role="status">{t("common.working")}</span>}</div>
          <div ref={themePickerRef} className="theme-picker" role="radiogroup" aria-label={t("settings.theme")} aria-busy={themeSave.pending}><ThemeButton value="system" current={theme} label={t("settings.system")} icon={<Monitor />} disabled={themeSave.pending} onChange={saveTheme} onKeyDown={moveThemeSelection} /><ThemeButton value="light" current={theme} label={t("settings.light")} icon={<Sun />} disabled={themeSave.pending} onChange={saveTheme} onKeyDown={moveThemeSelection} /><ThemeButton value="dark" current={theme} label={t("settings.dark")} icon={<Moon />} disabled={themeSave.pending} onChange={saveTheme} onKeyDown={moveThemeSelection} /></div>
        </div>
        {themeSave.error !== undefined && <ErrorBanner message={themeSave.error} dismissLabel={t("common.dismiss")} onClose={themeSave.dismissError} />}
        <div className="setting-row">
          <div><strong>{t("settings.locale")}</strong><span>{t("settings.localeBody")}</span>{localeSave.pending && <span role="status">{t("common.working")}</span>}</div>
          <SelectControl value={locale} disabled={localeSave.pending} aria-busy={localeSave.pending} onChange={(event) => saveLocale(event.target.value as Locale)} aria-label={t("settings.locale")}><option value="en">English</option><option value="zh-CN">简体中文</option><option value="en-XA">Pseudo · en-XA</option></SelectControl>
        </div>
        {localeSave.error !== undefined && <ErrorBanner message={localeSave.error} dismissLabel={t("common.dismiss")} onClose={localeSave.dismissError} />}
        <button type="button" className="setting-row settings-row-link" onClick={onOpenPi}>
          <div>
            <strong><Braces aria-hidden="true" />{t("settings.pi")}</strong>
            <span>{t("settings.piBody")}</span>
          </div>
          <ChevronRight aria-hidden="true" />
        </button>
      </section>
      <section className="settings-card appearance-font-card" aria-label={t("settings.appearance.fonts")}>
        <FontFamilySetting
          label={t("settings.appearance.uiFamily")}
          description={t("settings.appearance.uiFamilyBody")}
          value={appearance.uiFamily}
          presets={[
            { id: "default", label: t("settings.appearance.fontDefault"), family: "" },
            { id: "codexStyle", label: t("settings.appearance.fontCodexStyle"), family: '-apple-system, BlinkMacSystemFont, "Segoe UI"' },
            { id: "harmonyOS", label: t("settings.appearance.fontHarmonyOS"), family: '"HarmonyOS Sans SC"' }
          ]}
          preview={t("settings.appearance.uiPreview")}
          fallback="var(--app-font-ui-default)"
          onChange={controller.setUiFamily}
          t={t}
        />
        <FontSizeSetting
          label={t("settings.appearance.uiSize")}
          description={t("settings.appearance.uiSizeBody")}
          value={appearance.uiSize}
          min={12}
          max={24}
          defaultValue={14}
          onChange={controller.setUiSize}
          t={t}
        />
        <FontFamilySetting
          label={t("settings.appearance.codeFamily")}
          description={t("settings.appearance.codeFamilyBody")}
          value={appearance.codeFamily}
          presets={[
            { id: "default", label: t("settings.appearance.fontDefault"), family: "" },
            { id: "jetbrainsMono", label: t("settings.appearance.fontJetBrains"), family: '"JetBrains Mono Variable", "JetBrains Mono"' }
          ]}
          preview={'// preview 0O 1lI\nconst greet = (name: string, n = 3): string =>\n  `Hello, ${name}!`.repeat(n);\nif (greet("AI", 0).length !== 0) throw new Error("oops");'}
          previewLanguage="typescript"
          fallback="var(--app-font-code-default)"
          onChange={controller.setCodeFamily}
          t={t}
        />
        <FontSizeSetting
          label={t("settings.appearance.codeSize")}
          description={t("settings.appearance.codeSizeBody")}
          value={appearance.codeSize}
          min={10}
          max={24}
          defaultValue={14}
          onChange={controller.setCodeSize}
          t={t}
        />
      </section>
      <section className="settings-card" aria-label={t("settings.layoutResetTitle")}>
        <div className="setting-row">
          <div><strong>{t("settings.layoutResetTitle")}</strong><span>{t("settings.layoutResetBody")}</span></div>
          <Button disabled={layoutResetBusy} onClick={() => void resetLayout()}><RotateCcw aria-hidden="true" />{layoutResetBusy ? t("common.working") : t("settings.layoutResetAction")}</Button>
        </div>
        {layoutResetError !== undefined && <ErrorBanner message={layoutResetError} dismissLabel={t("common.dismiss")} onClose={() => setLayoutResetError(undefined)} />}
      </section>
      </div>
    </>
  );
}

export function GeneralSettings({ controller, snapshot, runAction, onSuccess, showHeading = true, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly runAction: RunAction;
  readonly onSuccess: (text: string) => void;
  readonly showHeading?: boolean;
  readonly t: Translator;
}): JSX.Element {
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  const notificationAvailable = desktop?.capabilities.includes("notifications.session") === true;
  const powerAvailable = desktop?.capabilities.includes("power.keepAwake") === true;
  const activationClickAvailable = desktop?.capabilities.includes("window.activationClick") === true &&
    (desktop.platform === "win32" || desktop.platform === "darwin");
  const [keepAwake, setKeepAwake] = useState<boolean>();
  const [swallowActivationClick, setSwallowActivationClick] = useState<boolean>();
  const [powerBusy, setPowerBusy] = useState(false);
  const [activationClickBusy, setActivationClickBusy] = useState(false);
  const [error, setError] = useState<string>();
  const notificationSave = useSettingsSaveFeedback(onSuccess);
  const loadGenerationRef = useRef(0);
  const interactionLoadGenerationRef = useRef(0);

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    if (!powerAvailable || desktop === undefined) {
      setKeepAwake(undefined);
      return;
    }
    setError(undefined);
    void desktop.power.getKeepAwake().then((settings) => {
      if (loadGenerationRef.current === generation) setKeepAwake(settings.enabled);
    }).catch(() => {
      if (loadGenerationRef.current === generation) setError(t("settings.keepAwakeLoadFailed"));
    });
    return () => { loadGenerationRef.current += 1; };
  }, [desktop, powerAvailable, t]);

  useEffect(() => {
    const generation = ++interactionLoadGenerationRef.current;
    if (!activationClickAvailable || desktop === undefined) {
      setSwallowActivationClick(undefined);
      return;
    }
    setError(undefined);
    const unsubscribe = subscribeActivationClickPreference(setSwallowActivationClick);
    void desktop.windowInteraction.get().then((settings) => {
      if (interactionLoadGenerationRef.current !== generation) return;
      setSwallowActivationClick(settings.swallowActivationClick);
      writeActivationClickPreference(settings.swallowActivationClick);
    }).catch(() => {
      if (interactionLoadGenerationRef.current === generation) {
        setError(t("settings.activationClickLoadFailed"));
      }
    });
    return () => {
      interactionLoadGenerationRef.current += 1;
      unsubscribe();
    };
  }, [activationClickAvailable, desktop, t]);

  const changeKeepAwake = async (enabled: boolean): Promise<void> => {
    if (!powerAvailable || desktop === undefined || powerBusy) return;
    const previous = keepAwake;
    setError(undefined);
    setPowerBusy(true);
    setKeepAwake(enabled);
    try {
      const settings = await desktop.power.setKeepAwake(enabled);
      setKeepAwake(settings.enabled);
    } catch {
      setKeepAwake(previous);
      setError(t("settings.keepAwakeSaveFailed"));
    } finally {
      setPowerBusy(false);
    }
  };

  const changeNotifications = (enabled: boolean): void => {
    if (!notificationAvailable) return;
    void notificationSave.commit(
      () => controller.setSessionNotificationsEnabled(enabled),
      {
        success: t(enabled ? "settings.sessionNotificationsEnabled" : "settings.sessionNotificationsDisabled"),
        failure: t("settings.sessionNotificationsSaveFailed")
      }
    );
  };

  const changeActivationClick = async (enabled: boolean): Promise<void> => {
    if (!activationClickAvailable || desktop === undefined || activationClickBusy) return;
    const previous = swallowActivationClick ?? false;
    setError(undefined);
    setActivationClickBusy(true);
    setSwallowActivationClick(enabled);
    writeActivationClickPreference(enabled);
    try {
      const settings = await desktop.windowInteraction.setSwallowActivationClick(enabled);
      setSwallowActivationClick(settings.swallowActivationClick);
      writeActivationClickPreference(settings.swallowActivationClick);
    } catch {
      setSwallowActivationClick(previous);
      writeActivationClickPreference(previous);
      setError(t("settings.activationClickSaveFailed"));
    } finally {
      setActivationClickBusy(false);
    }
  };

  const changeComposerSendShortcut = (composerShortcut: "enter" | "modifier-enter"): void => {
    if (composerVoiceShortcutsConflict(
      composerShortcut,
      readVoiceInputPreferences().shortcut,
      currentAppShortcutPlatform()
    )) {
      setError(t("settings.composerVoiceShortcutConflict"));
      return;
    }
    setError(undefined);
    void controller.setComposerSendShortcut(composerShortcut);
  };

  return <>
    {showHeading && <SettingsHeading title={t("settings.general")} body={t("settings.generalBody")} />}
    {notificationSave.error !== undefined && <ErrorBanner message={notificationSave.error} onClose={notificationSave.dismissError} />}
    {error !== undefined && <ErrorBanner message={error} onClose={() => setError(undefined)} />}
    <section className="settings-card desktop-behavior-settings">
      <div className="setting-row">
        <div>
          <strong><Bell aria-hidden="true" />{t("settings.sessionNotifications")}</strong>
          <span>{notificationAvailable ? t("settings.sessionNotificationsBody") : t("settings.desktopOnly")}</span>
          {notificationSave.pending && <span role="status">{t("common.working")}</span>}
        </div>
        <SwitchControl
            checked={controller.state.preferences.sessionNotificationsEnabled}
            disabled={!notificationAvailable || notificationSave.pending}
            aria-busy={notificationSave.pending}
            aria-label={t("settings.sessionNotifications")}
            onChange={(event) => changeNotifications(event.target.checked)}
          />
      </div>
      <div className="setting-row">
        <div>
          <strong><Power aria-hidden="true" />{t("settings.keepAwake")}</strong>
          <span>{powerAvailable ? t("settings.keepAwakeBody") : t("settings.desktopOnly")}</span>
        </div>
        <SwitchControl
            checked={keepAwake === true}
            disabled={!powerAvailable || keepAwake === undefined || powerBusy}
            aria-label={t("settings.keepAwake")}
            onChange={(event) => void changeKeepAwake(event.target.checked)}
          />
      </div>
      {activationClickAvailable && <div className="setting-row">
        <div>
          <strong><MousePointerClick aria-hidden="true" />{t("settings.activationClick")}</strong>
          <span>{t("settings.activationClickBody")}</span>
          {desktop?.platform === "darwin" && <span>{t("settings.activationClickRestart")}</span>}
        </div>
        <SwitchControl
            checked={swallowActivationClick === true}
            disabled={swallowActivationClick === undefined || activationClickBusy}
            aria-label={t("settings.activationClick")}
            onChange={(event) => void changeActivationClick(event.target.checked)}
          />
      </div>}
      <div className="setting-row">
        <div><strong>{t("settings.sendShortcut")}</strong><span>{t("settings.sendShortcutBody")}</span></div>
        <SelectControl value={controller.state.preferences.composerSendShortcut} onChange={(event) => changeComposerSendShortcut(event.target.value as "enter" | "modifier-enter")} aria-label={t("settings.sendShortcut")}>
          <option value="enter">{t("settings.sendShortcutEnter")}</option>
          <option value="modifier-enter">{t("settings.sendShortcutModifierEnter")}</option>
        </SelectControl>
      </div>
    </section>
    <RuntimeGovernanceSettings controller={controller} snapshot={snapshot} runAction={runAction} t={t} />
    <LanguageToolSettings controller={controller} snapshot={snapshot} runAction={runAction} onSuccess={onSuccess} t={t} />
  </>;
}

interface NativeImportItem {
  readonly key: string;
  readonly backendId: string;
  readonly backendName: string;
  readonly importEnabled: boolean;
  readonly candidate: NativeSessionCatalogEntryView;
}

interface NativeImportScan {
  readonly items: readonly NativeImportItem[];
  readonly errors: ReadonlyMap<string, string>;
  readonly sourceResults: ReadonlyMap<string, NativeImportSourceResult>;
  readonly rejectedCount: number;
  readonly existingCount: number;
  readonly scannedAt: number;
}

interface NativeImportSourceResult {
  readonly items: readonly NativeImportItem[];
  readonly rejectedCount: number;
  readonly existingCount: number;
  readonly snapshotToken: string;
}

interface NativeImportSource {
  readonly backend: BackendView;
}

interface NativeImportScanFlight {
  readonly version: number;
  readonly abort: AbortController;
  readonly promise: Promise<NativeImportScan>;
}

const nativeImportScanCache = new Map<string, NativeImportScan>();
const nativeImportScanFlights = new Map<string, NativeImportScanFlight>();
const nativeImportScanVersions = new Map<string, number>();
const MAXIMUM_NATIVE_IMPORT_SCAN_CACHE_ENTRIES = 16;

async function collectNativeImportScan(
  controller: AppController,
  sources: readonly NativeImportSource[],
  force: boolean,
  signal: AbortSignal,
  t: Translator,
  previous: NativeImportScan | undefined
): Promise<NativeImportScan> {
  const results = await Promise.all(sources.map(async ({ backend }) => {
    try {
      const result = await controller.scanNativeSessionCatalog(backend.id, { force, signal });
      return { backend, result } as const;
    } catch (error) {
      return {
        backend,
        error: error instanceof Error ? error.message : t("settings.sessionImport.scanSourceFailed")
      } as const;
    }
  }));
  const errors = new Map<string, string>();
  const sourceResults = new Map<string, NativeImportSourceResult>();
  for (const result of results) {
    if (!("result" in result) || result.result === undefined) {
      errors.set(result.backend.id, result.error ?? t("settings.sessionImport.scanSourceFailed"));
      const previousResult = previous?.sourceResults.get(result.backend.id);
      if (previousResult !== undefined) sourceResults.set(result.backend.id, previousResult);
      continue;
    }
    sourceResults.set(result.backend.id, {
      items: result.result.entries.map((candidate) => ({
        key: `${result.backend.id}\u0000${candidate.reference}\u0000${candidate.placement}`,
        backendId: result.backend.id,
        backendName: result.backend.name,
        importEnabled: true,
        candidate
      })),
      rejectedCount: result.result.rejectedCount,
      existingCount: result.result.existingCount,
      snapshotToken: result.result.snapshotToken
    });
  }
  const items = sources.flatMap(({ backend }) => sourceResults.get(backend.id)?.items ?? [])
    .sort((left, right) => right.candidate.modifiedAt - left.candidate.modifiedAt);
  return {
    items,
    errors,
    sourceResults,
    rejectedCount: [...sourceResults.values()].reduce((total, result) => total + result.rejectedCount, 0),
    existingCount: [...sourceResults.values()].reduce((total, result) => total + result.existingCount, 0),
    scannedAt: Date.now()
  };
}

function beginNativeImportScan(
  cacheKey: string,
  controller: AppController,
  sources: readonly NativeImportSource[],
  force: boolean,
  t: Translator
): Promise<NativeImportScan> {
  const current = nativeImportScanFlights.get(cacheKey);
  if (!force && current !== undefined) return current.promise;
  if (force) current?.abort.abort();
  const version = (nativeImportScanVersions.get(cacheKey) ?? 0) + 1;
  nativeImportScanVersions.set(cacheKey, version);
  const abort = new AbortController();
  const promise = collectNativeImportScan(
    controller,
    sources,
    force,
    abort.signal,
    t,
    nativeImportScanCache.get(cacheKey)
  )
    .then((scan) => {
      if (nativeImportScanVersions.get(cacheKey) === version) {
        if (!nativeImportScanCache.has(cacheKey)
          && nativeImportScanCache.size >= MAXIMUM_NATIVE_IMPORT_SCAN_CACHE_ENTRIES) {
          nativeImportScanCache.clear();
        }
        nativeImportScanCache.set(cacheKey, scan);
      }
      return scan;
    })
    .finally(() => {
      if (nativeImportScanFlights.get(cacheKey)?.version === version) nativeImportScanFlights.delete(cacheKey);
    });
  nativeImportScanFlights.set(cacheKey, { version, abort, promise });
  return promise;
}

type NativeImportListEntry = {
  readonly kind: "project";
  readonly key: string;
  readonly projectDirectory?: string;
  readonly items: readonly NativeImportItem[];
  readonly modifiedAt: number;
} | {
  readonly kind: "dialogue";
  readonly key: string;
  readonly item: NativeImportItem;
  readonly modifiedAt: number;
};

export function TaskImportSettings({ controller, snapshot, onImportPortable, runAction, onSuccess, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly onImportPortable?: () => void;
  readonly runAction: RunAction;
  readonly onSuccess: (text: string) => void;
  readonly t: Translator;
}): JSX.Element {
  const sources = useMemo<readonly NativeImportSource[]>(() => snapshot.backends
    .filter((backend) => backend.capabilities.get("session.catalog")?.supported === true)
    .map((backend) => ({ backend })), [snapshot.backends]);
  const scanOwnerKey = controller.state.activeProfile === undefined
    ? "disconnected"
    : `${controller.state.activeProfile.serverId}\u0000${controller.state.activeProfile.id}`;
  const sourceScanKey = sources.map(({ backend }) =>
    `${backend.id}\u0000${backend.instanceGeneration ?? 0}`).sort().join("\u0001");
  const scanCacheKey = `${scanOwnerKey}\u0002${sourceScanKey}`;
  const controllerRef = useRef(controller);
  const sourcesRef = useRef(sources);
  const snapshotRef = useRef(snapshot);
  const tRef = useRef(t);
  controllerRef.current = controller;
  sourcesRef.current = sources;
  snapshotRef.current = snapshot;
  tRef.current = t;
  const [scanState, setScanState] = useState<{ readonly key: string; readonly value?: NativeImportScan }>(() => ({
    key: scanCacheKey,
    value: nativeImportScanCache.get(scanCacheKey)
  }));
  const scan = scanState.key === scanCacheKey ? scanState.value : nativeImportScanCache.get(scanCacheKey);
  const [scanning, setScanning] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [placementFilter, setPlacementFilter] = useState<"all" | "project" | "dialogue">("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [importing, setImporting] = useState(false);
  const [itemStates, setItemStates] = useState<ReadonlyMap<string, "importing" | "success" | "error">>(() => new Map());
  const scanGeneration = useRef(0);

  const runScan = useCallback(async (force: boolean): Promise<void> => {
    if (sourcesRef.current.length === 0) return;
    const generation = ++scanGeneration.current;
    setScanning(true);
    try {
      const next = await beginNativeImportScan(scanCacheKey, controllerRef.current, sourcesRef.current, force, tRef.current);
      if (generation !== scanGeneration.current) return;
      setScanState({ key: scanCacheKey, value: next });
      const nextKeys = new Set(next.items.map((item) => item.key));
      setSelected((current) => new Set([...current].filter((key) => nextKeys.has(key))));
      setItemStates((current) => new Map([...current].filter(([key]) => nextKeys.has(key))));
    } finally {
      if (generation === scanGeneration.current) setScanning(false);
    }
  }, [scanCacheKey]);

  useEffect(() => {
    setScanState({ key: scanCacheKey, value: nativeImportScanCache.get(scanCacheKey) });
    setScanning(false);
    setSourceFilter("all");
    setPlacementFilter("all");
    setSelected(new Set());
    setExpandedGroups(new Set());
    setItemStates(new Map());
    if (sourcesRef.current.length > 0) void runScan(false);
    return () => {
      scanGeneration.current += 1;
    };
  }, [runScan, scanCacheKey]);

  const currentItems = useMemo(() => {
    const backends = new Map(sources.map(({ backend }) => [backend.id, backend] as const));
    return (scan?.items ?? []).flatMap((item) => {
      const backend = backends.get(item.backendId);
      if (backend === undefined) return [];
      return [{
        ...item,
        backendName: backend.name,
        importEnabled: true
      }];
    });
  }, [scan?.items, sources]);
  const visibleItems = useMemo(() => currentItems.filter((item) => {
    if (sourceFilter !== "all" && item.backendId !== sourceFilter) return false;
    return placementFilter === "all" || item.candidate.placement === placementFilter;
  }), [currentItems, placementFilter, sourceFilter]);
  const listEntries = useMemo<readonly NativeImportListEntry[]>(() => {
    const byProject = new Map<string, { readonly projectDirectory?: string; readonly items: NativeImportItem[] }>();
    const entries: NativeImportListEntry[] = [];
    for (const item of visibleItems) {
      if (item.candidate.placement === "dialogue") {
        entries.push({ kind: "dialogue", key: `dialogue\u0000${item.key}`, item, modifiedAt: item.candidate.modifiedAt });
        continue;
      }
      const projectDirectory = item.candidate.projectDirectory ?? item.candidate.workingDirectory;
      const key = projectDirectory === undefined
        ? item.candidate.projectTargetId ?? item.key
        : nativeImportProjectKey(projectDirectory);
      const group = byProject.get(key);
      if (group === undefined) byProject.set(key, { projectDirectory, items: [item] });
      else group.items.push(item);
    }
    for (const [key, group] of byProject) {
      entries.push({
        kind: "project",
        key: `project\u0000${key}`,
        projectDirectory: group.projectDirectory,
        items: group.items,
        modifiedAt: group.items[0]?.candidate.modifiedAt ?? 0
      });
    }
    return entries.sort((left, right) => right.modifiedAt - left.modifiedAt);
  }, [visibleItems]);
  const selectableVisibleItems = visibleItems.filter(nativeImportItemSelectable);
  const selectedItems = currentItems.filter((item) => selected.has(item.key) && nativeImportItemSelectable(item));
  const visibleKeys = new Set(visibleItems.map((item) => item.key));
  const hiddenSelectedCount = selectedItems.filter((item) => !visibleKeys.has(item.key)).length;
  const allVisibleSelected = selectableVisibleItems.length > 0 && selectableVisibleItems.every((item) => selected.has(item.key));
  const someVisibleSelected = selectableVisibleItems.some((item) => selected.has(item.key));

  const toggleSelection = (keys: readonly string[], selectedNow?: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      const shouldSelect = selectedNow ?? !keys.every((key) => next.has(key));
      for (const key of keys) shouldSelect ? next.add(key) : next.delete(key);
      return next;
    });
  };
  const importSelected = (): void => {
    if (selectedItems.length === 0 || importing) return;
    setImporting(true);
    setItemStates(new Map(selectedItems.map((item) => [item.key, "importing"] as const)));
    runAction("import-native-sessions", async () => {
      try {
        const pending = [...selectedItems];
        const preflightResults = new Map<string, NativeSessionCatalogView | Error>();
        await Promise.all([...new Set(selectedItems.map((item) => item.backendId))].map(async (backendId) => {
          try {
            preflightResults.set(
              backendId,
              await controllerRef.current.scanNativeSessionCatalog(backendId, { force: true })
            );
          } catch (error) {
            preflightResults.set(
              backendId,
              error instanceof Error ? error : new Error(tRef.current("settings.sessionImport.scanSourceFailed"))
            );
          }
        }));
        const failures = new Set<string>();
        const failureMessages = new Map<string, string>();
        let importedCount = 0;
        let updatedCount = 0;
        const targetPromises = new Map<string, Promise<{ readonly targetId: string; readonly created: boolean }>>();
        const createdTargetIds = new Set<string>();
        const visibleProjectTargetIds = new Set<string>();
        const resolveTarget = (backendId: string, path: string | undefined, existingTargetId?: string): Promise<{ readonly targetId: string; readonly created: boolean }> => {
          const key = path === undefined || path.trim() === ""
            ? `${backendId}\u0000target\u0000${existingTargetId ?? "missing"}`
            : nativeImportWorkspaceKey(backendId, path);
          const current = targetPromises.get(key);
          if (current !== undefined) return current;
          const promise = existingTargetId !== undefined
            ? Promise.resolve({ targetId: existingTargetId, created: false })
            : (async () => {
                if (path === undefined || path.trim() === "") throw new Error(tRef.current("settings.sessionImport.missingWorkspace"));
                const targetId = await controllerRef.current.createTarget({
                  backendId,
                  name: nativeImportWorkspaceName(path),
                  workspaceKind: "userProject",
                  serverPath: path,
                  createIfMissing: false
                });
                createdTargetIds.add(targetId);
                return { targetId, created: true };
              })();
          targetPromises.set(key, promise);
          return promise;
        };
        const worker = async (): Promise<void> => {
          while (pending.length > 0) {
            const item = pending.shift();
            if (item === undefined) return;
            let createdSessionId: string | undefined;
            let visibleProjectTargetId: string | undefined;
            try {
              const preflight = preflightResults.get(item.backendId);
              if (preflight === undefined) throw new Error(tRef.current("settings.sessionImport.scanSourceFailed"));
              if (preflight instanceof Error) throw preflight;
              const candidate = preflight.entries.find((fresh) =>
                fresh.reference === item.candidate.reference && fresh.placement === item.candidate.placement);
              if (candidate === undefined) throw new Error(tRef.current("settings.sessionImport.changed"));
              if (candidate.existingSessionId !== undefined) {
                if (candidate.placement === "project") {
                  const projectDirectory = candidate.projectDirectory ?? candidate.workingDirectory;
                  const projectTarget = await resolveTarget(
                    item.backendId,
                    projectDirectory,
                    candidate.projectTargetId
                  );
                  visibleProjectTargetId = projectTarget.targetId;
                }
                await controllerRef.current.moveSessionProject(
                  candidate.existingSessionId,
                  visibleProjectTargetId,
                  {
                    archived: candidate.archived,
                    modifiedAt: candidate.modifiedAt,
                    snapshotToken: preflight.snapshotToken
                  }
                );
                if (visibleProjectTargetId !== undefined) visibleProjectTargetIds.add(visibleProjectTargetId);
                updatedCount += 1;
                setItemStates((current) => new Map(current).set(item.key, "success"));
                continue;
              }
              const runtimeTarget = await resolveTarget(item.backendId, candidate.workingDirectory, candidate.targetId);
              const projectTarget = candidate.placement === "project"
                ? await resolveTarget(
                    item.backendId,
                    candidate.projectDirectory ?? candidate.workingDirectory,
                    candidate.projectTargetId
                  )
                : undefined;
              const activeSnapshot = snapshotRef.current;
              const backend = activeSnapshot.backends.find((candidate) => candidate.id === item.backendId);
              const defaults = activeSnapshot.settings.backendSettings.find((candidate) => candidate.backendId === backend?.id);
              const execution = resolveNewSessionExecutionOptions(backend, activeSnapshot.models, "");
              const desiredPermission = defaults?.permissionMode ?? activeSnapshot.settings.policy.defaultMode;
              const sessionId = await controllerRef.current.createSession({
                targetId: runtimeTarget.targetId,
                name: candidate.title?.trim() || candidate.id,
                nativeStart: { kind: "attach", reference: candidate.reference },
                initialPlacement: candidate.placement,
                catalogImport: {
                  ...(projectTarget === undefined ? {} : { projectId: projectTarget.targetId }),
                  archived: candidate.archived,
                  createdAt: candidate.createdAt,
                  modifiedAt: candidate.modifiedAt,
                  snapshotToken: preflight.snapshotToken
                },
                providerId: "",
                modelId: "",
                fastMode: false,
                permissionMode: execution.permissionModes.includes(desiredPermission) ? desiredPermission : execution.permissionModes[0] ?? "ask",
                planMode: execution.planModeSupported && (defaults?.planMode ?? false)
              });
              createdSessionId = sessionId;
              visibleProjectTargetId = projectTarget?.targetId;
              if (visibleProjectTargetId !== undefined) visibleProjectTargetIds.add(visibleProjectTargetId);
              importedCount += 1;
              setItemStates((current) => new Map(current).set(item.key, "success"));
            } catch (error) {
              let message = nativeImportErrorMessage(error, tRef.current("error.unexpected"));
              if (createdSessionId !== undefined) {
                try {
                  await controllerRef.current.deleteSession(createdSessionId, false);
                } catch (cleanupFailure) {
                  message = `${message} ${nativeImportErrorMessage(cleanupFailure, tRef.current("error.unexpected"))}`;
                }
              }
              failures.add(item.key);
              failureMessages.set(item.key, message);
              setItemStates((current) => new Map(current).set(item.key, "error"));
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, selectedItems.length) }, () => worker()));
        let cleanupError: unknown;
        try {
          await Promise.all([...createdTargetIds]
            .filter((targetId) => !visibleProjectTargetIds.has(targetId))
            .map((targetId) => controllerRef.current.archiveTarget(targetId, true)));
        } catch (error) {
          cleanupError = error;
        }
        await controllerRef.current.refresh();
        await runScan(true);
        if (failures.size > 0) {
          setSelected(failures);
          setItemStates(new Map([...failures].map((key) => [key, "error"] as const)));
        }
        if (importedCount > 0 || updatedCount > 0) {
          onSuccess(tRef.current("settings.sessionImport.importComplete", { imported: importedCount, updated: updatedCount }));
        }
        if (failures.size > 0) {
          const details = [...new Set(failureMessages.values())];
          if (cleanupError !== undefined) details.push(nativeImportErrorMessage(cleanupError, tRef.current("error.unexpected")));
          throw new Error(`${tRef.current("settings.sessionImport.importFailed", { count: failures.size })} ${details.join(" ")}`.trim());
        }
        if (cleanupError !== undefined) throw cleanupError;
      } finally {
        setImporting(false);
      }
    });
  };

  const projectCount = currentItems.filter((item) => item.candidate.placement === "project").length;
  const dialogueCount = currentItems.length - projectCount;
  return <div className="task-import-workbench">
    <header className="task-import-header">
      <SettingsHeading title={t("settings.sessionImport.title")} body={t("settings.sessionImport.description")} />
      <div className="task-import-header__actions">
        <Button disabled={onImportPortable === undefined} title={onImportPortable === undefined ? t("portable.importUnavailable") : undefined} onClick={onImportPortable}><FileInput aria-hidden="true" />{t("settings.sessionImport.packageAction")}</Button>
        <Button tone="primary" disabled={scanning || sources.length === 0} onClick={() => void runScan(true)}><RefreshCw className={cx(scanning && "is-spinning")} aria-hidden="true" />{scanning ? t("settings.sessionImport.scanning") : t("settings.sessionImport.scan")}</Button>
      </div>
    </header>
    <section className="task-import-surface" aria-busy={scanning}>
      {sources.length === 0 ? <div className="task-import-empty"><FileInput aria-hidden="true" /><strong>{t("settings.sessionImport.unavailableTitle")}</strong><p>{t("settings.sessionImport.unavailableBody")}</p></div>
        : scan === undefined ? <div className="task-import-empty"><FileInput aria-hidden="true" /><strong>{t("settings.sessionImport.emptyTitle")}</strong><p>{t("settings.sessionImport.emptyBody")}</p></div>
          : <>
            <div className="task-import-controls">
              <div className="task-import-summary">
                <ImportSummaryCell label={t("settings.sessionImport.summary.total")} hint={t("settings.sessionImport.summary.totalHint")} value={currentItems.length} />
                <ImportSummaryCell label={t("settings.sessionImport.summary.projects")} hint={t("settings.sessionImport.summary.projectsHint")} value={projectCount} />
                <ImportSummaryCell label={t("settings.sessionImport.summary.dialogues")} hint={t("settings.sessionImport.summary.dialoguesHint")} value={dialogueCount} />
                <ImportSummaryCell label={t("settings.sessionImport.summary.skipped")} hint={t("settings.sessionImport.summary.skippedHint")} value={scan.rejectedCount + scan.existingCount} />
              </div>
              <div className="task-import-filters">
                <div className="task-import-filter"><span>{t("settings.sessionImport.source")}</span><SegmentedControl label={t("settings.sessionImport.source")} value={sourceFilter} options={[{ value: "all", label: t("settings.sessionImport.all") }, ...sources.map(({ backend }) => ({ value: backend.id, label: backend.name }))]} onChange={setSourceFilter} /></div>
                <div className="task-import-filter"><span>{t("settings.sessionImport.placement")}</span><SegmentedControl label={t("settings.sessionImport.placement")} value={placementFilter} options={[{ value: "all", label: t("settings.sessionImport.all") }, { value: "project", label: t("settings.sessionImport.projects") }, { value: "dialogue", label: t("settings.sessionImport.dialogues") }]} onChange={setPlacementFilter} /></div>
              </div>
              {scan.errors.size > 0 && <div className="task-import-source-errors" role="status">{[...scan.errors].map(([backendId, message]) => <p key={backendId}>{sources.find(({ backend }) => backend.id === backendId)?.backend.name ?? backendId}: {message}</p>)}</div>}
            </div>
            {listEntries.length > 0 && <label className="task-import-select-all"><CheckboxControl checked={allVisibleSelected} indeterminate={someVisibleSelected && !allVisibleSelected} disabled={selectableVisibleItems.length === 0} onChange={() => toggleSelection(selectableVisibleItems.map((item) => item.key), !allVisibleSelected)} /><span>{t("settings.sessionImport.selectAll", { count: selectableVisibleItems.length })}</span></label>}
            <div className="task-import-list">
              {listEntries.length === 0 ? <div className="task-import-list__empty">{t("settings.sessionImport.noCandidates")}</div> : listEntries.map((entry) => {
                if (entry.kind === "dialogue") return <NativeImportRow key={entry.key} direct item={entry.item} checked={selected.has(entry.item.key)} state={itemStates.get(entry.item.key)} locale={controller.state.preferences.locale} onChange={() => toggleSelection([entry.item.key])} t={t} />;
                const group = entry;
                const open = expandedGroups.has(group.key);
                const selectable = group.items.filter(nativeImportItemSelectable);
                const selectedCount = selectable.filter((item) => selected.has(item.key)).length;
                return <section className="task-import-group" key={group.key}>
                  <div className="task-import-group__header">
                    <CheckboxControl aria-label={t("settings.sessionImport.selectGroup")} checked={selectable.length > 0 && selectedCount === selectable.length} indeterminate={selectedCount > 0 && selectedCount < selectable.length} disabled={selectable.length === 0} onChange={() => toggleSelection(selectable.map((item) => item.key))} />
                    <button type="button" aria-expanded={open} aria-label={open ? t("settings.sessionImport.collapse") : t("settings.sessionImport.expand")} onClick={() => setExpandedGroups((current) => { const next = new Set(current); open ? next.delete(group.key) : next.add(group.key); return next; })}><ChevronRight aria-hidden="true" /></button>
                    <button type="button" className="task-import-group__identity" onClick={() => setExpandedGroups((current) => { const next = new Set(current); open ? next.delete(group.key) : next.add(group.key); return next; })}><strong>{group.projectDirectory === undefined ? t("settings.sessionImport.noWorkspace") : nativeImportWorkspaceName(group.projectDirectory)}</strong><span>{group.projectDirectory ?? t("settings.sessionImport.noWorkspace")} · {t("settings.sessionImport.taskCount", { count: group.items.length })}</span></button>
                    {selectedCount > 0 && <span className="task-import-group__selected">{selectedCount}/{group.items.length}</span>}
                    <time dateTime={new Date(group.modifiedAt).toISOString()} title={new Date(group.modifiedAt).toLocaleString(controller.state.preferences.locale === "zh-CN" ? "zh-CN" : "en-US")}>{formatRelativeTime(group.modifiedAt, controller.state.preferences.locale)}</time>
                  </div>
                  {open && <div className="task-import-group__items">{group.items.map((item) => <NativeImportRow key={item.key} item={item} checked={selected.has(item.key)} state={itemStates.get(item.key)} locale={controller.state.preferences.locale} onChange={() => toggleSelection([item.key])} t={t} />)}</div>}
                </section>;
              })}
            </div>
            <footer className="task-import-footer"><p>{t("settings.sessionImport.selected", { count: selectedItems.length })}{hiddenSelectedCount > 0 ? ` · ${t("settings.sessionImport.selectedOutsideFilter", { count: hiddenSelectedCount })}` : ""}</p><Button tone="primary" disabled={selectedItems.length === 0 || importing} onClick={importSelected}><Check aria-hidden="true" />{importing ? t("settings.sessionImport.importing") : t("settings.sessionImport.importSelected")}</Button></footer>
          </>}
    </section>
  </div>;
}

function nativeImportWorkspaceKey(backendId: string, workspaceRoot: string): string {
  const normalized = nativeImportNormalizedPath(workspaceRoot);
  return `${backendId}\u0000${normalized}`;
}

function nativeImportItemSelectable(item: NativeImportItem): boolean {
  return item.importEnabled && (item.candidate.existingSessionId !== undefined
    || item.candidate.targetId !== undefined
    || (item.candidate.workingDirectory !== undefined && item.candidate.workingDirectory.trim() !== ""));
}

function nativeImportProjectKey(projectDirectory: string): string {
  return nativeImportNormalizedPath(projectDirectory);
}

function nativeImportNormalizedPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  const comparable = /^[a-z]:\//iu.test(normalized) || normalized.startsWith("//")
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
  return comparable;
}

function nativeImportWorkspaceName(workspaceRoot: string): string {
  const normalized = workspaceRoot.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).at(-1) || workspaceRoot;
}

function nativeImportErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

function ImportSummaryCell({ label, hint, value }: { readonly label: string; readonly hint: string; readonly value: number }): JSX.Element {
  return <div><strong>{value}</strong><span>{label}</span><small>{hint}</small></div>;
}

function NativeImportRow({ item, checked, direct = false, state, locale, onChange, t }: {
  readonly item: NativeImportItem;
  readonly checked: boolean;
  readonly direct?: boolean;
  readonly state?: "importing" | "success" | "error";
  readonly locale: Locale;
  readonly onChange: () => void;
  readonly t: Translator;
}): JSX.Element {
  const selectable = nativeImportItemSelectable(item);
  const disabled = !selectable || state === "importing" || state === "success";
  const status = !item.importEnabled
    ? t("settings.sessionImport.importUnavailable")
    : !selectable
      ? t("settings.sessionImport.missingWorkspace")
    : state === undefined ? undefined : t(`settings.sessionImport.item.${state}`);
  const title = item.candidate.title?.trim() || t("settings.sessionImport.untitled");
  const absoluteTime = new Date(item.candidate.modifiedAt).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US");
  return <label className={cx("task-import-row", direct && "task-import-row--direct", disabled && "is-disabled", state !== undefined && `is-${state}`)}>
    <CheckboxControl checked={checked} disabled={disabled} onChange={onChange} />
    <span><strong>{title}</strong><span className="task-import-row__badges"><b>{item.backendName}</b>{item.candidate.archived && <b>{t("settings.sessionImport.archived")}</b>}{item.candidate.placement === "dialogue" && <b>{t("settings.sessionImport.dialogueBadge")}</b>}</span><small title={item.candidate.workingDirectory || undefined}>{item.candidate.workingDirectory || t("settings.sessionImport.noWorkspace")}</small><small><time dateTime={new Date(item.candidate.modifiedAt).toISOString()} title={absoluteTime}>{formatRelativeTime(item.candidate.modifiedAt, locale)}</time></small></span>
    {status !== undefined && <em>{status}</em>}
  </label>;
}

function AboutSettings({ controller, snapshot, t }: { readonly controller?: AppController; readonly snapshot: AppSnapshot; readonly t: Translator }): JSX.Element {
  const [desktopInfo, setDesktopInfo] = useState<JokoDesktopAppInfo>();
  useEffect(() => {
    let active = true;
    const request = window.jokoDesktop?.appInfo?.get();
    if (request === undefined) return () => { active = false; };
    void request.then((info) => { if (active) setDesktopInfo(info); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return <>
    <SettingsHeading title={t("settings.about")} body={t("settings.aboutBody")} />
    <section className="settings-card">
      <div className="setting-row"><div><strong>{t("app.name")}</strong><span>{t("settings.aboutAppVersion")}</span></div><Pill tone="neutral">{desktopInfo?.version ?? t("settings.aboutWebClient")}</Pill></div>
      <DesktopAutoRelaunchSetting t={t} />
      {desktopInfo !== undefined && <div className="setting-row"><div><strong>{t("settings.aboutDesktopRuntime")}</strong><span>{desktopInfo.platform}</span></div><Pill tone="neutral">Electron {desktopInfo.electronVersion}</Pill></div>}
      <div className="setting-row"><div><strong>{snapshot.server.name}</strong><span>{t("settings.aboutOrchestratorVersion")}</span></div><Pill tone="neutral">{snapshot.server.version || t("common.unavailable")}</Pill></div>
      {snapshot.backends.map((backend) => <div className="setting-row" key={backend.id}><div><strong>{backend.name}</strong><span>{t("settings.aboutBackendVersion")}</span></div><Pill tone={backend.health === "healthy" ? "success" : "warning"}>{backend.version || t("common.unavailable")}</Pill></div>)}
    </section>
    {controller !== undefined && <TaskHistoryMaintenanceCard controller={controller} t={t} />}
    {controller !== undefined && <ArtifactStorageSettingsCard controller={controller} snapshot={snapshot} t={t} />}
    <DesktopBetaChannelSetting t={t} />
  </>;
}

export function TaskHistoryMaintenanceCard({ controller, t }: {
  readonly controller: AppController;
  readonly t: Translator;
}): JSX.Element {
  const [support, setSupport] = useState<TaskHistoryMaintenanceSupportView>();
  const [retention, setRetention] = useState<TaskHistoryRetentionView>("7-days");
  const [includeActiveTasks, setIncludeActiveTasks] = useState(false);
  const [backupEnabled, setBackupEnabled] = useState(true);
  const [activeConfirmationOpen, setActiveConfirmationOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "scanning" | "report" | "executing">("idle");
  const [scan, setScan] = useState<TaskHistoryScanView>();
  const [cleanup, setCleanup] = useState<TaskHistoryCleanupView>();
  const [progress, setProgress] = useState<TaskHistoryCleanupProgressView>();
  const [error, setError] = useState<string>();
  const reportConfirmRef = useRef<HTMLButtonElement>(null);
  const activeConfirmRef = useRef<HTMLButtonElement>(null);
  const controllerRef = useRef(controller);
  const progressGenerationRef = useRef(0);
  controllerRef.current = controller;

  useEffect(() => {
    let mounted = true;
    void controllerRef.current.getTaskHistoryMaintenanceSupport().then((next) => {
      if (mounted) setSupport(next);
    }).catch(() => {
      if (mounted) setError(t("settings.taskHistoryLoadFailed"));
    });
    return () => { mounted = false; };
  }, [t]);

  useEffect(() => () => { progressGenerationRef.current += 1; }, []);

  useEffect(() => {
    if (scan === undefined || phase !== "report") return;
    const delay = Math.max(0, scan.expiresAt - Date.now());
    const timer = window.setTimeout(() => {
      setScan((current) => current?.scanId === scan.scanId ? undefined : current);
      setPhase((current) => current === "report" ? "idle" : current);
      setError(t("settings.taskHistoryScanExpired"));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [phase, scan, t]);

  const invalidateScan = (): void => {
    setScan(undefined);
    setCleanup(undefined);
    setProgress(undefined);
    setError(undefined);
    setPhase("idle");
  };

  const startScan = (): void => {
    if (phase !== "idle" || support?.supported !== true) return;
    setError(undefined);
    setCleanup(undefined);
    setProgress(undefined);
    setScan(undefined);
    setPhase("scanning");
    void controllerRef.current.scanTaskHistory(retention, includeActiveTasks).then((next) => {
      setScan(next);
      setPhase("report");
    }).catch(() => {
      setPhase("idle");
      setError(t("settings.taskHistoryScanFailed"));
    });
  };

  const finishCleanupProgress = (next: Exclude<TaskHistoryCleanupProgressView, { readonly status: "running" }>): void => {
    setScan(undefined);
    setPhase("idle");
    if (next.status === "completed") setCleanup(next.result);
    if (next.status === "scanExpired") setError(t("settings.taskHistoryScanExpired"));
    if (next.status === "storageChanged") setError(t("settings.taskHistoryChanged"));
    if (next.status === "cancelled") setError(t("settings.taskHistoryCancelled"));
    if (next.status === "failed") setError(t("settings.taskHistoryCleanupFailed"));
  };

  const confirmCleanup = (): void => {
    const accepted = scan;
    if (phase !== "report" || accepted === undefined || accepted.expiresAt <= Date.now()) {
      setScan(undefined);
      setPhase("idle");
      setError(t("settings.taskHistoryScanExpired"));
      return;
    }
    setPhase("executing");
    setError(undefined);
    const generation = ++progressGenerationRef.current;
    void (async () => {
      try {
        let next = await controllerRef.current.beginTaskHistoryCleanup(accepted.scanId, backupEnabled);
        while (generation === progressGenerationRef.current) {
          setProgress(next);
          if (next.status !== "running") {
            finishCleanupProgress(next);
            return;
          }
          await new Promise<void>((resolveDelay) => window.setTimeout(resolveDelay, 250));
          if (generation !== progressGenerationRef.current) return;
          next = await controllerRef.current.getTaskHistoryCleanup(next.maintenanceId);
        }
      } catch {
        if (generation !== progressGenerationRef.current) return;
        setPhase("idle");
        setError(t("settings.taskHistoryCleanupFailed"));
      }
    })();
  };

  const cancelCleanup = (): void => {
    if (progress?.status !== "running" || !progress.cancellable) return;
    void controllerRef.current.cancelTaskHistoryCleanup(progress.maintenanceId).then((next) => {
      setProgress(next);
      if (next.status !== "running") {
        progressGenerationRef.current += 1;
        finishCleanupProgress(next);
      }
    }).catch(() => setError(t("settings.taskHistoryCancelFailed")));
  };

  const supported = support?.supported === true;
  const busy = phase === "scanning" || phase === "executing";
  const insufficientSpace = scan?.databaseVolumeFreeBytes !== undefined
    && scan.databaseVolumeFreeBytes < scan.temporaryBytesRequired;
  const totalCleanedTasks = cleanup?.outcome === "completed"
    ? cleanup.activeTaskCount + cleanup.deletedTaskCount + cleanup.archivedTaskCount
    : 0;

  return <>
    <SettingsSectionHeading title={t("settings.taskHistoryTitle")} body={t("settings.taskHistoryBody")} />
    {error !== undefined && <ErrorBanner message={error} onClose={() => setError(undefined)} />}
    <section className="settings-card task-history-card" aria-busy={busy || undefined}>
      <div className="setting-row">
        <div><strong><Database aria-hidden="true" />{t("settings.taskHistoryLabel")}</strong><span>{support === undefined
          ? t("common.loading")
          : supported ? t("settings.taskHistoryDescription") : support.reason ?? t("settings.taskHistoryUnavailable")}</span></div>
        <Button tone="primary" disabled={!supported || phase !== "idle"} onClick={startScan}>{t("settings.taskHistoryScan")}</Button>
      </div>
      <div className="task-history-options">
        <div className="setting-row">
          <div><strong>{t("settings.taskHistoryRetention")}</strong></div>
          <SelectControl
            aria-label={t("settings.taskHistoryRetention")}
            value={retention}
            disabled={phase !== "idle"}
            onChange={(event) => {
              setRetention(event.target.value as TaskHistoryRetentionView);
              invalidateScan();
            }}
          >
            <option value="7-days">{t("settings.taskHistoryRetention7Days")}</option>
            <option value="1-month">{t("settings.taskHistoryRetention1Month")}</option>
            <option value="3-months">{t("settings.taskHistoryRetention3Months")}</option>
            <option value="6-months">{t("settings.taskHistoryRetention6Months")}</option>
          </SelectControl>
        </div>
        <div className="setting-row">
          <div><strong>{t("settings.taskHistoryIncludeActive")}</strong><span>{t("settings.taskHistoryIncludeActiveBody")}</span></div>
          <SwitchControl
            aria-label={t("settings.taskHistoryIncludeActive")}
            checked={includeActiveTasks}
            disabled={phase !== "idle"}
            onChange={(event) => {
              if (event.target.checked) setActiveConfirmationOpen(true);
              else {
                setIncludeActiveTasks(false);
                invalidateScan();
              }
            }}
          />
        </div>
        <div className="setting-row">
          <div><strong>{t("settings.taskHistoryBackup")}</strong><span>{t("settings.taskHistoryBackupBody")}</span></div>
          <SwitchControl
            aria-label={t("settings.taskHistoryBackup")}
            checked={backupEnabled}
            disabled={phase !== "idle"}
            onChange={(event) => {
              setBackupEnabled(event.target.checked);
              invalidateScan();
            }}
          />
        </div>
      </div>
      {cleanup?.outcome === "completed" && <div className="artifact-storage-report is-healthy task-history-result" role="status">
        <strong>{t("settings.taskHistoryComplete")}</strong>
        <span>{t("settings.taskHistoryCompleteSummary", {
          tasks: totalCleanedTasks,
          messages: cleanup.messageCount,
          bytes: formatArtifactBytes(cleanup.reclaimedBytes),
          skipped: cleanup.skippedTaskCount
        })}</span>
        <span>{cleanup.backupCreated ? t("settings.taskHistoryBackupCreated") : t("settings.taskHistoryNoBackupCreated")}</span>
      </div>}
    </section>

    <Modal
      open={activeConfirmationOpen}
      title={t("settings.taskHistoryActiveConfirmTitle")}
      description={t("settings.taskHistoryActiveConfirmBody")}
      onClose={() => setActiveConfirmationOpen(false)}
      dialogRole="alertdialog"
      dismissOnBackdrop
      size="medium"
      initialFocus={() => activeConfirmRef.current}
    >
      <div className="modal__actions">
        <Button onClick={() => setActiveConfirmationOpen(false)}>{t("settings.taskHistoryKeepActive")}</Button>
        <button
          ref={activeConfirmRef}
          type="button"
          className="button button--danger"
          onClick={() => {
            setIncludeActiveTasks(true);
            setActiveConfirmationOpen(false);
            invalidateScan();
          }}
        >{t("settings.taskHistoryConfirmActive")}</button>
      </div>
    </Modal>

    <Modal
      key={phase === "report" ? `report:${scan?.scanId ?? ""}` : phase}
      open={phase === "scanning" || phase === "report" || phase === "executing"}
      title={phase === "report" ? t("settings.taskHistoryReportTitle") : phase === "executing" ? t("settings.taskHistoryExecuting") : t("settings.taskHistoryScanning")}
      onClose={() => { if (phase === "report") invalidateScan(); }}
      dialogRole="alertdialog"
      dismissOnBackdrop={phase === "report"}
      size="large"
      className="task-history-modal"
      initialFocus={() => reportConfirmRef.current}
    >
      {busy && <div className="task-history-busy" role="status" aria-live="assertive">
        <Spinner label={phase === "executing" ? t("settings.taskHistoryExecuting") : t("settings.taskHistoryScanning")} />
        {phase === "executing" && progress?.status === "running" && <>
          <span>{t(`settings.taskHistoryPhase.${progress.phase}`)} · {progress.percent}%</span>
          <progress max={100} value={progress.percent} aria-label={t("settings.taskHistoryProgress", { percent: progress.percent })} />
          {progress.cancellable && <Button onClick={cancelCleanup}>{t("settings.taskHistoryCancel")}</Button>}
        </>}
      </div>}
      {phase === "report" && scan !== undefined && <>
        <div className="task-history-report">
          <p>{t(scan.includeActiveTasks ? "settings.taskHistoryReportTasksWithActive" : "settings.taskHistoryReportTasks", {
            active: scan.activeTaskCount,
            deleted: scan.deletedTaskCount,
            archived: scan.archivedTaskCount
          })}</p>
          <p>{t("settings.taskHistoryReportMessages", { messages: scan.messageCount, bytes: formatArtifactBytes(scan.estimatedHistoryBytes) })}</p>
          <p>{t("settings.taskHistoryReportSpace", {
            database: formatArtifactBytes(scan.databaseBytes),
            temporary: formatArtifactBytes(scan.temporaryBytesRequired),
            free: scan.databaseVolumeFreeBytes === undefined ? t("settings.taskHistorySpaceUnknown") : formatArtifactBytes(scan.databaseVolumeFreeBytes)
          })}</p>
          {insufficientSpace && <p className="task-history-warning" role="alert">{t("settings.taskHistoryInsufficientSpace")}</p>}
          {scan.messageCount === 0 && <p>{t("settings.taskHistoryNothingToClean")}</p>}
          <p className="task-history-note">{backupEnabled ? t("settings.taskHistoryConfirmWithBackup") : t("settings.taskHistoryConfirmWithoutBackup")}</p>
          <p className="task-history-note">{t("settings.taskHistoryFilesRetained")}</p>
        </div>
        <div className="modal__actions">
          <Button onClick={invalidateScan}>{t("common.cancel")}</Button>
          <button
            ref={reportConfirmRef}
            type="button"
            className="button button--danger"
            disabled={insufficientSpace || scan.messageCount === 0}
            onClick={confirmCleanup}
          >{t("settings.taskHistoryConfirm")}</button>
        </div>
      </>}
    </Modal>
  </>;
}

export function ArtifactStorageSettingsCard({ controller, snapshot, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly t: Translator;
}): JSX.Element {
  const [capability, setCapability] = useState<ArtifactStorageMaintenanceView>();
  const [scan, setScan] = useState<ArtifactStorageScanView>();
  const [reconcile, setReconcile] = useState<ArtifactStorageReconcileView>();
  const [cleanup, setCleanup] = useState<ArtifactStorageCleanupView>();
  const [busy, setBusy] = useState<"stats" | "scan" | "reconcile" | "cleanup">("stats");
  const [error, setError] = useState<string>();
  const activeOperation = useRef(false);
  const controllerRef = useRef(controller);
  const snapshotRef = useRef(snapshot);
  controllerRef.current = controller;
  snapshotRef.current = snapshot;

  const loadStats = async (): Promise<void> => {
    setBusy("stats");
    setError(undefined);
    try {
      const protectedSha256 = await activeDraftAttachmentSha256(controllerRef.current, snapshotRef.current);
      setCapability(await controllerRef.current.getArtifactStorageStats(protectedSha256));
    } catch {
      setError(t("settings.artifactStorageLoadFailed"));
    } finally {
      setBusy((current) => current === "stats" ? "scan" : current);
    }
  };

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const protectedSha256 = await activeDraftAttachmentSha256(controllerRef.current, snapshotRef.current);
        const next = await controllerRef.current.getArtifactStorageStats(protectedSha256);
        if (mounted) setCapability(next);
      } catch {
        if (mounted) setError(t("settings.artifactStorageLoadFailed"));
      } finally {
        if (mounted) setBusy("scan");
      }
    })();
    return () => { mounted = false; };
  }, [t]);

  useEffect(() => {
    if (scan === undefined) return;
    const delay = Math.max(0, scan.expiresAt - Date.now());
    const timer = window.setTimeout(() => {
      setScan((current) => current?.token === scan.token ? undefined : current);
      setError(t("settings.artifactStorageScanExpired"));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [scan, t]);

  const runExclusive = async (operation: () => Promise<void>): Promise<void> => {
    if (activeOperation.current) return;
    activeOperation.current = true;
    setError(undefined);
    try {
      await operation();
    } finally {
      activeOperation.current = false;
    }
  };

  const startScan = (): void => {
    void runExclusive(async () => {
      try {
        const protectedSha256 = await activeDraftAttachmentSha256(controllerRef.current, snapshotRef.current);
        setCleanup(undefined);
        setScan(await controllerRef.current.scanArtifactStorage(protectedSha256));
      } catch {
        setError(t("settings.artifactStorageScanFailed"));
      }
    });
  };

  const runReconcile = (): void => {
    void runExclusive(async () => {
      try {
        const protectedSha256 = await activeDraftAttachmentSha256(controllerRef.current, snapshotRef.current);
        setReconcile(await controllerRef.current.reconcileArtifactStorage(protectedSha256));
      } catch {
        setError(t("settings.artifactStorageReconcileFailed"));
      }
    });
  };

  const confirmCleanup = (): void => {
    const accepted = scan;
    if (accepted === undefined || accepted.expiresAt <= Date.now()) {
      setScan(undefined);
      setError(t("settings.artifactStorageScanExpired"));
      return;
    }
    void runExclusive(async () => {
      try {
        const protectedSha256 = await activeDraftAttachmentSha256(controllerRef.current, snapshotRef.current);
        const result = await controllerRef.current.cleanupArtifactStorage(accepted.token, protectedSha256);
        setScan(undefined);
        setCleanup(result);
        if (result.outcome === "scanExpired") setError(t("settings.artifactStorageScanExpired"));
        if (result.outcome === "storageChanged") setError(t("settings.artifactStorageChanged"));
        if (result.outcome === "completed") await loadStats();
      } catch {
        setError(t("settings.artifactStorageCleanupFailed"));
      }
    });
  };

  const supported = capability?.support === "supported" && capability.stats !== undefined;
  const stats = capability?.stats;
  return <>
    <SettingsSectionHeading title={t("settings.artifactStorageTitle")} body={t("settings.artifactStorageBody")} />
    {error !== undefined && <ErrorBanner message={error} onRetry={() => { void loadStats(); }} onClose={() => setError(undefined)} />}
    <section className="settings-card artifact-storage-card">
      <div className="setting-row">
        <div><strong><Database aria-hidden="true" />{t("settings.artifactStorageUsage")}</strong><span>{stats === undefined
          ? capability?.reason ?? t(busy === "stats" ? "common.loading" : "common.unavailable")
          : t("settings.artifactStorageUsageSummary", {
              blobs: stats.uniqueBlobCount,
              bytes: formatArtifactBytes(stats.totalBytes),
              references: stats.referenceCount
            })}</span></div>
        <Pill tone={supported ? "success" : "neutral"}>{supported ? t("common.available") : t("common.unavailable")}</Pill>
      </div>
      {stats !== undefined && <div className="artifact-storage-metrics">
        <span><strong>{formatArtifactBytes(stats.cacheBytes)}</strong>{t("settings.artifactStorageCache")}</span>
        <span><strong>{formatArtifactBytes(stats.temporaryBytes)}</strong>{t("settings.artifactStorageTemporary")}</span>
      </div>}
      {reconcile !== undefined && <div className={cx("artifact-storage-report", reconcile.healthy ? "is-healthy" : "has-issues")} role="status">
        <strong>{reconcile.healthy ? t("settings.artifactStorageHealthy") : t("settings.artifactStorageIssues")}</strong>
        {!reconcile.healthy && <span>{t("settings.artifactStorageIssueSummary", {
          missing: reconcile.missingBlobCount,
          orphaned: reconcile.orphanBlobCount,
          unsafe: reconcile.unsafeEntryCount
        })}</span>}
      </div>}
      {scan !== undefined && <div className="artifact-storage-report" role="status">
        <strong>{t("settings.artifactStorageConfirmTitle")}</strong>
        <span>{t("settings.artifactStorageScanSummary", {
          bytes: formatArtifactBytes(scan.cleanableBytes),
          references: scan.expiredReferenceCount,
          blobs: scan.orphanBlobCount,
          temporary: scan.temporaryFileCount
        })}</span>
        {scan.protectedReferenceCount > 0 && <span>{t("settings.artifactStorageProtected", { count: scan.protectedReferenceCount })}</span>}
        {(scan.missingBlobCount > 0 || scan.unsafeEntryCount > 0) && <span className="artifact-storage-warning">{t("settings.artifactStorageScanWarnings", {
          missing: scan.missingBlobCount,
          unsafe: scan.unsafeEntryCount
        })}</span>}
        <div className="artifact-storage-confirm-actions">
          <Button onClick={() => setScan(undefined)}>{t("common.cancel")}</Button>
          <Button tone="primary" onClick={confirmCleanup}>{t("settings.artifactStorageConfirmCleanup", { bytes: formatArtifactBytes(scan.cleanableBytes) })}</Button>
        </div>
      </div>}
      {cleanup?.outcome === "completed" && <div className="artifact-storage-report is-healthy" role="status">
        <strong>{t("settings.artifactStorageCleanupComplete")}</strong>
        <span>{t("settings.artifactStorageCleanupSummary", {
          bytes: formatArtifactBytes(cleanup.freedBytes),
          references: cleanup.expiredReferencesDeleted,
          blobs: cleanup.blobsRemoved,
          temporary: cleanup.temporaryFilesRemoved,
          skipped: cleanup.skipped
        })}</span>
      </div>}
      <div className="settings-toolbar artifact-storage-actions">
        <Button disabled={!supported} onClick={runReconcile}>{t("settings.artifactStorageReconcile")}</Button>
        <Button tone="primary" disabled={!supported} onClick={startScan}>{t("settings.artifactStorageScan")}</Button>
      </div>
    </section>
  </>;
}

export async function activeDraftAttachmentSha256(controller: AppController, snapshot: AppSnapshot): Promise<string[]> {
  const drafts = await Promise.all([
    ...snapshot.sessions.map((session) => controller.readDraft(session.id)),
    controller.readNewSessionDraft()
  ]);
  const files = drafts.flatMap((draft) => {
    if (draft === undefined) return [];
    const commentFiles = "browserComments" in draft
      ? (draft.browserComments ?? []).map((item) => item.screenshot.file)
      : [];
    return [...draft.attachments.map((attachment) => attachment.file), ...commentFiles];
  });
  if (files.length > 1_000) throw new Error("Too many active draft attachments.");
  return [...new Set(await Promise.all(files.map(async (file) => sha256Hex(await file.arrayBuffer()))))].sort();
}

function formatArtifactBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1_024; index += 1) {
    value /= 1_024;
    unit = units[index]!;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

interface FontPreset {
  readonly id: string;
  readonly label: string;
  readonly family: string;
}

export function FontFamilySetting({ label, description, value, presets, preview, previewLanguage, fallback, onChange, t }: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly presets: readonly FontPreset[];
  readonly preview: string;
  readonly previewLanguage?: string;
  readonly fallback: string;
  readonly onChange: (family: string) => Promise<void>;
  readonly t: Translator;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [customValue, setCustomValue] = useState(value);
  const selectedPreset = presets.find((preset) => preset.family === value);
  const [previewFamily, setPreviewFamily] = useState<string>();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setCustomValue(value);
  }, [value]);
  useEffect(() => {
    if (!open) setPreviewFamily(undefined);
  }, [open]);
  const activeFamily = previewFamily ?? value;
  const activePreviewFamily = activeFamily.trim() ? `${activeFamily}, ${fallback}` : fallback;
  const previewTokens = useMemo(
    () => timelineCodeHighlight(preview, previewLanguage),
    [preview, previewLanguage]
  );
  const selectedLabel = selectedPreset?.label ?? (fontFamilyDisplayName(value) || t("settings.appearance.fontDefault"));
  const selectFamily = (family: string): void => {
    void onChange(family.trim());
    setOpen(false);
  };
  return (
    <div className="appearance-font-family">
      <div className="appearance-font-setting__heading">
        <div><strong>{label}</strong><span>{description}</span></div>
        <IconButton label={t("settings.appearance.fontReset")} disabled={value.length === 0} onClick={() => void onChange("")}><RotateCcw aria-hidden="true" /></IconButton>
      </div>
      <MorphPopover
        open={open}
        onOpenChange={setOpen}
        label={label}
        trigger={<button
          type="button"
          className="appearance-font-picker__trigger"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span>{selectedLabel}</span>
          <ChevronDown aria-hidden="true" />
        </button>}
        panelWidth={560}
        side="top"
        align="start"
        className="appearance-font-picker"
        panelClassName="appearance-font-picker__panel"
        panelElementRef={panelRef}
        initialFocus={() => panelRef.current?.querySelector<HTMLElement>("[data-font-selected]") ?? null}
      >
        <div className="appearance-font-picker__content" onMouseLeave={() => setPreviewFamily(undefined)}>
          <pre className="appearance-font-preview" style={{ fontFamily: activePreviewFamily }}><code>{fontPreviewContents(preview, previewTokens)}</code></pre>
          <div className="appearance-font-picker__group">
            <strong>{t("settings.appearance.fontPresets")}</strong>
            <div className="appearance-font-picker__options" role="listbox" aria-label={label}>
              {presets.map((preset) => {
                const selected = preset.family === value;
                return <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-morph-autofocus={selected ? "" : undefined}
                  data-font-selected={selected ? "" : undefined}
                  className={selected ? "is-selected" : undefined}
                  key={preset.id}
                  onMouseEnter={() => setPreviewFamily(preset.family)}
                  onMouseLeave={() => setPreviewFamily(undefined)}
                  onFocus={() => setPreviewFamily(preset.family)}
                  onBlur={() => setPreviewFamily(undefined)}
                  onClick={() => selectFamily(preset.family)}
                >
                  <span style={{ fontFamily: preset.family.trim() ? `${preset.family}, ${fallback}` : fallback }}>{preset.label}</span>
                  {selected && <Check aria-hidden="true" />}
                </button>;
              })}
            </div>
          </div>
          <div className="appearance-font-picker__group appearance-font-picker__custom">
            <strong>{t("settings.appearance.fontCustom")}</strong>
            <div>
              <input
                value={customValue}
                maxLength={256}
                aria-label={t("settings.appearance.fontCustom")}
                data-font-selected={selectedPreset === undefined ? "" : undefined}
                placeholder={t("settings.appearance.fontCustomPlaceholder")}
                onChange={(event) => {
                  setCustomValue(event.target.value);
                  setPreviewFamily(event.target.value);
                }}
                onFocus={() => setPreviewFamily(customValue)}
                onBlur={() => setPreviewFamily(undefined)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && customValue.trim() !== "") selectFamily(customValue);
                }}
              />
              <Button disabled={customValue.trim() === "" || customValue.trim() === value} onClick={() => selectFamily(customValue)}>{t("settings.appearance.fontApply")}</Button>
            </div>
          </div>
        </div>
      </MorphPopover>
    </div>
  );
}

function fontPreviewContents(source: string, tokens: readonly { readonly from: number; readonly to: number; readonly className: string }[]): ReactNode {
  if (tokens.length === 0) return source;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  tokens.forEach((token, index) => {
    if (token.from > cursor) nodes.push(source.slice(cursor, token.from));
    nodes.push(<span className={token.className} key={`${token.from}:${token.to}:${index}`}>{source.slice(token.from, token.to)}</span>);
    cursor = token.to;
  });
  if (cursor < source.length) nodes.push(source.slice(cursor));
  return nodes;
}

function fontFamilyDisplayName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  return (quote === '"' || quote === "'") && trimmed.endsWith(quote)
    ? trimmed.slice(1, -1).replace(/\\(["'\\])/gu, "$1")
    : trimmed;
}

function FontSizeSetting({ label, description, value, min, max, defaultValue, onChange, t }: {
  readonly label: string;
  readonly description: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
  readonly onChange: (size: number) => Promise<void>;
  readonly t: Translator;
}): JSX.Element {
  return (
    <div className="appearance-font-size">
      <div className="appearance-font-setting__heading">
        <div><strong>{label}</strong><span>{description}</span></div>
        <IconButton label={t("settings.appearance.fontReset")} disabled={value === defaultValue} onClick={() => void onChange(defaultValue)}><RotateCcw aria-hidden="true" /></IconButton>
      </div>
      <div className="appearance-font-size__controls">
        <input type="range" min={min} max={max} step={1} value={value} aria-label={label} onChange={(event) => void onChange(Number(event.target.value))} />
        <input type="number" min={min} max={max} step={1} value={value} aria-label={`${label} · px`} onChange={(event) => void onChange(Number(event.target.value))} />
      </div>
    </div>
  );
}

export function PersonalizationSettings({ controller, snapshot, runAction, onSuccess, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly runAction: RunAction;
  readonly onSuccess: (text: string) => void;
  readonly t: Translator;
}): JSX.Element {
  const settings = snapshot.settings.messageSearch;
  const savedPrompt = controller.getPersonalizationPrompt();
  const [promptDraft, setPromptDraft] = useState(savedPrompt);
  const [promptPending, setPromptPending] = useState(false);
  const [enabled, setEnabled] = useState(settings.semanticIndexEnabled);
  const [pending, setPending] = useState(false);
  const [linkPreference, setLinkPreference] = useState(controller.state.preferences.linkOpenPreference);
  const [linkPending, setLinkPending] = useState(false);
  const [streamFadeEnabled, setStreamFadeEnabled] = useState(controller.state.preferences.streamFadeEnabled);
  const [streamFadePending, setStreamFadePending] = useState(false);
  const [messageNavRailEnabled, setMessageNavRailEnabled] = useState(controller.state.preferences.messageNavRailEnabled);
  const [messageNavRailPending, setMessageNavRailPending] = useState(false);
  const piSettings = snapshot.settings.pi[0];
  const authoritativeThreshold = piSettings?.autoCompactionThresholdPercent ?? 75;
  const [threshold, setThreshold] = useState(authoritativeThreshold);
  const [thresholdSaving, setThresholdSaving] = useState(false);
  const thresholdTimer = useRef<number | undefined>(undefined);
  useEffect(() => setPromptDraft(savedPrompt), [savedPrompt]);
  useEffect(() => setEnabled(settings.semanticIndexEnabled), [settings.semanticIndexEnabled]);
  useEffect(() => setLinkPreference(controller.state.preferences.linkOpenPreference), [controller.state.preferences.linkOpenPreference]);
  useEffect(() => setStreamFadeEnabled(controller.state.preferences.streamFadeEnabled), [controller.state.preferences.streamFadeEnabled]);
  useEffect(() => setMessageNavRailEnabled(controller.state.preferences.messageNavRailEnabled), [controller.state.preferences.messageNavRailEnabled]);
  useEffect(() => setThreshold(authoritativeThreshold), [authoritativeThreshold]);
  useEffect(() => () => {
    if (thresholdTimer.current !== undefined) window.clearTimeout(thresholdTimer.current);
  }, []);
  const available = settings.vectorAvailable && settings.embeddingProviderAvailable;
  const queued = settings.pendingCount + settings.runningCount;
  const status = !settings.vectorAvailable
    ? t("settings.chatEmbedding.vectorUnavailable")
    : !settings.embeddingProviderAvailable
      ? t("settings.chatEmbedding.providerUnavailable", { model: settings.modelId })
      : queued > 0
        ? t("settings.chatEmbedding.indexing", { count: queued })
        : settings.failedCount > 0
          ? t("settings.chatEmbedding.failed", { count: settings.failedCount })
          : t("settings.chatEmbedding.indexed", { count: settings.doneCount });
  const toggle = (next: boolean, feedback: "toggle" | "reset" = "toggle"): void => {
    const previous = enabled;
    setEnabled(next);
    setPending(true);
    runAction(`message-search-semantic-index:${feedback === "reset" ? "reset" : next ? "enabled" : "disabled"}`, async () => {
      try {
        if (feedback === "reset") await controller.resetMessageSearchSettings();
        else await controller.updateMessageSearchSettings(next);
      } catch (error) {
        setEnabled(previous);
        throw error;
      } finally {
        setPending(false);
      }
    });
  };
  const savePrompt = (): void => {
    if (promptPending || promptDraft.length > 8_000 || promptDraft === savedPrompt) return;
    setPromptPending(true);
    runAction("personalization-prompt", async () => {
      try {
        await controller.setPersonalizationPrompt(promptDraft);
      } finally {
        setPromptPending(false);
      }
    });
  };
  const resetPrompt = (): void => {
    if (promptPending || savedPrompt.length === 0) return;
    const previous = promptDraft;
    setPromptDraft("");
    setPromptPending(true);
    runAction("personalization-prompt:reset", async () => {
      try {
        await controller.resetPersonalizationPrompt();
      } catch (error) {
        setPromptDraft(previous);
        throw error;
      } finally {
        setPromptPending(false);
      }
    });
  };
  const updateThreshold = (next: number): void => {
    if (piSettings === undefined) return;
    const normalized = Math.max(50, Math.min(95, Math.round(next)));
    setThreshold(normalized);
    if (thresholdTimer.current !== undefined) window.clearTimeout(thresholdTimer.current);
    thresholdTimer.current = window.setTimeout(() => {
      thresholdTimer.current = undefined;
      setThresholdSaving(true);
      runAction("pi-auto-compact-threshold", async () => {
        try {
          await controller.updatePiSettings(piSettings.backendId, { autoCompactionThresholdPercent: normalized });
        } catch (error) {
          setThreshold(authoritativeThreshold);
          throw error;
        } finally {
          setThresholdSaving(false);
        }
      });
    }, 300);
  };
  const resetThreshold = (): void => {
    if (piSettings === undefined || thresholdSaving) return;
    if (thresholdTimer.current !== undefined) window.clearTimeout(thresholdTimer.current);
    thresholdTimer.current = undefined;
    setThreshold(75);
    setThresholdSaving(true);
    runAction("pi-auto-compact-threshold:reset", async () => {
      try {
        await controller.updatePiSettings(piSettings.backendId, { resetAutoCompactionThresholdPercent: true });
      } catch (error) {
        setThreshold(authoritativeThreshold);
        throw error;
      } finally {
        setThresholdSaving(false);
      }
    });
  };
  const updateLinkPreference = (next: "sidebar" | "external", reset = false): void => {
    if (linkPending) return;
    const previous = linkPreference;
    setLinkPreference(next);
    setLinkPending(true);
    runAction(reset ? "link-open:reset" : `link-open:${next}`, async () => {
      try {
        if (reset) await controller.resetLinkOpenPreference();
        else await controller.setLinkOpenPreference(next);
      } catch (error) {
        setLinkPreference(previous);
        throw error;
      } finally {
        setLinkPending(false);
      }
    });
  };
  const updateStreamFade = (next: boolean, reset = false): void => {
    if (streamFadePending) return;
    const previous = streamFadeEnabled;
    setStreamFadeEnabled(next);
    setStreamFadePending(true);
    runAction(reset ? "stream-fade:reset" : `stream-fade:${next ? "enabled" : "disabled"}`, async () => {
      try {
        if (reset) await controller.resetStreamFadeEnabled();
        else await controller.setStreamFadeEnabled(next);
      } catch (error) {
        setStreamFadeEnabled(previous);
        throw error;
      } finally {
        setStreamFadePending(false);
      }
    });
  };
  const updateMessageNavRail = (next: boolean, reset = false): void => {
    if (messageNavRailPending) return;
    const previous = messageNavRailEnabled;
    setMessageNavRailEnabled(next);
    setMessageNavRailPending(true);
    runAction(reset ? "message-nav-rail:reset" : `message-nav-rail:${next ? "enabled" : "disabled"}`, async () => {
      try {
        if (reset) await controller.resetMessageNavRailEnabled();
        else await controller.setMessageNavRailEnabled(next);
      } catch (error) {
        setMessageNavRailEnabled(previous);
        throw error;
      } finally {
        setMessageNavRailPending(false);
      }
    });
  };
  const promptOverLimit = promptDraft.length > 8_000;
  const promptCanSave = promptDraft !== savedPrompt && !promptOverLimit && !promptPending;
  return (
    <div className="personalization-settings">
      <section className="personalization-section" aria-labelledby="personalization-prompt-heading">
        <div className="personalization-section__heading personalization-section__heading--actions"><h2 id="personalization-prompt-heading">{t("settings.personalization")}</h2><DefaultOverrideControls customized={savedPrompt.length > 0} disabled={promptPending} t={t} onReset={resetPrompt} /></div>
        <div className="personalization-card personalization-prompt-card">
          <div className="personalization-copy">
            <strong>{t("settings.personalization.promptSubtitle")}</strong>
            <p>{t("settings.personalization.promptDescription")}</p>
          </div>
          <textarea
            value={promptDraft}
            rows={7}
            aria-label={t("settings.personalization.promptAria")}
            placeholder={t("settings.personalization.promptPlaceholder")}
            onChange={(event) => setPromptDraft(event.target.value)}
          />
          <div className="personalization-prompt-card__footer">
            <p className={cx(promptOverLimit && "danger-text")} aria-live="polite">
              {promptDraft.length.toLocaleString()} / {Number(8_000).toLocaleString()}
              {promptOverLimit ? t("settings.personalization.promptOverLimit") : ""}
            </p>
            <Button tone="primary" aria-busy={promptPending} disabled={!promptCanSave} onClick={savePrompt}>{promptPending ? t("common.working") : t("common.save")}</Button>
          </div>
        </div>
      </section>

      <PersonalizationMemorySettings controller={controller} snapshot={snapshot} runAction={runAction} onSuccess={onSuccess} t={t} />

      <VisionBridgeSection controller={controller} snapshot={snapshot} runAction={runAction} t={t} />

      {piSettings !== undefined && <section className="personalization-section" aria-labelledby="personalization-compaction-heading">
        <div className="personalization-section__heading">
          <h2 id="personalization-compaction-heading">{t("settings.compaction.title")}</h2>
          <p>{t("settings.compaction.description")}</p>
        </div>
        <div className="personalization-card personalization-compaction-card">
          <div className="personalization-card__title-row">
            <strong>{t("settings.compaction.label")}</strong>
            <div className="personalization-card__title-actions">
              <span className="personalization-badge">Pi</span>
              <DefaultOverrideControls customized={piSettings.autoCompactionThresholdCustomized} disabled={thresholdSaving} t={t} onReset={resetThreshold} />
            </div>
          </div>
          <p>{t("settings.compaction.cardDescription")}</p>
          <div className="personalization-range">
            <div>
              <input
                type="range"
                min={50}
                max={95}
                step={1}
                value={threshold}
                disabled={thresholdSaving}
                aria-busy={thresholdSaving}
                aria-label={t("settings.compaction.sliderAria")}
                style={{ "--personalization-range-progress": `${(threshold - 50) / 45 * 100}%` } as CSSProperties}
                onChange={(event) => updateThreshold(Number(event.target.value))}
              />
              <span><small>50%</small><small>95%</small></span>
            </div>
            <output>{threshold}%</output>
          </div>
          <p>{t("settings.compaction.hint")}</p>
        </div>
      </section>}

      <section className="personalization-section" aria-labelledby="personalization-links-heading">
        <div className="personalization-section__heading">
          <h2 id="personalization-links-heading">{t("settings.linkOpen.title")}</h2>
          <p>{t("settings.linkOpen.description")}</p>
        </div>
        <div className="personalization-card personalization-link-card">
          <div className="personalization-card__title-row">
            <strong>{t("settings.linkOpen.label")}</strong>
            <DefaultOverrideControls customized={linkPreference !== "sidebar"} disabled={linkPending} t={t} onReset={() => updateLinkPreference("sidebar", true)} />
          </div>
          <p>{t("settings.linkOpen.cardDescription")}</p>
          <div className="personalization-segmented" role="radiogroup" aria-label={t("settings.linkOpen.aria")}>
            <button type="button" role="radio" aria-checked={linkPreference === "sidebar"} className={linkPreference === "sidebar" ? "is-active" : ""} disabled={linkPending} onClick={() => updateLinkPreference("sidebar")}>{t("settings.linkOpen.sidebar")}</button>
            <button type="button" role="radio" aria-checked={linkPreference === "external"} className={linkPreference === "external" ? "is-active" : ""} disabled={linkPending} onClick={() => updateLinkPreference("external")}>{t("settings.linkOpen.external")}</button>
          </div>
        </div>
      </section>

      <section className="personalization-section" aria-labelledby="personalization-stream-heading">
        <h2 id="personalization-stream-heading">{t("settings.streamFade.title")}</h2>
        <div className="personalization-card personalization-stream-card">
          <div className="personalization-copy">
            <strong>{t("settings.streamFade.label")}</strong>
            <p>{t("settings.streamFade.hint")}</p>
          </div>
          <div className="personalization-row-actions"><DefaultOverrideControls customized={!streamFadeEnabled} disabled={streamFadePending} t={t} onReset={() => updateStreamFade(true, true)} /><SwitchControl checked={streamFadeEnabled} disabled={streamFadePending} aria-label={t("settings.streamFade.toggleAria")} onChange={(event) => updateStreamFade(event.target.checked)} /></div>
        </div>
      </section>

      <section className="personalization-section" aria-labelledby="personalization-tips-heading">
        <div className="personalization-section__heading">
          <h2 id="personalization-tips-heading">{t("settings.tips")}</h2>
          <p>{t("settings.tipsDescription")}</p>
        </div>
        <div className="personalization-card personalization-tips-card">
          <PromptRecommendationCell controller={controller} snapshot={snapshot} runAction={runAction} t={t} />
          <SilentEncryptedRetryCell controller={controller} snapshot={snapshot} runAction={runAction} t={t} />
          <SessionRuntimeFallbackCell controller={controller} snapshot={snapshot} runAction={runAction} t={t} />
          <div className="personalization-tip-row">
            <div className="personalization-tip-row__content">
              <span className="personalization-tip-row__icon"><Database aria-hidden="true" /></span>
              <span className="personalization-tip-row__copy">
                <strong>{t("settings.chatEmbedding.label")}</strong>
                <span>{t("settings.chatEmbedding.description", { model: settings.modelId })}</span>
                {(!available || queued > 0 || settings.failedCount > 0) && <small className={available ? undefined : "danger-text"}>{status}</small>}
              </span>
            </div>
            <div className="personalization-row-actions">
              <DefaultOverrideControls customized={settings.customized} disabled={pending} t={t} onReset={() => toggle(true, "reset")} />
              <SwitchControl checked={enabled} disabled={pending || (!available && !enabled)} aria-label={t("settings.chatEmbedding.toggleAria")} onChange={(event) => toggle(event.target.checked)} />
            </div>
          </div>
          <div className="personalization-tip-row">
            <div className="personalization-tip-row__content">
              <span className="personalization-tip-row__icon"><ListOrdered aria-hidden="true" /></span>
              <span className="personalization-tip-row__copy">
                <strong>{t("settings.messageNavRail.label")}</strong>
                <span>{t("settings.messageNavRail.description")}</span>
              </span>
            </div>
            <div className="personalization-row-actions">
              <DefaultOverrideControls customized={!messageNavRailEnabled} disabled={messageNavRailPending} t={t} onReset={() => updateMessageNavRail(true, true)} />
              <SwitchControl checked={messageNavRailEnabled} disabled={messageNavRailPending} aria-label={t("settings.messageNavRail.toggleAria")} onChange={(event) => updateMessageNavRail(event.target.checked)} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function DefaultOverrideControls({ customized, disabled, t, onReset }: {
  readonly customized: boolean;
  readonly disabled?: boolean;
  readonly t: Translator;
  readonly onReset: () => void;
}): JSX.Element | null {
  if (!customized) return null;
  return <div className="personalization-default-controls"><span>{t("settings.defaults.customized")}</span><IconButton label={t("settings.defaults.restore")} disabled={disabled} onClick={onReset}><RotateCcw aria-hidden="true" /></IconButton></div>;
}

/** Emit success toasts only for persisted or explicitly reset settings. */
function personalizationSuccessMessage(action: string, t: Translator): string | undefined {
  if (action === "personalization-prompt") return t("settings.personalization.toast.saved");
  if (action === "personalization-prompt:reset"
    || action === "vision-bridge-target-reset"
    || action === "pi-auto-compact-threshold:reset"
    || action === "link-open:reset"
    || action === "stream-fade:reset"
    || action === "message-nav-rail:reset"
    || action === "prompt-recommendation:reset"
    || action === "message-search-semantic-index:reset"
    || action === "silent-encrypted-retry-reset"
    || action === "session-runtime-fallback-reset") return t("settings.defaults.restored");
  if (action.startsWith("vision-bridge-")) return t("settings.visionBridge.toast.saved");
  if (action === "message-search-semantic-index:enabled") return t("settings.chatEmbedding.toast.enabled");
  if (action === "message-search-semantic-index:disabled") return t("settings.chatEmbedding.toast.disabled");
  if (action === "silent-encrypted-retry:enabled") return t("settings.silentEncryptedRetry.toast.enabled");
  if (action === "silent-encrypted-retry:disabled") return t("settings.silentEncryptedRetry.toast.disabled");
  if (action === "session-runtime-fallback:enabled") return t("settings.sessionRuntimeFallback.toast.enabled");
  if (action === "session-runtime-fallback:disabled") return t("settings.sessionRuntimeFallback.toast.disabled");
  return undefined;
}

function settingsViewportIsCompact(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches;
}

function settingsHashIsRoot(hash: string): boolean {
  const [path = ""] = hash.replace(/^#\/?/, "").split("?", 1);
  const parts = path.split("/").filter(Boolean);
  return parts.length === 1 && parts[0] === "settings";
}

export function settingsSectionFromHash(hash: string): SettingsSection {
  const [path = ""] = hash.replace(/^#\/?/, "").split("?", 1);
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "settings") return "general";
  const candidate = parts[1];
  return SETTINGS_SECTIONS.has(candidate ?? "") ? candidate as SettingsSection : "general";
}

export function settingsSubsectionFromHash(hash: string): SettingsSubsection | undefined {
  const [path = ""] = hash.replace(/^#\/?/, "").split("?", 1);
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "settings") return undefined;
  const candidate = parts[2];
  if (candidate === undefined || !SETTINGS_SUBSECTIONS.has(candidate)) return undefined;
  const subsection = candidate as SettingsSubsection;
  return SETTINGS_SUBSECTION_PARENTS[subsection] === settingsSectionFromHash(hash) ? subsection : undefined;
}

function availableSettingsLocationFromHash(hash: string, nativeTaskStatusVisible: boolean): SettingsLocation {
  const section = settingsSectionFromHash(hash);
  if (section === "taskStatus" && !nativeTaskStatusVisible) return { section: "general" };
  const subsection = settingsSubsectionFromHash(hash);
  return { section, ...(subsection === undefined ? {} : { subsection }) };
}

export function availableSettingsSectionFromHash(hash: string, nativeTaskStatusVisible: boolean): SettingsSection {
  return availableSettingsLocationFromHash(hash, nativeTaskStatusVisible).section;
}

function ThemeButton({ value, current, label, icon, disabled, onChange, onKeyDown }: { readonly value: Theme; readonly current: Theme; readonly label: string; readonly icon: JSX.Element; readonly disabled: boolean; readonly onChange: (theme: Theme) => void; readonly onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void }): JSX.Element {
  const selected = current === value;
  return <button type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} disabled={disabled} className={cx(selected && "is-active")} onClick={() => { if (!selected) onChange(value); }} onKeyDown={onKeyDown}>{icon}<span>{label}</span>{selected && <Check aria-hidden="true" />}</button>;
}

function ConnectionSettings({ controller, snapshot, locale, t, runAction, showHeading = true }: { readonly controller: AppController; readonly snapshot: AppSnapshot; readonly locale: string; readonly t: Translator; readonly runAction: RunAction; readonly showHeading?: boolean }): JSX.Element {
  const activeProfile = controller.state.activeProfile;
  const activeConnections = activeRemoteConnections(snapshot.remoteConnections);
  const remoteConnections = logoutEligibleRemoteConnections(activeConnections, activeProfile?.id);
  const automaticTarget = controller.state.preferences.automaticConnectionTarget;
  const automaticConnectionAvailable = controller.state.automaticConnectionAvailable;
  const automaticProfile = automaticTarget?.kind === "managedLocal"
    ? controller.state.profiles.find((profile) => profile.managedLocal === true)
    : controller.state.profiles.find((profile) => profile.managedLocal !== true && profile.id === automaticTarget?.profileId);
  const automaticName = automaticProfile?.name ?? (automaticTarget?.kind === "managedLocal" ? t("connection.thisComputer") : t("settings.automaticConnectionMissing"));
  const automaticBody = !automaticConnectionAvailable
    ? automaticTarget === undefined
      ? t("settings.automaticConnectionUnavailable")
      : t("settings.automaticConnectionUnavailableTarget", { name: automaticName })
    : automaticTarget === undefined
      ? t("settings.automaticConnectionOffBody")
      : t("settings.automaticConnectionOnBody", { name: automaticName });
  return <>
    {showHeading && <SettingsHeading title={t("settings.connections")} body={t("settings.connectionsBody")} />}
    <section className={cx("settings-card", "automatic-connection-card", automaticTarget !== undefined && "is-enabled")}>
      <div className="setting-row">
        <div>
          <strong>{t("settings.automaticConnection")}</strong>
          <span>{automaticBody}</span>
        </div>
        <div className="automatic-connection-card__actions">
          <Pill tone={automaticTarget === undefined ? "neutral" : "success"}>{automaticTarget === undefined ? t("common.off") : automaticName}</Pill>
          <Button disabled={automaticTarget === undefined && !automaticConnectionAvailable} onClick={() => runAction("automatic-connection", () => controller.setAutomaticConnectionEnabled(automaticTarget === undefined))}>
            {automaticTarget === undefined ? t("settings.automaticConnectionUseCurrent") : t("settings.automaticConnectionTurnOff")}
          </Button>
        </div>
      </div>
    </section>
    <DeviceControlSettings controller={controller} snapshot={snapshot} locale={locale} runAction={runAction} t={t} />
    <h3 className="settings-subheading">{t("settings.savedClient")}</h3>
    <section className="settings-card settings-list">{controller.state.profiles.map((profile) => <article key={profile.id}><div><StatusDot state={activeProfile?.id === profile.id ? controller.state.connectionState : "muted"} label={activeProfile?.id === profile.id ? controller.state.connectionState : t("settings.saved")} /><span><strong>{profile.name}</strong><small>{profile.origin}{profile.lastConnectedAt === undefined ? "" : ` · ${formatRelativeTime(profile.lastConnectedAt, locale)}`}</small></span></div><div>{activeProfile?.id === profile.id && <Pill tone="success">{t("common.current")}</Pill>}{profile.managedLocal !== true && <IconButton label={`${t("common.remove")} ${profile.name}`} onClick={() => void controller.forgetProfile(profile.id)}><Trash2 aria-hidden="true" /></IconButton>}</div></article>)}{controller.state.profiles.length === 0 && <p className="muted">{t("settings.noProfiles")}</p>}</section>
    <h3 className="settings-subheading">{t("settings.orchestratorDevices")}</h3>
    <section className="settings-card settings-list">{snapshot.devices.map((device) => {
    const connections = activeConnections.filter((connection) => connection.deviceId === device.id);
    const current = activeProfile?.deviceId === device.id;
    return <article key={device.id}><div><StatusDot state={device.revoked ? "revoked" : connections.some((connection) => connection.state === "connected") ? "connected" : "disconnected"} label={device.revoked ? "revoked" : "paired"} /><span><strong>{device.name}</strong><small>{device.kind} · {device.platform} · {device.appVersion}{device.lastSeenAt === undefined ? "" : ` · ${formatRelativeTime(device.lastSeenAt, locale)}`}</small></span></div><div>{current && <Pill tone="success">{t("common.current")}</Pill>}{!device.revoked && !current && <Button tone="ghost" className="danger-text" onClick={() => runAction(`revoke-device:${device.id}`, () => controller.revokeDevice(device.id))}>{t("connection.revoke")}</Button>}</div></article>;
  })}{snapshot.devices.length === 0 && <p className="muted">{t("settings.noDevices")}</p>}</section>
    <h3 className="settings-subheading">{t("settings.activeConnections")}</h3>
    <section className="settings-card settings-list">{remoteConnections.map((connection) => <article key={connection.id}><div><StatusDot state={connection.state} label={connection.state} /><span><strong>{connection.name}</strong><small>{connection.state}{connection.lastSeenAt === undefined ? "" : ` · ${formatRelativeTime(connection.lastSeenAt, locale)}`}</small></span></div><Button tone="ghost" onClick={() => runAction(`logout-connection:${connection.id}`, () => controller.logoutConnection(connection.id))}>{t("connection.logout")}</Button></article>)}{remoteConnections.length === 0 && <p className="muted">{t("settings.noActiveConnections")}</p>}</section>
    {activeProfile !== undefined && <div className="settings-danger-zone"><div><strong>{t("connection.logout")}</strong><p>{t("settings.localLogoutHelp")}</p></div><Button tone="danger" onClick={() => runAction(`logout-current:${activeProfile.id}`, () => logoutCurrentClient(controller, activeProfile.id))}>{t("connection.logout")}</Button></div>}
  </>;
}

export async function logoutCurrentClient(
  controller: Pick<AppController, "logoutProfile">,
  connectionId: string
): Promise<void> {
  await controller.logoutProfile(connectionId);
}

export function activeRemoteConnections(connections: readonly RemoteConnectionView[]): readonly RemoteConnectionView[] {
  return connections.filter((connection) => connection.state === "connected");
}

export function logoutEligibleRemoteConnections(
  connections: readonly RemoteConnectionView[],
  currentConnectionId: string | undefined
): readonly RemoteConnectionView[] {
  return connections.filter((connection) => connection.state === "connected" && connection.id !== currentConnectionId);
}

function BackendSettings({ controller, snapshot, runAction, showHeading = true, t }: { readonly controller: AppController; readonly snapshot: AppSnapshot; readonly runAction: RunAction; readonly showHeading?: boolean; readonly t: Translator }): JSX.Element {
  return <>
    {showHeading && <SettingsHeading title={t("settings.backends")} body={t("settings.backendsBody")} />}
    <section className="settings-card settings-list">{snapshot.backends.map((backend) => {
      const settings = snapshot.settings.backendSettings.find((candidate) => candidate.backendId === backend.id);
      const permissionCapability = backend.capabilities.get("permission.modes");
      const permissionModes = backendPermissionModes(backend, settings?.permissionMode);
      const permissionSupported = advertisedPermissionModes(backend).length > 0;
      const planSupported = planModeSupported(backend);
      const modelSupported = backend.capabilities.get(capabilityNames.modelSwitch)?.supported === true;
      const effortSupported = backend.capabilities.get(capabilityNames.modelEffort)?.supported === true;
      const fastSupported = backend.capabilities.get(capabilityNames.modelFastMode)?.supported === true;
      const backendModels = snapshot.models.filter((model) => model.backendId === backend.id && model.available);
      const selectedModel = settings?.model === undefined ? undefined : backendModels.find((model) =>
        model.providerId === settings.model?.providerId && model.modelId === settings.model.modelId);
      return <article className="backend-setting" key={backend.id}>
        <header className="backend-setting__header">
          <div className="backend-setting__identity"><StatusDot state={backend.health} label={backend.health} /><span><strong>{backend.name}</strong><small>v{backend.version} · {backend.id}</small><small>{backend.installationState ?? "unknown"} · {backend.authenticationState ?? "unknown"}{backend.instanceGeneration === undefined ? "" : ` · g${backend.instanceGeneration}`}</small>{backend.error === undefined ? null : <small className="danger-text">{backend.error}</small>}</span></div>
          <div className="backend-setting__actions"><Pill tone={backend.health === "healthy" ? "success" : backend.health === "degraded" ? "warning" : "danger"}>{backend.health}</Pill><Button onClick={() => runAction(`restart-backend:${backend.id}`, () => controller.restartBackend(backend.id))}>{t("common.restart")}</Button></div>
        </header>
        {settings !== undefined && <div className="backend-setting__controls">
          <div className="backend-setting__permission"><span>{t("settings.backendDefaultModel")}</span><ModelPicker
            models={backendModels}
            ownerId={modelPreferenceOwnerId(controller.state.activeProfile?.serverId)}
            value={selectedModel === undefined ? undefined : {
              backendId: selectedModel.backendId,
              providerId: selectedModel.providerId,
              modelId: selectedModel.modelId,
              ...(settings.model?.effort === undefined ? {} : { effort: settings.model.effort }),
              fastMode: settings.model?.fastMode ?? false
            }}
            allowDefault
            defaultLabel={t("settings.backendNativeDefault")}
            disabled={!modelSupported || backendModels.length === 0}
            disabledReason={!modelSupported ? backend.capabilities.get(capabilityNames.modelSwitch)?.reason : t("common.unavailable")}
            effortEnabled={effortSupported}
            fastEnabled={fastSupported}
            t={t}
            onSelect={(selection) => runAction(`backend-model:${backend.id}`, () => selection === undefined
              ? controller.updateBackendSettings(backend.id, { clearDefaultModel: true })
              : controller.updateBackendSettings(backend.id, {
                defaultModel: {
                  providerId: selection.providerId,
                  modelId: selection.modelId,
                  ...(effortSupported && selection.effort !== undefined ? { effort: selection.effort } : {}),
                  fastMode: fastSupported && selection.fastMode
                }
              }))}
          /></div>
          <label className="backend-setting__permission"><span>{t("settings.defaultPermission")}</span><SelectControl aria-label={t("settings.defaultPermission")} value={settings.permissionMode} disabled={!permissionSupported} title={permissionSupported ? undefined : permissionCapability?.reason} onChange={(event) => runAction(`backend-permission:${backend.id}`, () => controller.updateBackendSettings(backend.id, { permissionMode: event.target.value as typeof settings.permissionMode }))}>{permissionModes.map((mode) => <option key={mode} value={mode}>{permissionModeLabel(mode, t)}</option>)}</SelectControl></label>
          <label className="backend-setting__toggle"><span>{t("settings.planMode")}</span><SwitchControl aria-label={t("settings.planMode")} checked={settings.planMode} disabled={!planSupported} title={planSupported ? undefined : backend.capabilities.get("plan_mode")?.reason} onChange={(event) => runAction(`backend-plan:${backend.id}`, () => controller.updateBackendSettings(backend.id, { planMode: event.target.checked }))} /></label>
          <label className="backend-setting__toggle"><span>{t("common.enabled")}</span><SwitchControl aria-label={t("common.enabled")} checked={settings.enabled} onChange={(event) => runAction(`backend-enabled:${backend.id}`, () => controller.updateBackendSettings(backend.id, { enabled: event.target.checked }))} /></label>
        </div>}
        <details><summary>{t("settings.capabilityCount", { count: backend.capabilities.size })}</summary><ul>{[...backend.capabilities.values()].map((capability) => <li key={capability.name}><span>{capability.name}</span><Pill tone={capability.supported ? "success" : "neutral"}>{capability.supported ? t("common.supported") : capability.reason ?? t("common.unavailable")}</Pill></li>)}</ul></details>
      </article>;
    })}{snapshot.backends.length === 0 && <p className="muted">{t("settings.noBackends")}</p>}</section>
  </>;
}

export function backendPermissionModes(backend: BackendView, current: PermissionMode | undefined): readonly PermissionMode[] {
  const advertised = advertisedPermissionModes(backend);
  if (current === undefined || advertised.includes(current)) return advertised;
  return [current, ...advertised];
}

function permissionModeLabel(mode: PermissionMode, t: Translator): string {
  if (mode === "ask") return t("permission.ask");
  if (mode === "auto") return t("permission.auto");
  return t("permission.full");
}

export function ProviderSettings({ controller, snapshot, runAction, onSuccess, initialView, t }: { readonly controller: AppController; readonly snapshot: AppSnapshot; readonly runAction: RunAction; readonly onSuccess?: (text: string) => void; readonly initialView?: "credentials"; readonly t: Translator }): JSX.Element {
  const [editor, setEditor] = useState<ProviderConfigurationView | "new">();
  const [addWizardOpen, setAddWizardOpen] = useState(false);
  const [runtimeOnboardingId, setRuntimeOnboardingId] = useState<string>();
  const [loginTarget, setLoginTarget] = useState<ProviderSettingsEntry>();
  const [loginFromAddWizard, setLoginFromAddWizard] = useState(false);
  const [pendingProviderSelection, setPendingProviderSelection] = useState<string>();
  const [providerRemovalTarget, setProviderRemovalTarget] = useState<{
    readonly entry: ProviderSettingsEntry;
    readonly kind: "configuration" | "authorization";
  }>();
  const [credentialEditorOpen, setCredentialEditorOpen] = useState(false);
  const [priceModel, setPriceModel] = useState<ModelView>();
  const [modelQuery, setModelQuery] = useState("");
  const [selectedItem, setSelectedItem] = useState(() => {
    const catalog = providerSettingsEntries(snapshot);
    const first = catalog.configured[0];
    if (initialView === "credentials") return "credentials";
    return first === undefined ? "" : `provider:${first.id}`;
  });
  const [compactProviderView, setCompactProviderView] = useState(() => settingsViewportIsCompact());
  const [mobileDetailOpen, setMobileDetailOpen] = useState(() => settingsViewportIsCompact() && initialView === "credentials");
  const [refreshingProviderKey, setRefreshingProviderKey] = useState<string>();
  const [modelRefreshFeedback, setModelRefreshFeedback] = useState<{
    readonly providerKey: string;
    readonly state: "success" | "error";
  }>();
  const autoRefreshRequestedRef = useRef(false);
  const accountUsageRefreshRequestedRef = useRef(new Set<string>());
  const observedProviderIdsRef = useRef<{ readonly ownerId: string | undefined; readonly ids: Set<string> }>({ ownerId: undefined, ids: new Set() });
  const providers = snapshot.settings.providers;
  const providerCatalog = useMemo(() => providerSettingsEntries(snapshot), [snapshot]);
  const configuredProviders = providerCatalog.configured;
  const availableProviders = providerCatalog.available;
  const detectedProviders = providerCatalog.detected;
  const availableModelRuntimes = useMemo(
    () => snapshot.managedModelRuntimes ?? [],
    [snapshot.managedModelRuntimes]
  );
  const pickerOwnerId = modelPreferenceOwnerId(controller.state.activeProfile?.serverId);
  const pickerPreferences = useModelPickerOwnerPreferences(pickerOwnerId);
  const providerOrderingAvailable = configuredProviders.every((entry) => entry.runtime !== undefined);
  const orderedProviders = useMemo(
    () => providerOrderingAvailable
      ? orderProviderSettingsEntries(configuredProviders, pickerPreferences.providerOrder)
      : [...configuredProviders],
    [configuredProviders, pickerPreferences.providerOrder, providerOrderingAvailable]
  );
  const selectedProviderId = selectedItem.startsWith("provider:") ? selectedItem.slice("provider:".length) : undefined;
  const selectedProviderEntry = configuredProviders.find((entry) => entry.id === selectedProviderId);
  const loginApiKeyAlternative = loginTarget === undefined
    ? undefined
    : providerApiKeyAlternative(snapshot, availableProviders, loginTarget);
  const selectedProvider = selectedProviderEntry?.provider;
  const effectiveSelectedItem = selectedItem === "credentials"
      || selectedProviderEntry !== undefined
      || (selectedProviderId !== undefined && selectedProviderId === pendingProviderSelection)
    ? selectedItem
    : orderedProviders[0] === undefined ? "" : `provider:${orderedProviders[0].id}`;
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 720px)");
    const sync = (): void => setCompactProviderView(media.matches);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (effectiveSelectedItem !== selectedItem) setSelectedItem(effectiveSelectedItem);
  }, [effectiveSelectedItem, selectedItem]);
  useEffect(() => {
    if (pendingProviderSelection !== undefined
      && configuredProviders.some((entry) => entry.id === pendingProviderSelection)) {
      setPendingProviderSelection(undefined);
    }
  }, [configuredProviders, pendingProviderSelection]);
  const selectProviderItem = (value: string, awaitProjection = false): void => {
    setPendingProviderSelection(awaitProjection && value.startsWith("provider:")
      ? value.slice("provider:".length)
      : undefined);
    setSelectedItem(value);
    if (compactProviderView) setMobileDetailOpen(true);
    const hash = value === "credentials" ? "#/settings/providers/credentials" : "#/settings/providers";
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  };
  const closeMobileProviderDetail = (): void => {
    setMobileDetailOpen(false);
    const hash = "#/settings/providers";
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  };
  useEffect(() => {
    if (observedProviderIdsRef.current.ownerId !== pickerOwnerId) {
      observedProviderIdsRef.current = { ownerId: pickerOwnerId, ids: new Set() };
    }
    if (pickerOwnerId === undefined || !providerOrderingAvailable) return;
    const observed = observedProviderIdsRef.current.ids;
    const persisted = new Set(pickerPreferences.providerOrder);
    const unrecorded = configuredProviders
      .map((entry) => entry.id)
      .filter((id) => !observed.has(id) && !persisted.has(id));
    for (const entry of configuredProviders) observed.add(entry.id);
    for (const id of unrecorded) setProviderDisplayOrder(pickerOwnerId, [id]);
  }, [configuredProviders, pickerOwnerId, pickerPreferences.providerOrder, providerOrderingAvailable]);
  useEffect(() => {
    if (autoRefreshRequestedRef.current) return;
    autoRefreshRequestedRef.current = true;
    const backendIds = new Set(snapshot.providers.filter((provider) => provider.ownerManaged).map((provider) => provider.backendId));
    void Promise.all([...backendIds].map((backendId) =>
      controller.refreshProviderModels(backendId, undefined, true))).catch(() => undefined);
  }, [controller, snapshot.providers]);
  useEffect(() => {
    const requested = accountUsageRefreshRequestedRef.current;
    const activeProviderIds = new Set(snapshot.providers.map((provider) => providerPreferenceKey(provider.backendId, provider.id)));
    for (const providerKey of requested) if (!activeProviderIds.has(providerKey)) requested.delete(providerKey);
    for (const runtime of snapshot.providers) {
      const providerKey = providerPreferenceKey(runtime.backendId, runtime.id);
      const eligible = runtime.authenticationState === "authenticated"
        && runtime.capabilities.has(capabilityNames.providerAccountUsage);
      if (!eligible) {
        requested.delete(providerKey);
        continue;
      }
      if (requested.has(providerKey)) continue;
      requested.add(providerKey);
      void controller.refreshProviderAccountUsage(runtime.backendId, runtime.id).catch(() => requested.delete(providerKey));
    }
  }, [controller, snapshot.providers]);
  const refreshModels = useCallback(async (entry: ProviderSettingsEntry): Promise<void> => {
    if (refreshingProviderKey !== undefined) return;
    setRefreshingProviderKey(entry.id);
    setModelRefreshFeedback(undefined);
    try {
      const runtime = entry.runtime;
      if (runtime === undefined) throw new Error("Provider Backend ownership is unavailable.");
      await controller.refreshProviderModels(runtime.backendId, entry.provider.id, false);
      setModelRefreshFeedback({ providerKey: entry.id, state: "success" });
    } catch {
      setModelRefreshFeedback({ providerKey: entry.id, state: "error" });
    } finally {
      setRefreshingProviderKey(undefined);
    }
  }, [controller, refreshingProviderKey]);
  const providerRuntime = selectedProviderEntry?.runtime;
  const relatedProviderRuntimes = selectedProvider === undefined || providerRuntime === undefined
    ? []
    : snapshot.providers.filter((runtime) => providerRuntimesRelated(providerRuntime, runtime));
  const relatedProviderRouteKeys = new Set(relatedProviderRuntimes.map((runtime) => providerPreferenceKey(runtime.backendId, runtime.id)));
  const providerModelRoutes = selectedProvider === undefined ? [] : snapshot.models.filter((model) =>
    relatedProviderRouteKeys.has(providerPreferenceKey(model.backendId, model.providerId)));
  const credentialSurfaceModels = providerRuntime === undefined ? [] : providerCredentialSurfaceModels(snapshot, providerRuntime);
  const providerModels = uniqueModelsByRoute([...providerModelRoutes, ...credentialSurfaceModels]);
  const logicalProviderModelIds = new Set(providerModels.map(providerModelLogicalId));
  const selectedImageCredentialSurfaces = providerRuntime?.credentialSurfaces.filter((surface) =>
    surface.capability === "imageGeneration") ?? [];
  const filteredProviderModels = providerModels.filter((model) => {
    const query = modelQuery.trim().toLocaleLowerCase();
    return query.length === 0 || model.name.toLocaleLowerCase().includes(query) || model.modelId.toLocaleLowerCase().includes(query);
  });
  const selectedProviderEnabled = selectedProviderEntry === undefined
    ? false
    : providerSettingsEntryEnabled(snapshot, selectedProviderEntry);
  const logicalProviderModelCount = logicalProviderModelIds.size;
  const disabledProviderModelRoutes = relatedProviderRuntimes.flatMap((runtime) => {
    const access = snapshot.settings.backendSettings.find((settings) => settings.backendId === runtime.backendId)?.modelAccess;
    return (access?.disabledModels ?? [])
      .filter((model) => model.providerId === runtime.id)
      .map((model) => ({ backendId: runtime.backendId, providerId: model.providerId, modelId: model.modelId }));
  });
  const setSelectedProviderEnabled = async (enabled: boolean): Promise<void> => {
    if (selectedProviderEntry === undefined) return;
    const runtimes = relatedProviderRuntimes.length > 0
      ? relatedProviderRuntimes
      : selectedProviderEntry.runtime === undefined ? [] : [selectedProviderEntry.runtime];
    if (enabled && providerConfigurationEditable(selectedProviderEntry.provider) && !selectedProviderEntry.provider.enabled) {
      await controller.saveProvider({ ...providerDraft(selectedProviderEntry.provider), enabled: true });
    }
    if (runtimes.length > 0) {
      await Promise.all(runtimes.map((runtime) => controller.updateBackendSettings(runtime.backendId, {
        modelAccessUpdate: { providerId: runtime.id, enabled }
      })));
      return;
    }
    if (providerConfigurationEditable(selectedProviderEntry.provider)) {
      await controller.saveProvider({ ...providerDraft(selectedProviderEntry.provider), enabled });
    }
  };
  const priceVariants = useMemo<readonly ModelPriceVariant[]>(() => {
    if (priceModel === undefined) return [];
    const backendNames = new Map(snapshot.backends.map((backend) => [backend.id, backend.name] as const));
    const displayedRouteKeys = new Set(providerModels.map((model) => providerPreferenceKey(model.backendId, model.providerId)));
    const matches = snapshot.models.filter((candidate) => displayedRouteKeys.has(providerPreferenceKey(candidate.backendId, candidate.providerId))
      && (candidate.modelId === priceModel.modelId || candidate.name === priceModel.name));
    return matches.map((candidate) => ({
      model: candidate,
      label: backendNames.get(candidate.backendId) ?? candidate.backendId
    }));
  }, [priceModel, selectedProviderEntry?.id, snapshot.backends, snapshot.models, snapshot.providers]);
  const authState = providerRuntime?.authenticationState ?? (selectedProvider?.keyless ? "notRequired" : "unknown");
  return <div className="provider-settings-page">
    <SettingsHeading title={t("settings.providers")} body={t("settings.providersBody")} />
    <section className={cx("provider-workbench", mobileDetailOpen && "provider-workbench--mobile-detail")}>
      <aside className="provider-master" aria-label={t("settings.providers")}>
        <div className="provider-master__list">
          {orderedProviders.length > 1 && <p className="provider-master__hint">{t("settings.providerOrderHint")}</p>}
          {orderedProviders.length > 0 && <ProviderOrderList
            items={orderedProviders}
            disabled={pickerOwnerId === undefined || orderedProviders.length < 2 || orderedProviders.some((entry) => entry.runtime === undefined)}
            labels={{
              list: t("settings.providerOrder"),
              reorder: (name) => t("settings.providerOrderReorder", { name }),
              moved: (name, position, total) => t("settings.providerOrderMoved", { name, position, total }),
              changed: t("settings.providerOrderChanged")
            }}
            onReorder={(ids) => setProviderDisplayOrder(pickerOwnerId, providerIdsForSettingsOrder(orderedProviders, ids))}
            renderItem={(entry) => {
              const provider = entry.provider;
              const runtime = entry.runtime;
              const state = runtime?.authenticationState ?? (provider.keyless ? "notRequired" : "unknown");
              const enabled = providerSettingsEntryEnabled(snapshot, entry);
              return <button type="button" className={cx("provider-master-row", selectedProviderEntry?.id === entry.id && "is-active", !enabled && "is-disabled")} aria-current={selectedProviderEntry?.id === entry.id ? "true" : undefined} onClick={() => selectProviderItem(`provider:${entry.id}`)}>
                <span className="provider-master-row__icon" aria-hidden="true"><ProviderMark providerId={provider.id} name={provider.name} /></span>
                <span className="provider-master-row__copy"><strong>{provider.name}</strong><small>{enabled ? providerModelCountLabel(providerSettingsModelCount(snapshot, entry), t) : t("settings.providerDisabled")}</small></span>
                <span className={cx("provider-master-row__state", providerStatusTone(state, enabled) === "healthy" && "is-ready")} aria-label={t(`providerAuth.${state}`)} />
              </button>;
            }}
          />}
          {detectedProviders.length > 0 && <p className="provider-master__group-label">{t("settings.detectedCli")}</p>}
          {detectedProviders.map((entry) => <button
            type="button"
            className="provider-master-row"
            key={`detected:${entry.id}`}
            onClick={() => {
              if (entry.runtime?.supportsLogin === true && entry.runtime.loginMethods.length > 0) {
                setLoginFromAddWizard(true);
                setLoginTarget(entry);
              }
            }}
          ><span className="provider-master-row__icon" aria-hidden="true"><ProviderMark providerId={entry.provider.id} name={entry.provider.name} /></span><span className="provider-master-row__copy"><strong>{entry.provider.name}</strong></span><span className="provider-master-row__action">{t("settings.authorizeProvider")}</span></button>)}
          {(snapshot.settings.credentials.length > 0 || selectedItem === "credentials") && <>
            <p className="provider-master__group-label">{t("settings.credentials")}</p>
            <button type="button" className={cx("provider-master-row", selectedItem === "credentials" && "is-active")} aria-current={selectedItem === "credentials" ? "true" : undefined} onClick={() => selectProviderItem("credentials")}><span className="provider-master-row__icon"><KeyRound aria-hidden="true" /></span><span><strong>{t("settings.credentials")}</strong><small>{t("settings.credentialCount", { count: snapshot.settings.credentials.length })}</small></span><ChevronRight aria-hidden="true" /></button>
          </>}
          {orderedProviders.length === 0 && detectedProviders.length === 0 && <p className="provider-master__empty">{t("settings.noProviders")}</p>}
        </div>
        {orderedProviders.length > 0 && pickerOwnerId === undefined && <p className="provider-master__warning" role="status">{t("settings.providerOrderUnavailable")}</p>}
        <div className="provider-master__footer"><Button onClick={() => setAddWizardOpen(true)}><CirclePlus aria-hidden="true" />{t("settings.addProvider")}</Button></div>
      </aside>
      <div className="provider-detail">
        <button type="button" className="provider-detail__mobile-back" onClick={closeMobileProviderDetail}><ArrowLeft aria-hidden="true" />{t("settings.providersBack")}</button>
        {selectedItem === "credentials" ? <CredentialVaultPanel controller={controller} snapshot={snapshot} runAction={runAction} onAdd={() => setCredentialEditorOpen(true)} t={t} /> : selectedProvider !== undefined ? <>
          <header className={cx("provider-detail__header", selectedImageCredentialSurfaces.length > 0 && "has-detail")}>
            <div className="provider-detail__top-row">
              <div className="provider-detail__identity"><span className="provider-detail__icon" aria-hidden="true"><ProviderMark providerId={selectedProvider.id} name={selectedProvider.name} /></span><span><span className="provider-detail__title"><strong>{selectedProvider.name}</strong><Pill className="provider-detail__model-count">{providerModelCountLabel(logicalProviderModelCount, t)}</Pill>{providerRuntime?.kind === "subscription" && <Pill className="provider-detail__tag">{t("settings.providerSubscription", { product: providerRuntime.accessProduct ?? selectedProvider.name })}</Pill>}{!selectedProviderEnabled && <Pill className="provider-detail__tag">{t("settings.providerDisabled")}</Pill>}{providerConfigurationEditable(selectedProvider) && <Pill className="provider-detail__tag">{t("settings.customEndpoint")}</Pill>}</span><small>{providerDetailSubtitle(selectedProviderEntry!, t)}</small></span></div>
              <div className="provider-detail__actions">
                {providerRuntime?.supportsLogin === true && providerRuntime.loginMethods.length > 0 && authState !== "authenticated" && <Button tone="primary" onClick={() => { setLoginFromAddWizard(false); setLoginTarget(selectedProviderEntry!); }}>{t("providerLogin.signIn")}</Button>}
                {authState === "authenticated" && <Pill tone="success"><Check aria-hidden="true" />{t("settings.providerConnected")}</Pill>}
                {nativeProviderAuthorizationRemovable(selectedProvider, providerRuntime) && <Button aria-label={`${t("settings.removeProviderAuthorization")} ${selectedProvider.name}`} onClick={() => setProviderRemovalTarget({ entry: selectedProviderEntry!, kind: "authorization" })}>{t("settings.providerDisconnect")}</Button>}
                <ProviderDetailMenu
                  providerName={selectedProvider.name}
                  runtime={providerRuntime}
                  locale={controller.state.preferences.locale}
                  onRefresh={providerRuntime?.supportsRefresh === true ? () => runAction(`refresh-provider:${selectedProvider.id}`, () => controller.refreshProviderCredential(providerRuntime.backendId, selectedProvider.id)) : undefined}
                  onEdit={providerConfigurationEditable(selectedProvider) ? () => setEditor(selectedProvider) : undefined}
                  onDelete={providerConfigurationEditable(selectedProvider) ? () => setProviderRemovalTarget({ entry: selectedProviderEntry!, kind: "configuration" }) : undefined}
                  enabled={selectedProviderEnabled}
                  onSetEnabled={(enabled) => runAction(`${enabled ? "enable" : "disable"}-provider:${selectedProviderEntry!.id}`, () => setSelectedProviderEnabled(enabled))}
                  t={t}
                />
              </div>
            </div>
            {providerRuntime !== undefined && selectedImageCredentialSurfaces.map((surface) => <ProviderImageApiKeyRow
              key={surface.id}
              controller={controller}
              runtime={providerRuntime}
              surface={surface}
              runAction={runAction}
              onSuccess={onSuccess}
              t={t}
            />)}
          </header>
          {!selectedProviderEnabled && <div className="provider-detail__banner"><span>{t("settings.providerDisabledBody")}</span><Button onClick={() => runAction(`enable-provider:${selectedProviderEntry!.id}`, () => setSelectedProviderEnabled(true))}>{t("settings.providerEnableAction")}</Button></div>}
          {selectedProviderEnabled && providerRuntime?.error !== undefined && <div className="provider-detail__banner provider-detail__banner--error" role="alert"><span>{providerRuntime.error}</span>{providerRuntime.supportsModelRefresh === true && <Button disabled={refreshingProviderKey !== undefined} onClick={() => void refreshModels(selectedProviderEntry!)}>{t("common.retry")}</Button>}</div>}
          {selectedProviderEnabled && <div className="provider-detail__scroll">
            <section className="provider-detail-section provider-models" aria-label={t("settings.modelCatalog")}>
              {(refreshingProviderKey === selectedProviderEntry!.id || modelRefreshFeedback?.providerKey === selectedProviderEntry!.id) && <div className={cx("provider-model-feedback", modelRefreshFeedback?.state === "error" && "danger-text")} role={modelRefreshFeedback?.state === "error" ? "alert" : "status"}>{refreshingProviderKey === selectedProviderEntry!.id ? t("settings.refreshingModels") : modelRefreshFeedback?.state === "success" ? t("settings.modelsRefreshed") : t("settings.modelsRefreshFailed")}</div>}
              <ProviderModelCatalog
                models={providerModels}
                filteredModels={filteredProviderModels}
                disabledAccessRoutes={disabledProviderModelRoutes}
                runtimes={relatedProviderRuntimes}
                backends={snapshot.backends}
                query={modelQuery}
                onQueryChange={setModelQuery}
                pickerOwnerId={pickerOwnerId}
                pickerPreferences={pickerPreferences}
                refreshing={refreshingProviderKey !== undefined}
                refreshActive={refreshingProviderKey === selectedProviderEntry!.id}
                onRefresh={providerRuntime?.supportsModelRefresh === true ? () => void refreshModels(selectedProviderEntry!) : undefined}
                onEditPrice={setPriceModel}
                onSetModelEnabled={(routes, enabled) => runAction(`${enabled ? "enable" : "disable"}-model:${routes.map((route) => `${route.backendId}:${route.providerId}:${route.modelId}`).join(",")}`, () => Promise.all(routes.map((route) => controller.updateBackendSettings(route.backendId, { modelAccessUpdate: { providerId: route.providerId, modelId: route.modelId, enabled } }))).then(() => undefined))}
                t={t}
              />
            </section>
          </div>}
        </> : <div className="provider-detail-empty provider-detail-empty--page"><Server aria-hidden="true" /><strong>{t("settings.noProviders")}</strong><span>{t("settings.providerEmptyBody")}</span><Button tone="primary" onClick={() => setAddWizardOpen(true)}>{t("settings.addProvider")}</Button></div>}
      </div>
    </section>
    <ProviderAddWizard open={addWizardOpen} providers={availableProviders} runtimes={availableModelRuntimes} t={t} onClose={() => setAddWizardOpen(false)} onChoose={(entry) => { setAddWizardOpen(false); selectProviderItem(`provider:${entry.id}`); setLoginFromAddWizard(true); setLoginTarget(entry); }} onChooseRuntime={(runtimeId) => { setAddWizardOpen(false); setRuntimeOnboardingId(runtimeId); }} onCustom={() => { setAddWizardOpen(false); setEditor("new"); }} />
    <ProviderEditor open={editor !== undefined} provider={editor === "new" ? undefined : editor} initialKind="customEndpoint" credentials={snapshot.settings.credentials} providerIds={providers.map((item) => item.id)} runtimeNames={snapshot.backends.filter((backend) => backend.capabilities.get(capabilityNames.modelList)?.supported === true).map((backend) => backend.name)} t={t} onClose={() => setEditor(undefined)} onBack={editor === "new" ? () => { setEditor(undefined); setAddWizardOpen(true); } : undefined} onSave={(submission) => { setEditor(undefined); runAction(`save-provider:${submission.provider.id}`, async () => { if (submission.credential !== undefined) await controller.saveCredential(submission.credential); await controller.saveProvider(submission.provider); }); }} />
    <Modal
      open={runtimeOnboardingId !== undefined}
      title={t("settings.providerWizard.titleWith", { name: snapshot.managedModelRuntimes?.find((runtime) => runtime.id === runtimeOnboardingId)?.name ?? t("settings.localModelRuntime") })}
      size="large"
      className="provider-flow-modal provider-runtime-modal"
      onClose={() => setRuntimeOnboardingId(undefined)}
      headerLeading={<ProviderFlowBackButton onBack={() => { setRuntimeOnboardingId(undefined); setAddWizardOpen(true); }} t={t} />}
      headerTrailing={<ProviderWizardProgress activeStep={2} t={t} />}
    ><div className="provider-runtime-onboarding">{snapshot.managedModelRuntimes?.find((runtime) => runtime.id === runtimeOnboardingId) !== undefined && <ManagedModelRuntimeSettings controller={controller} runtimes={[snapshot.managedModelRuntimes!.find((runtime) => runtime.id === runtimeOnboardingId)!]} runAction={runAction} />}</div></Modal>
    <Modal open={providerRemovalTarget !== undefined} title={providerRemovalTarget?.kind === "authorization" ? t("settings.removeProviderAuthorizationTitle", { name: providerRemovalTarget.entry.provider.name }) : t("settings.deleteProviderTitle", { name: providerRemovalTarget?.entry.provider.name ?? "" })} description={providerRemovalTarget?.kind === "authorization" ? t("settings.removeProviderAuthorizationBody") : t("settings.deleteProviderBody")} size="small" onClose={() => setProviderRemovalTarget(undefined)} headerLeading={<ModalBackButton label={t("common.back")} onClick={() => setProviderRemovalTarget(undefined)} />}><div className="modal__actions"><Button tone="danger" onClick={() => { const target = providerRemovalTarget; if (target === undefined) return; setProviderRemovalTarget(undefined); if (target.kind === "authorization") { const runtime = target.entry.runtime; if (runtime !== undefined) runAction(`remove-provider-authorization:${target.entry.id}`, () => controller.logoutProvider(runtime.backendId, target.entry.provider.id)); } else runAction(`delete-provider:${target.entry.provider.id}`, () => controller.deleteProvider(target.entry.provider.id)); }}>{providerRemovalTarget?.kind === "authorization" ? t("settings.removeProviderAuthorizationConfirm") : t("common.delete")}</Button></div></Modal>
    <CredentialEditor open={credentialEditorOpen} initialProviderId={selectedProvider?.id} providers={snapshot.settings.providers} t={t} onClose={() => setCredentialEditorOpen(false)} onSave={(draft) => { setCredentialEditorOpen(false); runAction(`save-credential:${draft.id}`, () => controller.saveCredential(draft)); }} />
    <ModelPriceOverrideDialog controller={controller} model={priceModel} variants={priceVariants} t={t} onClose={() => setPriceModel(undefined)} />
    <ProviderLoginDialog
      controller={controller}
      backendId={loginTarget?.runtime?.backendId}
      provider={loginTarget?.provider}
      loginMethods={loginTarget?.runtime?.loginMethods}
      t={t}
      onClose={() => {
        if (loginFromAddWizard) {
          setPendingProviderSelection(undefined);
          setSelectedItem("");
        }
        setLoginTarget(undefined);
        setLoginFromAddWizard(false);
      }}
      onCompleted={({ backendId, providerId }) => {
        selectProviderItem(`provider:${providerPreferenceKey(backendId, providerId)}`, true);
        setLoginTarget(undefined);
        setLoginFromAddWizard(false);
      }}
      onBack={loginFromAddWizard ? () => {
        setPendingProviderSelection(undefined);
        setSelectedItem("");
        setLoginTarget(undefined);
        setLoginFromAddWizard(false);
        setAddWizardOpen(true);
      } : undefined}
      onUseApiKey={loginApiKeyAlternative === undefined ? undefined : () => {
        setLoginFromAddWizard(true);
        setLoginTarget(loginApiKeyAlternative);
      }}
    />
  </div>;
}

interface ProviderSettingsEntry {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderConfigurationView;
  readonly runtime?: ProviderRuntimeView;
  readonly backendName?: string;
}

function ProviderImageApiKeyRow({ controller, runtime, surface, runAction, onSuccess, t }: {
  readonly controller: AppController;
  readonly runtime: ProviderRuntimeView;
  readonly surface: ProviderCredentialSurfaceView;
  readonly runAction: RunAction;
  readonly onSuccess?: (text: string) => void;
  readonly t: Translator;
}): JSX.Element {
  const [draftKey, setDraftKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraftKey("");
    setRevealed(false);
  }, [surface.configured, surface.id]);

  const save = (): void => {
    let secret = draftKey.trim();
    if (secret.length === 0 || busy) return;
    setBusy(true);
    runAction(`save-provider-surface:${runtime.backendId}:${runtime.id}:${surface.id}`, async () => {
      try {
        await controller.saveProviderCredentialSurface(runtime.backendId, runtime.id, surface.id, secret);
        secret = "";
        setDraftKey("");
        onSuccess?.(t("settings.imageApiKeySaved"));
      } finally {
        secret = "";
        setBusy(false);
      }
    });
  };

  const clear = (): void => {
    if (busy) return;
    setBusy(true);
    runAction(`clear-provider-surface:${runtime.backendId}:${runtime.id}:${surface.id}`, async () => {
      try {
        await controller.clearProviderCredentialSurface(runtime.backendId, runtime.id, surface.id);
        onSuccess?.(t("settings.imageApiKeyCleared"));
      } finally {
        setBusy(false);
      }
    });
  };

  return <form className="provider-image-api-key" onSubmit={(event) => { event.preventDefault(); save(); }}>
    <span className="provider-image-api-key__label">{t("settings.imageApiKey")}</span>
    {surface.configured ? <>
      <span className="provider-image-api-key__mask" aria-label={t("settings.imageApiKeyConfigured")}>••••••••</span>
      <Button type="button" disabled={busy} onClick={clear}>{t("settings.imageApiKeyClear")}</Button>
    </> : <>
      <span className="provider-image-api-key__field">
        <input
          type={revealed ? "text" : "password"}
          value={draftKey}
          aria-label={t("settings.imageApiKey")}
          placeholder={t("settings.imageApiKeyPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setDraftKey(event.target.value)}
        />
        <button
          type="button"
          className="provider-image-api-key__reveal"
          aria-label={t(revealed ? "settings.imageApiKeyHide" : "settings.imageApiKeyShow")}
          disabled={busy}
          onClick={() => setRevealed((value) => !value)}
        >{revealed ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}</button>
      </span>
      <Button type="submit" disabled={busy || draftKey.trim().length === 0}>{t("common.save")}</Button>
    </>}
  </form>;
}

export function providerSettingsEntries(snapshot: AppSnapshot): {
  readonly configured: readonly ProviderSettingsEntry[];
  readonly available: readonly ProviderSettingsEntry[];
  readonly detected: readonly ProviderSettingsEntry[];
  readonly supplemental: readonly ProviderSettingsEntry[];
} {
  const backendNames = new Map(snapshot.backends.map((backend) => [backend.id, backend.name] as const));
  const backendInstallations = new Map(snapshot.backends.map((backend) => [backend.id, backend.installationState] as const));
  const entries: ProviderSettingsEntry[] = [];
  for (const provider of snapshot.settings.providers) {
    const runtimes = snapshot.providers.filter((runtime) => runtime.ownerManaged && runtime.id === provider.id);
    if (runtimes.length === 0) {
      entries.push({ id: `settings:${provider.id}`, name: provider.name, provider });
      continue;
    }
    for (const runtime of runtimes) entries.push(providerSettingsEntry(provider, runtime, backendNames.get(runtime.backendId)));
  }
  for (const runtime of snapshot.providers) {
    if (runtime.ownerManaged) continue;
    entries.push(providerSettingsEntry(nativeProviderConfiguration(runtime, snapshot.models), runtime, backendNames.get(runtime.backendId)));
  }
  const primaryEntries = entries;
  const configured = deduplicateConfiguredProviderEntries(primaryEntries.filter(providerSettingsEntryConfigured));
  const unconfigured = primaryEntries.filter((entry) => !providerSettingsEntryConfigured(entry));
  return {
    configured,
    available: primaryEntries.filter((entry) => !providerSettingsEntryConfigured(entry)
      && entry.runtime?.supportsLogin === true
      && entry.runtime.loginMethods.length > 0),
    detected: unconfigured.filter((entry) => {
      const installation = entry.runtime === undefined ? undefined : backendInstallations.get(entry.runtime.backendId);
      return entry.runtime?.ownerManaged === false
        && entry.runtime.supportsLogin
        && entry.runtime.loginMethods.length > 0
        && (installation === "installed" || installation === "updateAvailable");
    }),
    supplemental: []
  };
}

function deduplicateConfiguredProviderEntries(entries: readonly ProviderSettingsEntry[]): ProviderSettingsEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entry.runtime === undefined
      ? entry.id
      : entry.runtime.ownerManaged
        ? `managed\u0000${entry.provider.compatibility}\u0000${entry.runtime.id}`
        : `native\u0000${entry.runtime.backendId}\u0000${entry.runtime.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function providerRuntimesRelated(left: ProviderRuntimeView, right: ProviderRuntimeView): boolean {
  if (left.ownerManaged !== right.ownerManaged) return false;
  if (left.compatibility !== right.compatibility || left.id !== right.id) return false;
  return left.ownerManaged || left.backendId === right.backendId;
}

function providerApiKeyAlternative(
  snapshot: AppSnapshot,
  entries: readonly ProviderSettingsEntry[],
  target: ProviderSettingsEntry
): ProviderSettingsEntry | undefined {
  if (target.provider.kind === "apiKey" || target.runtime?.loginMethods.includes("apiKey") === true) return undefined;
  const candidates = entries.filter((entry) => entry.id !== target.id
    && entry.runtime?.ownerManaged === true
    && entry.runtime.loginMethods.includes("apiKey")
    && entry.provider.id === target.provider.id
    && entry.provider.compatibility === target.provider.compatibility
    && providerSettingsModelRoutes(snapshot, entry).some(isConversationModel));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function providerSettingsModelRoutes(snapshot: AppSnapshot, entry: ProviderSettingsEntry): ModelView[] {
  const runtime = entry.runtime;
  if (runtime === undefined) return [];
  const routeKeys = new Set(snapshot.providers
    .filter((candidate) => providerRuntimesRelated(runtime, candidate))
    .map((candidate) => providerPreferenceKey(candidate.backendId, candidate.id)));
  return snapshot.models.filter((model) => routeKeys.has(providerPreferenceKey(model.backendId, model.providerId)));
}

function providerCredentialSurfaceModels(snapshot: AppSnapshot, runtime: ProviderRuntimeView): ModelView[] {
  const access = snapshot.settings.backendSettings
    .find((settings) => settings.backendId === runtime.backendId)?.modelAccess;
  const providerDisabled = access?.disabledProviderIds.includes(runtime.id) === true;
  const disabledModels = new Set((access?.disabledModels ?? [])
    .filter((model) => model.providerId === runtime.id)
    .map((model) => model.modelId));
  return runtime.credentialSurfaces.flatMap((surface) => surface.models.map((model) => ({
    backendId: runtime.backendId,
    providerId: runtime.id,
    providerName: runtime.name,
    providerAccessKind: runtime.kind,
    pricingKnown: false,
    modelId: model.modelId,
    logicalId: model.modelId,
    name: model.name,
    available: surface.configured,
    routingEnabled: runtime.routingEnabled !== false && !providerDisabled && !disabledModels.has(model.modelId),
    defaultVisible: false,
    supportsImages: false,
    inputModalities: ["text" as const],
    outputModalities: [surface.capability === "imageGeneration" ? "image" as const : "text" as const],
    supportsFast: false,
    efforts: [],
    contextWindow: 0,
    maximumOutputTokens: 0,
    inputCostMicrosPerMillion: 0,
    outputCostMicrosPerMillion: 0,
    currencyCode: "USD"
  })));
}

function uniqueModelsByRoute(models: readonly ModelView[]): ModelView[] {
  return [...new Map(models.map((model) => [modelRouteIdentity(model), model] as const)).values()];
}

function providerSettingsModelCount(
  snapshot: AppSnapshot,
  entry: ProviderSettingsEntry
): number {
  if (entry.runtime === undefined) return entry.provider.models.length;
  return new Set(uniqueModelsByRoute([
    ...providerSettingsModelRoutes(snapshot, entry),
    ...providerCredentialSurfaceModels(snapshot, entry.runtime)
  ]).map(providerModelLogicalId)).size;
}

function providerSettingsEntry(
  provider: ProviderConfigurationView,
  runtime: ProviderRuntimeView,
  backendName?: string
): ProviderSettingsEntry {
  return {
    id: providerPreferenceKey(runtime.backendId, runtime.id),
    name: provider.name,
    provider,
    runtime,
    ...(backendName === undefined ? {} : { backendName })
  };
}

function nativeProviderConfiguration(runtime: ProviderRuntimeView, models: readonly ModelView[]): ProviderConfigurationView {
  return {
    id: runtime.id,
    name: runtime.name,
    kind: runtime.kind,
    compatibility: runtime.compatibility,
    endpoint: runtime.endpoint,
    credentialId: "",
    enabled: true,
    keyless: runtime.authenticationState === "notRequired",
    authHeader: false,
    environmentName: "",
    modelCount: models.filter((model) => model.backendId === runtime.backendId && model.providerId === runtime.id).length,
    headers: [],
    models: []
  };
}

function providerSettingsEntryConfigured(entry: ProviderSettingsEntry): boolean {
  if (entry.runtime?.ownerManaged !== false) return providerConfiguredForSettings(entry.provider, entry.runtime);
  return entry.runtime.credentialSurfaces.length > 0
    || entry.runtime.authenticationState === "notRequired"
    || entry.runtime.authenticationState === "authenticated"
    || nativeProviderAuthorizationRemovable(entry.provider, entry.runtime);
}

function providerSettingsEntryEnabled(snapshot: AppSnapshot, entry: ProviderSettingsEntry): boolean {
  if (!entry.provider.enabled) return false;
  const runtime = entry.runtime;
  if (runtime === undefined) return true;
  const related = snapshot.providers.filter((candidate) => providerRuntimesRelated(runtime, candidate));
  return related.length === 0 ? runtime.routingEnabled !== false : related.every((candidate) => candidate.routingEnabled !== false);
}

function orderProviderSettingsEntries(
  entries: readonly ProviderSettingsEntry[],
  providerOrder: readonly string[]
): ProviderSettingsEntry[] {
  const positions = new Map(providerOrder.map((id, index) => [id, index] as const));
  return entries.map((entry, index) => ({ entry, index })).sort((left, right) => {
    const leftPosition = positions.get(left.entry.id) ?? Number.MAX_SAFE_INTEGER;
    const rightPosition = positions.get(right.entry.id) ?? Number.MAX_SAFE_INTEGER;
    return leftPosition - rightPosition || left.index - right.index;
  }).map(({ entry }) => entry);
}

function providerIdsForSettingsOrder(
  entries: readonly ProviderSettingsEntry[],
  entryIds: readonly string[]
): readonly string[] {
  const available = new Set(entries.map((entry) => entry.id));
  return [...new Set(entryIds.filter((id) => available.has(id)))];
}

function providerDetailSubtitle(entry: ProviderSettingsEntry, t: Translator): string {
  const runtime = entry.runtime;
  const product = runtime?.accessProduct ?? entry.provider.name;
  const runtimeName = entry.backendName ?? t("settings.providerRuntimeGeneric");
  if (runtime?.kind === "subscription") {
    return t("settings.providerSubtitle.subscription", { product, runtime: runtimeName });
  }
  if (runtime?.kind === "apiKey") {
    return t("settings.providerSubtitle.apiKey", { runtime: runtimeName });
  }
  if (runtime?.kind === "oauth") {
    return t("settings.providerSubtitle.oauth", { runtime: runtimeName });
  }
  if (runtime?.kind === "localKeyless") return t("settings.providerSubtitle.local");
  return runtime?.endpoint || entry.provider.endpoint || entry.provider.compatibility;
}

function ProviderDetailMenu({ providerName, runtime, locale, onRefresh, onEdit, onDelete, enabled, onSetEnabled, t }: {
  readonly providerName: string;
  readonly runtime?: ProviderRuntimeView;
  readonly locale: Locale;
  readonly onRefresh?: () => void;
  readonly onEdit?: () => void;
  readonly onDelete?: () => void;
  readonly enabled: boolean;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly t: Translator;
}): JSX.Element | null {
  const hasLocalUsage = runtime?.rateLimit !== undefined || runtime?.usage !== undefined;
  const hasAccountUsage = runtime?.capabilities.has(capabilityNames.providerAccountUsage) === true
    && runtime.accountUsage !== undefined;
  return <details className="provider-overflow-menu">
    <summary aria-label={t("common.more")} title={t("common.more")}><MoreHorizontal aria-hidden="true" /></summary>
    <div>
      {hasLocalUsage && <section className="provider-overflow-menu__account">
        <strong>{t("settings.localRunUsage")}</strong>
        {runtime?.rateLimit !== undefined && <span>{runtime.rateLimit.requestLimit > 0 ? t("settings.rateRemaining", { remaining: runtime.rateLimit.requestsRemaining, limit: runtime.rateLimit.requestLimit }) : t(runtime.rateLimit.limited ? "settings.rateLimited" : "settings.rateAvailable")}</span>}
        {runtime?.usage !== undefined && <span>{t("settings.providerUsage", { tokens: runtime.usage.inputTokens + runtime.usage.outputTokens, cost: runtime.usage.cost.toFixed(4), currency: runtime.usage.currency })}</span>}
      </section>}
      {hasAccountUsage && <section className="provider-overflow-menu__account"><strong>{t("settings.accountUsage")}</strong><ProviderAccountUsageDetails runtime={runtime!} locale={locale} t={t} /></section>}
      {onRefresh !== undefined && <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onRefresh(); }}><RotateCcw aria-hidden="true" />{t("settings.refreshCredential")}</button>}
      {onEdit !== undefined && <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onEdit(); }}><Pencil aria-hidden="true" />{t("common.edit")}</button>}
      <button type="button" className={enabled ? "is-danger" : undefined} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onSetEnabled(!enabled); }}><Power aria-hidden="true" />{enabled ? t("settings.providerDisableAction") : t("settings.providerEnableAction")}</button>
      {onDelete !== undefined && <button type="button" className="is-danger" aria-label={`${t("common.delete")} ${providerName}`} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onDelete(); }}><Trash2 aria-hidden="true" />{t("common.delete")}</button>}
    </div>
  </details>;
}

interface ProviderLogicalModel {
  readonly id: string;
  readonly name: string;
  readonly routes: readonly ModelView[];
  readonly capability: "chat" | "image" | "audio";
}

interface ProviderModelRouteReference {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
}

type ProviderModelGroupId = "chat" | "image" | "audio";
const PROVIDER_MODEL_GROUP_COLLAPSE_STORAGE_KEY = "joko:provider-model-groups:v1";
const DEFAULT_COLLAPSED_PROVIDER_MODEL_GROUPS = new Set<ProviderModelGroupId>(["image", "audio"]);

function ProviderModelCatalog({ models, filteredModels, disabledAccessRoutes, runtimes, backends, query, onQueryChange, pickerOwnerId, pickerPreferences, refreshing, refreshActive, onRefresh, onEditPrice, onSetModelEnabled, t }: {
  readonly models: readonly ModelView[];
  readonly filteredModels: readonly ModelView[];
  readonly disabledAccessRoutes: readonly ProviderModelRouteReference[];
  readonly runtimes: readonly ProviderRuntimeView[];
  readonly backends: readonly BackendView[];
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  readonly pickerOwnerId?: string;
  readonly pickerPreferences: ReturnType<typeof useModelPickerOwnerPreferences>;
  readonly refreshing: boolean;
  readonly refreshActive: boolean;
  readonly onRefresh?: () => void;
  readonly onEditPrice: (model: ModelView) => void;
  readonly onSetModelEnabled: (routes: readonly ProviderModelRouteReference[], enabled: boolean) => void;
  readonly t: Translator;
}): JSX.Element {
  const [split, setSplit] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<ProviderModelGroupId>>(readCollapsedProviderModelGroups);
  const logicalModels = providerLogicalModels(models);
  const matchingRoutes = new Set(filteredModels.map(modelRouteIdentity));
  const filteredLogicalModels = logicalModels.filter((model) => model.routes.some((route) => matchingRoutes.has(modelRouteIdentity(route))));
  const dialogueModels = filteredLogicalModels.filter((model) => model.capability === "chat");
  const enabledModels = dialogueModels.filter((model) => model.routes.every((route) => route.routingEnabled !== false));
  const disabledModels = dialogueModels.filter((model) => model.routes.some((route) => route.routingEnabled === false));
  const capabilityRouteKeys = new Set(logicalModels
    .filter((model) => model.capability !== "chat")
    .flatMap((model) => model.routes.map(modelRouteIdentity)));
  const disabledDialogueAccessRoutes = disabledAccessRoutes.filter((route) => !capabilityRouteKeys.has(modelRouteIdentity(route)));
  const enableAllRoutes = uniqueProviderModelRoutes([
    ...disabledDialogueAccessRoutes,
    ...disabledModels.flatMap((model) => model.routes)
  ]);
  const disabledModelCount = disabledModels.length > 0
    ? disabledModels.length
    : new Set(disabledDialogueAccessRoutes.map((route) => route.modelId)).size;
  const chatModels = enabledModels;
  const imageModels = filteredLogicalModels.filter((model) => model.capability === "image");
  const audioModels = filteredLogicalModels.filter((model) => model.capability === "audio");
  const backendNames = new Map(backends.map((backend) => [backend.id, backend.name] as const));
  const backendIds = [...new Set([
    ...runtimes.map((runtime) => runtime.backendId),
    ...logicalModels.filter((model) => model.capability === "chat").flatMap((model) => model.routes.map((route) => route.backendId))
  ])];
  const splitAvailable = backendIds.length > 1;
  const toggleRoutes = chatModels.flatMap((model) => model.routes.filter((route) => route.routingEnabled !== false && route.available));
  const allVisible = toggleRoutes.length > 0 && toggleRoutes.every((model) => modelVisible(pickerPreferences, model));
  const groupName = runtimes[0]?.name ?? models[0]?.providerName ?? "";
  const showSearch = logicalModels.length > 8;
  const rowProps = { pickerOwnerId, pickerPreferences, onEditPrice, onSetModelEnabled, t };
  const modelGroups = [
    ...(chatModels.length > 0 ? [{ id: "chat" as const, title: groupName, models: chatModels, capability: false }] : []),
    ...(imageModels.length > 0 ? [{ id: "image" as const, title: t("settings.imageModels"), models: imageModels, capability: true }] : []),
    ...(audioModels.length > 0 ? [{ id: "audio" as const, title: t("settings.audioModels"), models: audioModels, capability: true }] : [])
  ];
  const showGroupHeaders = modelGroups.length > 1 || modelGroups.some((group) => group.capability);
  const toggleGroup = (id: ProviderModelGroupId): void => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      writeCollapsedProviderModelGroups(next);
      return next;
    });
  };
  return <>
    <div className="provider-model-toolbar">
      <strong>{t("settings.modelsShownInPicker")}</strong>
      {showSearch && <label className="provider-model-search"><Search aria-hidden="true" /><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={t("settings.searchModels")} aria-label={t("settings.searchModels")} /></label>}
      {onRefresh !== undefined && <IconButton disabled={refreshing} aria-busy={refreshActive} label={`${t("settings.refreshModels")} ${groupName}`} onClick={onRefresh}><RefreshCw className={cx(refreshActive && "is-spinning")} aria-hidden="true" /></IconButton>}
      {splitAvailable && <button type="button" className="provider-model-toolbar__text-action" onClick={() => setSplit((value) => !value)}>{split ? t("settings.adjustTogether") : t("settings.adjustSeparately")}</button>}
      {toggleRoutes.length > 0 && <button type="button" className="provider-model-toolbar__text-action" disabled={pickerOwnerId === undefined} onClick={() => {
        for (const model of toggleRoutes) setModelVisible(pickerOwnerId, model.backendId, model.providerId, model.modelId, !allVisible, model.defaultVisible ?? true);
      }}>{allVisible ? t("settings.hideAllModels") : t("settings.showAllModels")}</button>}
    </div>
    {models.length === 0 && disabledModelCount === 0 ? <div className="provider-detail-empty">{t("settings.noProviderModels")}</div> : filteredLogicalModels.length === 0 && disabledModelCount === 0 ? <div className="provider-detail-empty">{t("settings.noMatchingModels")}</div> : <div className={cx("provider-model-groups", split && "is-split")}>
      {modelGroups.map((group) => {
        const collapsed = showGroupHeaders && query.trim().length === 0 && collapsedGroups.has(group.id);
        return <section className={cx("provider-model-group", group.capability && "provider-model-group--capability")} key={group.id}>
          {showGroupHeaders && <button type="button" className={cx("provider-model-group__heading", collapsed && "is-collapsed")} aria-expanded={!collapsed} onClick={() => toggleGroup(group.id)}>
            <ChevronDown aria-hidden="true" /><strong>{group.title}</strong><span>{group.models.length}</span>
          </button>}
          {group.capability && !collapsed && <p>{t("settings.capabilityModelsBody")}</p>}
          {!collapsed && <>
            {split && group.id === "chat" && <ProviderModelSplitHeader backendIds={backendIds} backendNames={backendNames} />}
            <div className="provider-model-list">{group.models.map((model) => group.id === "chat" && split
              ? <ProviderSplitModelRow key={model.id} model={model} backendIds={backendIds} backendNames={backendNames} {...rowProps} />
              : <ProviderUnifiedModelRow key={model.id} model={model} capability={group.capability} backendIds={backendIds} backendNames={backendNames} onAdjustSeparately={group.id === "chat" ? () => setSplit(true) : undefined} {...rowProps} />)}</div>
          </>}
        </section>;
      })}
      {disabledModelCount > 0 && <details className="provider-model-group provider-model-group--disabled" open>
        <summary><span><strong>{t("settings.disabledModels")}</strong><span>{disabledModelCount}</span></span><Button tone="ghost" onClick={(event) => { event.preventDefault(); onSetModelEnabled(enableAllRoutes, true); }}>{t("settings.enableAllModels")}</Button></summary>
        <div className="provider-model-list">{disabledModels.map((model) => <ProviderDisabledModelRow key={model.id} model={model} groupName={groupName} onSetModelEnabled={onSetModelEnabled} t={t} />)}</div>
      </details>}
    </div>}
  </>;
}

function readCollapsedProviderModelGroups(): ReadonlySet<ProviderModelGroupId> {
  if (typeof window === "undefined") return new Set(DEFAULT_COLLAPSED_PROVIDER_MODEL_GROUPS);
  try {
    const stored = JSON.parse(window.localStorage.getItem(PROVIDER_MODEL_GROUP_COLLAPSE_STORAGE_KEY) ?? "null") as unknown;
    if (!Array.isArray(stored)) return new Set(DEFAULT_COLLAPSED_PROVIDER_MODEL_GROUPS);
    return new Set(stored.filter((value): value is ProviderModelGroupId => value === "chat" || value === "image" || value === "audio"));
  } catch {
    return new Set(DEFAULT_COLLAPSED_PROVIDER_MODEL_GROUPS);
  }
}

function writeCollapsedProviderModelGroups(groups: ReadonlySet<ProviderModelGroupId>): void {
  try {
    window.localStorage.setItem(PROVIDER_MODEL_GROUP_COLLAPSE_STORAGE_KEY, JSON.stringify([...groups]));
  } catch {
    // The current view still owns the collapse state when browser storage is unavailable.
  }
}

function ProviderModelSplitHeader({ backendIds, backendNames }: {
  readonly backendIds: readonly string[];
  readonly backendNames: ReadonlyMap<string, string>;
}): JSX.Element {
  return <div className="provider-model-split-header" style={providerModelSplitStyle(backendIds.length)}><span />{backendIds.map((backendId) => <span key={backendId}>{backendNames.get(backendId) ?? backendId}</span>)}<span /></div>;
}

function ProviderUnifiedModelRow({ model, capability = false, pickerOwnerId, pickerPreferences, backendIds, backendNames, onAdjustSeparately, onEditPrice, onSetModelEnabled, t }: {
  readonly model: ProviderLogicalModel;
  readonly capability?: boolean;
  readonly pickerOwnerId?: string;
  readonly pickerPreferences: ReturnType<typeof useModelPickerOwnerPreferences>;
  readonly backendIds?: readonly string[];
  readonly backendNames?: ReadonlyMap<string, string>;
  readonly onAdjustSeparately?: () => void;
  readonly onEditPrice: (model: ModelView) => void;
  readonly onSetModelEnabled: (routes: readonly ProviderModelRouteReference[], enabled: boolean) => void;
  readonly t: Translator;
}): JSX.Element {
  const activeRoutes = model.routes.filter((route) => route.routingEnabled !== false && route.available);
  const visibleValues = activeRoutes.map((route) => modelVisible(pickerPreferences, route));
  const visible = visibleValues.some(Boolean);
  const differs = visible && visibleValues.some((value) => !value);
  const hiddenRuntimeNames = activeRoutes
    .filter((route) => !modelVisible(pickerPreferences, route))
    .map((route) => backendNames?.get(route.backendId) ?? route.backendId);
  const divergenceLabel = hiddenRuntimeNames.length === 0
    ? ""
    : t("settings.visibilityDiffers", { agents: hiddenRuntimeNames.join(" / ") });
  const unsupportedRuntimeNames = (backendIds ?? [])
    .filter((backendId) => !model.routes.some((route) => route.backendId === backendId && route.available))
    .map((backendId) => backendNames?.get(backendId) ?? backendId);
  const maximumContext = Math.max(0, ...model.routes.map((route) => route.contextWindow));
  const enabled = model.routes.every((route) => route.routingEnabled !== false);
  return <article className={cx("provider-model-row", !visible && !capability && "is-picker-hidden", capability && !enabled && "is-disabled", differs && "has-divergence")}>
    <span className="provider-model-row__name"><strong>{model.name}</strong>{!capability && unsupportedRuntimeNames.length > 0 && <small>{t("settings.modelUnsupportedBy", { agents: unsupportedRuntimeNames.join(" / ") })}</small>}</span>
    {differs && onAdjustSeparately !== undefined && <button type="button" className="provider-model-row__divergence" title={divergenceLabel} onClick={onAdjustSeparately}>{divergenceLabel}</button>}
    <span className="provider-model-row__context">{maximumContext <= 0 ? "" : formatCompactTokenCount(maximumContext)}</span>
    <ProviderModelMenu model={model} enabled={enabled} onEditPrice={capability ? undefined : onEditPrice} onSetModelEnabled={onSetModelEnabled} t={t} />
    {!capability && activeRoutes.length === 0 && <span className="provider-model-route-empty">—</span>}
    {!capability && activeRoutes.length > 0 && <Tip className="provider-model-row__toggle-tip" focusable={pickerOwnerId === undefined} text={pickerOwnerId === undefined ? t("settings.modelVisibilityBody") : undefined}><button type="button" role="switch" className="model-visibility-toggle" aria-checked={visible} aria-pressed={visible} aria-label={visible ? t("settings.hideModel", { name: model.name }) : t("settings.showModel", { name: model.name })} disabled={pickerOwnerId === undefined} onClick={() => {
      for (const route of activeRoutes) setModelVisible(pickerOwnerId, route.backendId, route.providerId, route.modelId, !visible, route.defaultVisible ?? true);
    }}><span /></button></Tip>}
  </article>;
}

function ProviderDisabledModelRow({ model, groupName, onSetModelEnabled, t }: {
  readonly model: ProviderLogicalModel;
  readonly groupName: string;
  readonly onSetModelEnabled: (routes: readonly ProviderModelRouteReference[], enabled: boolean) => void;
  readonly t: Translator;
}): JSX.Element {
  const maximumContext = Math.max(0, ...model.routes.map((route) => route.contextWindow));
  const category = model.capability === "image"
    ? t("settings.imageModels")
    : model.capability === "audio" ? t("settings.audioModels") : groupName.toLocaleUpperCase();
  return <article className="provider-model-row is-disabled">
    <span className="provider-model-row__name"><strong>{model.name}</strong></span>
    <span className="provider-model-row__category">{category}</span>
    <span className="provider-model-row__context">{maximumContext <= 0 ? "" : formatCompactTokenCount(maximumContext)}</span>
    <button type="button" className="provider-model-row__enable" onClick={() => onSetModelEnabled(model.routes, true)}>{t("settings.enableModel")}</button>
  </article>;
}

function ProviderSplitModelRow({ model, backendIds, backendNames, pickerOwnerId, pickerPreferences, onEditPrice, onSetModelEnabled, t }: {
  readonly model: ProviderLogicalModel;
  readonly backendIds: readonly string[];
  readonly backendNames: ReadonlyMap<string, string>;
  readonly pickerOwnerId?: string;
  readonly pickerPreferences: ReturnType<typeof useModelPickerOwnerPreferences>;
  readonly onEditPrice?: (model: ModelView) => void;
  readonly onSetModelEnabled: (routes: readonly ProviderModelRouteReference[], enabled: boolean) => void;
  readonly t: Translator;
}): JSX.Element {
  return <article className="provider-model-row provider-model-row--split" style={providerModelSplitStyle(backendIds.length)}>
    <span className="provider-model-row__name"><strong>{model.name}</strong></span>
    {backendIds.map((backendId) => {
      const route = model.routes.find((candidate) => candidate.backendId === backendId && candidate.routingEnabled !== false && candidate.available);
      if (route === undefined) return <span className="provider-model-route-empty" key={backendId}>—</span>;
      const visible = modelVisible(pickerPreferences, route);
      const runtimeName = backendNames.get(backendId) ?? backendId;
      return <button key={backendId} type="button" role="switch" className="model-visibility-toggle" aria-checked={visible} aria-pressed={visible} aria-label={visible ? t("settings.hideModel", { name: `${model.name} · ${runtimeName}` }) : t("settings.showModel", { name: `${model.name} · ${runtimeName}` })} disabled={pickerOwnerId === undefined} onClick={() => setModelVisible(pickerOwnerId, route.backendId, route.providerId, route.modelId, !visible, route.defaultVisible ?? true)}><span /></button>;
    })}
    <ProviderModelMenu model={model} enabled onEditPrice={onEditPrice} onSetModelEnabled={onSetModelEnabled} t={t} />
  </article>;
}

function ProviderModelMenu({ model, enabled, onEditPrice, onSetModelEnabled, t }: {
  readonly model: ProviderLogicalModel;
  readonly enabled: boolean;
  readonly onEditPrice?: (model: ModelView) => void;
  readonly onSetModelEnabled: (routes: readonly ProviderModelRouteReference[], enabled: boolean) => void;
  readonly t: Translator;
}): JSX.Element {
  return <details className="provider-model-row__menu"><summary aria-label={t("common.more")} title={t("common.more")}><MoreHorizontal aria-hidden="true" /></summary><div>
    {onEditPrice !== undefined && <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onEditPrice(model.routes[0]!); }}>{t("settings.modelPrice.menu")}</button>}
    <button type="button" className={enabled ? "is-danger" : undefined} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onSetModelEnabled(model.routes, !enabled); }}>{enabled ? t("settings.disableModel") : t("settings.enableModel")}</button>
  </div></details>;
}

function providerLogicalModels(models: readonly ModelView[]): ProviderLogicalModel[] {
  const groups = new Map<string, ModelView[]>();
  for (const model of models) {
    const key = providerModelLogicalId(model);
    const current = groups.get(key) ?? [];
    current.push(model);
    groups.set(key, current);
  }
  return [...groups.entries()].map(([id, routes]) => {
    const outputModalities = new Set(routes.flatMap((route) => route.outputModalities));
    const capability: ProviderLogicalModel["capability"] = outputModalities.has("text")
      ? "chat"
      : outputModalities.has("image") ? "image"
        : outputModalities.has("audio") ? "audio" : "chat";
    return { id, name: routes[0]?.name ?? id, routes, capability };
  });
}

function providerModelLogicalId(model: ModelView): string {
  return model.logicalId?.trim() || model.modelId;
}

function modelVisible(
  preferences: ReturnType<typeof useModelPickerOwnerPreferences>,
  model: ModelView
): boolean {
  return isModelVisible(preferences, model.backendId, model.providerId, model.modelId, model.defaultVisible ?? true);
}

function modelRouteIdentity(model: ProviderModelRouteReference): string {
  return `${model.backendId}\u0000${model.providerId}\u0000${model.modelId}`;
}

function uniqueProviderModelRoutes(routes: readonly ProviderModelRouteReference[]): ProviderModelRouteReference[] {
  return [...new Map(routes.map((route) => [modelRouteIdentity(route), route] as const)).values()];
}

function providerModelSplitStyle(columnCount: number): CSSProperties {
  return { gridTemplateColumns: `minmax(0, 1fr) repeat(${columnCount}, minmax(56px, 80px)) 32px` };
}

function providerModelCountLabel(count: number, t: Translator): string {
  return t(count === 1 ? "settings.modelCountOne" : "settings.modelCount", { count });
}

export function providerConfiguredForSettings(
  provider: ProviderConfigurationView,
  runtime?: AppSnapshot["providers"][number]
): boolean {
  if (provider.enabled) return true;
  if (providerConfigurationEditable(provider) && runtime?.supportsLogin !== true) return true;
  return runtime?.authenticationState === "pending"
    || runtime?.authenticationState === "refreshing"
    || runtime?.authenticationState === "authenticated"
    || runtime?.authenticationState === "expired"
    || (runtime?.authenticationState === "error" && runtime.supportsLogout);
}

export function nativeProviderAuthorizationRemovable(
  provider: ProviderConfigurationView,
  runtime?: AppSnapshot["providers"][number]
): boolean {
  return !providerConfigurationEditable(provider)
    && runtime?.supportsLogout === true
    && (runtime.authenticationState === "authenticated"
      || runtime.authenticationState === "expired"
      || runtime.authenticationState === "error");
}

export function managedRuntimeConfiguredForSettings(runtime: NonNullable<AppSnapshot["managedModelRuntimes"]>[number]): boolean {
  return runtime.state !== "absent"
    || runtime.source !== "none"
    || runtime.installedModels.length > 0
    || runtime.transfers.length > 0;
}

function providerMonogram(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "·";
}

function formatCompactTokenCount(value: number): string {
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`;
  return new Intl.NumberFormat().format(value);
}

function providerConnectionLabel(provider: ProviderConfigurationView, t: Translator): string {
  if (provider.kind === "apiKey") return t("settings.apiKey");
  if (provider.kind === "subscription") return t("providerLogin.subscriptionMethod");
  if (provider.kind === "oauth") return "OAuth";
  if (provider.kind === "localKeyless") return t("settings.localKeyless");
  return t("settings.managed");
}

function CredentialList({ credentials, controller, onDelete, emptyLabel, t }: {
  readonly credentials: AppSnapshot["settings"]["credentials"];
  readonly controller: AppController;
  readonly onDelete: (credential: AppSnapshot["settings"]["credentials"][number]) => void;
  readonly emptyLabel: string;
  readonly t: Translator;
}): JSX.Element {
  return credentials.length === 0 ? <p className="provider-detail-empty">{emptyLabel}</p> : <div className="provider-credential-list">{credentials.map((credential) => <article key={credential.id}><StatusDot state={credential.error !== undefined ? "error" : credential.configured ? "healthy" : "muted"} label={credential.configured ? t("settings.configured") : t("settings.missing")} /><span><strong>{credential.name}</strong><small>{credential.kind} · {credential.providerId || t("settings.unbound")}{credential.lastRefreshedAt === undefined ? "" : ` · ${formatRelativeTime(credential.lastRefreshedAt, controller.state.preferences.locale)}`}</small></span><Pill tone={credential.configured ? "success" : "warning"}>{credential.configured ? t("settings.configured") : t("settings.missing")}</Pill><IconButton label={`${t("common.delete")} ${credential.name}`} onClick={() => onDelete(credential)}><Trash2 aria-hidden="true" /></IconButton></article>)}</div>;
}

function CredentialVaultPanel({ controller, snapshot, runAction, onAdd, t }: { readonly controller: AppController; readonly snapshot: AppSnapshot; readonly runAction: RunAction; readonly onAdd: () => void; readonly t: Translator }): JSX.Element {
  const [removalTarget, setRemovalTarget] = useState<AppSnapshot["settings"]["credentials"][number]>();
  return <><div className="provider-detail__scroll provider-vault"><div className="provider-vault-header"><span><strong>{t("settings.credentials")}</strong><small>{t("settings.credentialsBody")}</small></span><Button tone="primary" onClick={onAdd}>{t("settings.addCredential")}</Button></div><CredentialList credentials={snapshot.settings.credentials} controller={controller} onDelete={setRemovalTarget} t={t} emptyLabel={t("settings.noCredentials")} /><section className="credential-assurance"><div className="credential-assurance__icon"><KeyRound aria-hidden="true" /></div><div><strong>{t("settings.secretAssurance")}</strong><p>{t("settings.secretAssuranceBody")}</p><ul><li><Check aria-hidden="true" />{t("settings.credentialProjection")}</li><li><Check aria-hidden="true" />{t("settings.ticketSafety")}</li><li><Check aria-hidden="true" />{t("settings.secretUnreadable")}</li></ul></div></section></div><Modal open={removalTarget !== undefined} title={t("settings.deleteCredentialTitle", { name: removalTarget?.name ?? "" })} description={t("settings.deleteCredentialBody")} size="small" onClose={() => setRemovalTarget(undefined)} headerLeading={<ModalBackButton label={t("common.back")} onClick={() => setRemovalTarget(undefined)} />}><div className="modal__actions"><Button tone="danger" onClick={() => { const target = removalTarget; if (target === undefined) return; setRemovalTarget(undefined); runAction(`delete-credential:${target.id}`, () => controller.deleteCredential(target.id)); }}>{t("common.delete")}</Button></div></Modal></>;
}

function ProviderAddWizard({ open, providers, runtimes, onClose, onChoose, onChooseRuntime, onCustom, t }: { readonly open: boolean; readonly providers: readonly ProviderSettingsEntry[]; readonly runtimes: NonNullable<AppSnapshot["managedModelRuntimes"]>; readonly onClose: () => void; readonly onChoose: (provider: ProviderSettingsEntry) => void; readonly onChooseRuntime: (runtimeId: string) => void; readonly onCustom: () => void; readonly t: Translator }): JSX.Element {
  const [query, setQuery] = useState("");
  useEffect(() => { if (open) setQuery(""); }, [open]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = providers.filter((provider) => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized.length === 0 || provider.provider.name.toLocaleLowerCase().includes(normalized) || provider.provider.id.toLocaleLowerCase().includes(normalized) || provider.backendName?.toLocaleLowerCase().includes(normalized) === true;
  });
  const filteredRuntimes = runtimes.filter((runtime) => normalizedQuery.length === 0 || runtime.name.toLocaleLowerCase().includes(normalizedQuery));
  const groups = [
    { id: "local", label: t("settings.providerWizard.localGroup"), runtimes: filteredRuntimes, providers: [] as readonly ProviderSettingsEntry[] },
    { id: "account", label: t("settings.providerWizard.accountGroup"), providers: filtered.filter((entry) => entry.provider.kind === "oauth" || entry.provider.kind === "subscription" || entry.runtime?.loginMethods.some((method) => method !== "apiKey") === true) },
    { id: "api", label: t("settings.providerWizard.apiGroup"), providers: filtered.filter((entry) => entry.runtime?.loginMethods.some((method) => method !== "apiKey") !== true && (entry.provider.kind === "apiKey" || entry.provider.kind === "managed" || entry.runtime?.loginMethods.includes("apiKey") === true)) }
  ].filter((group) => group.providers.length > 0 || (group.runtimes?.length ?? 0) > 0);
  return <Modal open={open} title={t("settings.addProvider")} size="large" className="provider-flow-modal provider-add-wizard-modal" onClose={onClose} headerLeading={<ProviderFlowBackButton onBack={onClose} t={t} />} headerTrailing={<ProviderWizardProgress activeStep={1} t={t} />}><div className="provider-add-wizard"><label className="provider-add-wizard__search"><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("settings.providerWizard.search")} aria-label={t("settings.providerWizard.search")} /></label><div className="provider-add-wizard__catalog">{groups.map((group) => <section key={group.id}><h3>{group.label}</h3>{group.runtimes?.map((runtime) => <button type="button" key={`runtime:${runtime.id}`} onClick={() => onChooseRuntime(runtime.id)}><span className="provider-catalog-icon" aria-hidden="true"><Server /></span><span><strong>{runtime.name}</strong><small>{t("settings.providerWizard.localSuggestion")}</small></span><Pill>BETA</Pill><ChevronRight aria-hidden="true" /></button>)}{group.providers.map((entry) => <button type="button" key={entry.id} onClick={() => onChoose(entry)}><span className="provider-catalog-icon" aria-hidden="true"><ProviderMark providerId={entry.provider.id} name={entry.provider.name} /></span><span><strong>{entry.provider.name}</strong><small>{[entry.backendName, providerConnectionLabel(entry.provider, t)].filter(Boolean).join(" · ")}</small></span><ChevronRight aria-hidden="true" /></button>)}</section>)}{groups.length === 0 && <p className="provider-add-wizard__empty">{t("settings.providerWizard.noMatches")}</p>}</div><button type="button" className="provider-add-wizard__custom" onClick={onCustom}><span className="provider-catalog-icon"><CirclePlus aria-hidden="true" /></span><span><strong>{t("settings.providerWizard.customTitle")}</strong><small>{t("settings.providerWizard.customBody")}</small></span><ChevronRight aria-hidden="true" /></button><p className="provider-add-wizard__note">{t("settings.providerWizard.authNote")}</p></div></Modal>;
}

function ProviderAccountUsageDetails({
  runtime,
  locale,
  t
}: {
  readonly runtime: AppSnapshot["providers"][number];
  readonly locale: Locale;
  readonly t: Translator;
}): JSX.Element | null {
  const usage = runtime.accountUsage;
  if (!runtime.capabilities.has(capabilityNames.providerAccountUsage) || usage === undefined) return null;
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const windowRows = [
    { key: "primary", label: t("settings.accountUsagePrimary"), window: usage.primaryWindow },
    { key: "secondary", label: t("settings.accountUsageSecondary"), window: usage.secondaryWindow }
  ].filter((row) => row.window !== undefined);
  const creditLabel = usage.credits?.unlimited === true
    ? t("settings.accountCreditsUnlimited")
    : usage.credits?.balance !== undefined
      ? t("settings.accountCreditsBalance", { balance: usage.credits.balance })
      : usage.credits?.hasCredits === false
        ? t("settings.accountCreditsNone")
        : usage.credits?.hasCredits === true
          ? t("settings.accountCreditsAvailable")
          : undefined;
  const observedAt = usage.credits?.observedAt ?? usage.observedAt;
  return <div className="provider-account-usage" role="list" aria-label={t("settings.accountUsage")}>
    {(usage.planType !== undefined || usage.limitReached === true) && <span role="listitem">{[
      usage.planType === undefined ? undefined : t("settings.accountPlan", { plan: usage.planType }),
      usage.limitReached === true ? t("settings.accountLimitReached") : undefined
    ].filter(Boolean).join(" · ")}</span>}
    {windowRows.map((row) => <span role="listitem" key={row.key}>{[
      row.label,
      t("settings.accountUsagePercent", { percent: percent.format(row.window!.usedPercent) }),
      row.window!.windowMinutes === undefined
        ? undefined
        : t("settings.accountUsageWindowMinutes", { minutes: new Intl.NumberFormat(locale).format(row.window!.windowMinutes) }),
      row.window!.resetAt === undefined
        ? undefined
        : t("settings.accountUsageReset", { time: formatRelativeTime(row.window!.resetAt, locale) })
    ].filter(Boolean).join(" · ")}</span>)}
    {creditLabel !== undefined && <span role="listitem">{creditLabel}</span>}
    {observedAt !== undefined && <span role="listitem">{t("settings.accountUsageObserved", { time: formatRelativeTime(observedAt, locale) })}</span>}
  </div>;
}

type ProviderEditorAuthentication = "apiKey" | "oauth" | "none";

interface ProviderEditorSubmission {
  readonly provider: ProviderDraft;
  readonly credential?: CredentialDraft;
}

function ProviderEditor({ open, provider, initialKind = "customEndpoint", credentials, providerIds, runtimeNames, t, onClose, onBack, onSave }: {
  readonly open: boolean;
  readonly provider?: ProviderConfigurationView;
  readonly initialKind?: ProviderDraft["kind"];
  readonly credentials: AppSnapshot["settings"]["credentials"];
  readonly providerIds: readonly string[];
  readonly runtimeNames: readonly string[];
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onBack?: () => void;
  readonly onSave: (submission: ProviderEditorSubmission) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<ProviderDraft>(() => providerDraft(provider, initialKind));
  const [authentication, setAuthentication] = useState<ProviderEditorAuthentication>(() => providerEditorAuthentication(provider));
  const [secret, setSecret] = useState("");
  const [template, setTemplate] = useState<"manual" | ProviderDraft["compatibility"]>("manual");
  const [idManuallyEdited, setIdManuallyEdited] = useState(provider !== undefined);
  useEffect(() => {
    setDraft(providerDraft(provider, initialKind));
    setAuthentication(providerEditorAuthentication(provider));
    setSecret("");
    setTemplate("manual");
    setIdManuallyEdited(provider !== undefined);
  }, [initialKind, open, provider?.id]);
  const existingCredential = draft.credentialId.trim().length > 0;
  const valid = providerDraftValid(draft) && (authentication !== "apiKey" || secret.length > 0 || existingCredential);
  const updateModel = (index: number, patch: Partial<ProviderModelConfigurationView>): void => setDraft((current) => ({ ...current, models: current.models.map((model, position) => position === index ? { ...model, ...patch } : model) }));
  const chooseAuthentication = (next: Exclude<ProviderEditorAuthentication, "oauth">): void => {
    setAuthentication(next);
    setDraft((current) => next === "none"
      ? { ...current, kind: "customEndpoint", keyless: true, authHeader: false, credentialId: "", environmentName: "" }
      : { ...current, kind: "customEndpoint", keyless: false, authHeader: current.compatibility !== "anthropic" });
  };
  const chooseProtocol = (compatibility: ProviderDraft["compatibility"]): void => {
    setTemplate(compatibility);
    setDraft((current) => ({ ...current, compatibility, authHeader: authentication === "apiKey" && compatibility !== "anthropic" }));
  };
  const submit = (): void => {
    if (!valid) return;
    const id = draft.id.trim();
    const credentialId = authentication === "apiKey"
      ? draft.credentialId.trim() || providerCredentialId(id)
      : authentication === "oauth" ? draft.credentialId.trim() : "";
    const environmentName = authentication === "apiKey"
      ? draft.environmentName.trim() || providerCredentialEnvironment(id)
      : authentication === "oauth" ? draft.environmentName.trim() : "";
    const normalizedProvider: ProviderDraft = {
      ...draft,
      id,
      name: draft.name.trim(),
      kind: authentication === "oauth" ? draft.kind : "customEndpoint",
      credentialId,
      environmentName,
      keyless: authentication === "oauth" ? draft.keyless : authentication === "none",
      authHeader: authentication === "oauth" ? draft.authHeader : authentication === "apiKey" && draft.compatibility !== "anthropic"
    };
    onSave({
      provider: normalizedProvider,
      ...(authentication === "apiKey" && secret.length > 0 ? { credential: {
        id: credentialId,
        name: `${normalizedProvider.name} API key`,
        kind: "apiKey",
        providerId: id,
        environmentName,
        secret
      } satisfies CredentialDraft } : {})
    });
  };
  const protocolOptions: readonly ProviderDraft["compatibility"][] = ["openaiResponses", "openaiChat", "anthropic"];
  return <Modal open={open} title={provider === undefined ? t("settings.customProvider.addTitle") : t("settings.editProvider", { name: provider.name })} size="large" className="provider-editor-modal" onClose={onClose} headerLeading={<ProviderFlowBackButton onBack={onBack ?? onClose} t={t} />}>
    <form className="settings-form provider-editor provider-editor--guided" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="provider-editor__intro"><p>{t("settings.customProvider.description")}</p></div>
      <label className="field provider-editor__template"><span>{t("settings.customProvider.template")}</span><SelectControl value={template} onChange={(event) => { const value = event.target.value as typeof template; setTemplate(value); if (value !== "manual") chooseProtocol(value); }}><option value="manual">{t("settings.customProvider.templateManual")}</option><option value="openaiResponses">OpenAI Responses</option><option value="openaiChat">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option></SelectControl></label>
      <label className="field"><span>{t("settings.displayName")}</span><input required value={draft.name} onChange={(event) => { const name = event.target.value; setDraft((current) => ({ ...current, name, ...(provider === undefined && !idManuallyEdited ? { id: uniqueProviderId(name, providerIds) } : {}) })); }} placeholder={t("settings.customProvider.namePlaceholder")} /></label>

      <section className="provider-editor__block" aria-labelledby="provider-editor-authentication"><div className="provider-editor__section-label" id="provider-editor-authentication">{t("settings.customProvider.authentication")}</div><div className="provider-editor__segments" role="group" aria-label={t("settings.customProvider.authentication")}><button type="button" className={cx(authentication === "apiKey" && "is-active")} aria-pressed={authentication === "apiKey"} onClick={() => chooseAuthentication("apiKey")}>{t("settings.apiKey")}</button><Tip className="provider-editor__segment-tip" focusable text={t("settings.customProvider.oauthUnavailable")}><button type="button" className={cx(authentication === "oauth" && "is-active")} aria-pressed={authentication === "oauth"} disabled>OAuth</button></Tip><button type="button" className={cx(authentication === "none" && "is-active")} aria-pressed={authentication === "none"} onClick={() => chooseAuthentication("none")}>{t("settings.customProvider.noAuthentication")}</button></div></section>

      <section className="provider-editor__block" aria-labelledby="provider-editor-runtime"><div className="provider-editor__section-label" id="provider-editor-runtime">{t("settings.customProvider.runtime")}</div><div className="provider-editor__runtime-list">{runtimeNames.length > 0 ? [...new Set(runtimeNames)].map((name) => <span key={name}>{name}</span>) : <span>{t("settings.customProvider.runtimeUnavailable")}</span>}</div><p className="provider-editor__help">{t("settings.customProvider.runtimeBody")}</p></section>

      <section className="provider-editor__connection"><div className="provider-editor__section-label">{t("settings.customProvider.connection")}</div><div className="provider-editor__protocol"><span>{t("settings.customProvider.protocol")}</span><div className="provider-editor__segments" role="group" aria-label={t("settings.customProvider.protocol")}>{protocolOptions.map((compatibility) => <button type="button" key={compatibility} className={cx(draft.compatibility === compatibility && "is-active")} aria-pressed={draft.compatibility === compatibility} onClick={() => chooseProtocol(compatibility)}>{providerCompatibilityLabel(compatibility)}</button>)}</div></div><label className="field"><span>{t("settings.customProvider.baseUrl")}</span><input required type="url" value={draft.endpoint} onChange={(event) => setDraft((current) => ({ ...current, endpoint: event.target.value }))} placeholder="https://api.example.com/v1" /><small>{t("settings.endpointSafety")}</small></label>{authentication === "apiKey" && <label className="field"><span>{t("settings.customProvider.apiKeyValue")}</span><input required={!existingCredential} type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={existingCredential ? t("settings.customProvider.apiKeyKeep") : t("settings.customProvider.apiKeyPlaceholder")} /><small>{t("settings.customProvider.secretBody")}</small></label>}{authentication === "none" && <p className="provider-editor__help">{t("settings.customProvider.noAuthenticationBody")}</p>}</section>

      <section className="provider-editor__models"><div className="provider-editor__models-heading"><span><strong>{t("settings.modelsRequired")}</strong><small>{t("settings.customProvider.modelsBody")}</small></span><Button onClick={() => setDraft((current) => ({ ...current, models: [...current.models, emptyProviderModel()] }))}><CirclePlus aria-hidden="true" />{t("settings.addModel")}</Button></div><div className="provider-editor__model-list">{draft.models.map((model, index) => <article className="provider-model-card" key={`model:${index}`}><div className="provider-model-card__heading"><span className="provider-catalog-icon" aria-hidden="true">{providerMonogram(model.name || model.modelId || "M")}</span><span><strong>{model.name || model.modelId || t("settings.newModel")}</strong><small>{model.modelId || t("settings.customProvider.modelRequired")}</small></span>{draft.models.length > 1 && <IconButton className="danger-text" label={t("settings.removeModel")} onClick={() => setDraft((current) => ({ ...current, models: current.models.filter((_, position) => position !== index) }))}><Trash2 aria-hidden="true" /></IconButton>}</div><div className="settings-form__grid"><label className="field"><span>{t("settings.modelId")}</span><input required value={model.modelId} onChange={(event) => updateModel(index, { modelId: event.target.value })} placeholder="model-id" /></label><label className="field"><span>{t("settings.displayName")}</span><input required value={model.name} onChange={(event) => updateModel(index, { name: event.target.value })} /></label><label className="field"><span>{t("settings.contextWindow")}</span><input required min={1} type="number" value={model.contextWindowTokens} onChange={(event) => updateModel(index, { contextWindowTokens: numericInput(event.target.value) })} /></label><label className="field"><span>{t("settings.maximumOutput")}</span><input required min={1} type="number" value={model.maximumOutputTokens} onChange={(event) => updateModel(index, { maximumOutputTokens: numericInput(event.target.value) })} /></label></div><details className="provider-model-card__advanced"><summary>{t("settings.customProvider.advancedModelOptions")}</summary><label className="field"><span>{t("settings.apiOverride")}</span><SelectControl value={model.compatibility ?? ""} onChange={(event) => updateModel(index, { compatibility: event.target.value === "" ? undefined : event.target.value as ProviderDraft["compatibility"] })}><option value="">{t("settings.inheritProvider")}</option>{providerCompatibilityOptions()}</SelectControl></label><fieldset className="provider-modalities"><legend>{t("settings.inputModalities")}</legend>{(["text", "image", "file", "audio"] as const).map((modality) => <label key={modality}><CheckboxControl checked={model.inputModalities.includes(modality)} onChange={(event) => updateModel(index, { inputModalities: toggleModality(model.inputModalities, modality, event.target.checked) })} />{modality}</label>)}</fieldset><div className="settings-form__toggles"><label><CheckboxControl checked={model.reasoning} onChange={(event) => updateModel(index, { reasoning: event.target.checked })} />{t("settings.reasoning")}</label><label><CheckboxControl checked={model.supportsFastMode} onChange={(event) => updateModel(index, { supportsFastMode: event.target.checked })} />{t("settings.fastSupported")}</label></div><label className="field"><span>{t("settings.effortMappings")}</span><input value={model.thinkingLevels.map((level) => level.nativeLevel === undefined ? level.effortId : `${level.effortId}:${level.nativeLevel}`).join(", ")} onChange={(event) => updateModel(index, { thinkingLevels: thinkingLevels(event.target.value) })} placeholder="low, medium, high:xhigh" /></label><div className="provider-cost-grid">{(["inputCostMicrosPerMillion", "outputCostMicrosPerMillion", "cacheReadCostMicrosPerMillion", "cacheWriteCostMicrosPerMillion"] as const).map((field) => <label className="field" key={field}><span>{t(`settings.${field}`)}</span><input type="number" min={0} value={model[field]} onChange={(event) => updateModel(index, { [field]: numericInput(event.target.value) })} /></label>)}</div></details></article>)}</div></section>

      <details className="provider-editor__advanced"><summary>{t("settings.customProvider.advancedProvider")}</summary><div className="provider-editor__advanced-body"><div className="settings-form__grid"><label className="field"><span>{t("settings.providerId")}</span><input required disabled={provider !== undefined} value={draft.id} onChange={(event) => { setIdManuallyEdited(true); setDraft((current) => ({ ...current, id: event.target.value })); }} placeholder="my-provider" /></label>{authentication === "apiKey" && <><label className="field"><span>{t("settings.customProvider.savedCredential")}</span><SelectControl value={draft.credentialId} onChange={(event) => setDraft((current) => ({ ...current, credentialId: event.target.value }))}><option value="">{t("settings.customProvider.newCredential")}</option>{credentials.map((credential) => <option value={credential.id} key={credential.id}>{credential.name}</option>)}</SelectControl></label><label className="field"><span>{t("settings.environmentName")}</span><input value={draft.environmentName} onChange={(event) => setDraft((current) => ({ ...current, environmentName: event.target.value }))} placeholder={providerCredentialEnvironment(draft.id || "provider")} /></label></>}</div><div className="provider-editor__switches"><label><span>{t("common.enabled")}</span><button type="button" role="switch" className="model-visibility-toggle" aria-checked={draft.enabled} onClick={() => setDraft((current) => ({ ...current, enabled: !current.enabled }))}><span /></button></label>{authentication === "apiKey" && <label><span>{t("settings.authorizationHeader")}</span><button type="button" role="switch" className="model-visibility-toggle" aria-checked={draft.authHeader} onClick={() => setDraft((current) => ({ ...current, authHeader: !current.authHeader }))}><span /></button></label>}</div><fieldset className="provider-editor__section"><legend>{t("settings.headerBindings")}</legend>{draft.headers.map((header, index) => <div className="provider-binding-row" key={`header:${index}`}><label className="field"><span>{t("settings.headerName")}</span><input value={header.headerName} onChange={(event) => setDraft((current) => ({ ...current, headers: current.headers.map((item, position) => position === index ? { ...item, headerName: event.target.value } : item) }))} placeholder="X-API-Key" /></label><label className="field"><span>{t("settings.credentialReference")}</span><SelectControl value={header.credentialId} onChange={(event) => setDraft((current) => ({ ...current, headers: current.headers.map((item, position) => position === index ? { ...item, credentialId: event.target.value } : item) }))}><option value="">{t("common.none")}</option>{credentials.map((credential) => <option value={credential.id} key={credential.id}>{credential.name}</option>)}</SelectControl></label><label className="field"><span>{t("settings.environmentName")}</span><input value={header.environmentName} onChange={(event) => setDraft((current) => ({ ...current, headers: current.headers.map((item, position) => position === index ? { ...item, environmentName: event.target.value } : item) }))} placeholder="PROVIDER_HEADER" /></label><IconButton label={t("common.remove")} onClick={() => setDraft((current) => ({ ...current, headers: current.headers.filter((_, position) => position !== index) }))}><Trash2 aria-hidden="true" /></IconButton></div>)}<Button onClick={() => setDraft((current) => ({ ...current, headers: [...current.headers, { headerName: "", environmentName: "", credentialId: "" }] }))}><CirclePlus aria-hidden="true" />{t("settings.addHeader")}</Button></fieldset><AdvancedProviderModels models={draft.models} t={t} onChange={updateModel} /></div></details>
      <ProviderFlowFooter className="provider-editor__actions"><Button type="submit" tone="primary" disabled={!valid}>{t("common.save")}</Button></ProviderFlowFooter>
    </form>
  </Modal>;
}

const PROVIDER_COMPATIBILITY_BOOLEAN_FIELDS = [
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "supportsFinishReason",
  "requiresReasoningContentOnAssistantMessages",
  "supportsStore",
  "supportsStrictMode",
  "supportsOpenaiGrammarTools",
  "supportsEagerToolInputStreaming",
  "supportsLongCacheRetention",
  "supportsCacheControlOnTools",
  "supportsStrictTools"
] as const;

function AdvancedProviderModels({ models, t, onChange }: { readonly models: readonly ProviderModelConfigurationView[]; readonly t: Translator; readonly onChange: (index: number, patch: Partial<ProviderModelConfigurationView>) => void }): JSX.Element {
  return <fieldset className="provider-editor__section"><legend>{t("settings.advancedModel")}</legend>{models.map((model, index) => <details className="provider-model-advanced" key={`advanced:${model.modelId}:${index}`}><summary>{model.name || model.modelId || t("settings.newModel")}</summary><fieldset><legend>{t("settings.sampling")}</legend><div className="provider-cost-grid">{(["temperature", "topP", "topK", "minP", "repetitionPenalty", "frequencyPenalty", "presencePenalty", "seed"] as const).map((field) => <label className="field" key={field}><span>{t(`settings.sampling.${field}`)}</span><input type="number" step={field === "topK" || field === "seed" ? 1 : "any"} value={model.sampling?.[field] ?? ""} onChange={(event) => onChange(index, { sampling: { ...(model.sampling ?? {}), [field]: optionalNumber(event.target.value) } })} /></label>)}</div></fieldset><fieldset><legend>{t("settings.compatibilityFlags")}</legend><div className="provider-compatibility-grid">{PROVIDER_COMPATIBILITY_BOOLEAN_FIELDS.map((field) => <label className="field" key={field}><span>{t(`settings.compatibility.${field}`)}</span><SelectControl value={optionalBooleanValue(model.compatibilityOptions?.[field])} onChange={(event) => onChange(index, { compatibilityOptions: { ...(model.compatibilityOptions ?? {}), [field]: parseOptionalBoolean(event.target.value) } })}><option value="">{t("settings.unspecified")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option></SelectControl></label>)}</div><div className="settings-form__grid"><label className="field"><span>{t("settings.thinkingFormat")}</span><input value={model.compatibilityOptions?.thinkingFormat ?? ""} onChange={(event) => onChange(index, { compatibilityOptions: { ...(model.compatibilityOptions ?? {}), thinkingFormat: event.target.value || undefined } })} /></label><label className="field"><span>{t("settings.cacheControlFormat")}</span><input value={model.compatibilityOptions?.cacheControlFormat ?? ""} onChange={(event) => onChange(index, { compatibilityOptions: { ...(model.compatibilityOptions ?? {}), cacheControlFormat: event.target.value || undefined } })} /></label></div></fieldset></details>)}</fieldset>;
}

function optionalNumber(value: string): number | undefined {
  if (value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalBooleanValue(value: boolean | undefined): string {
  return value === undefined ? "" : String(value);
}

function parseOptionalBoolean(value: string): boolean | undefined {
  return value === "" ? undefined : value === "true";
}

function providerDraft(provider?: ProviderConfigurationView, initialKind: ProviderDraft["kind"] = "customEndpoint"): ProviderDraft {
  return { id: provider?.id ?? "", name: provider?.name ?? "", kind: provider?.kind ?? initialKind, compatibility: provider?.compatibility ?? "openaiResponses", endpoint: provider?.endpoint ?? "", credentialId: provider?.credentialId ?? "", enabled: provider?.enabled ?? true, keyless: provider?.keyless ?? initialKind === "localKeyless", authHeader: provider?.authHeader ?? true, environmentName: provider?.environmentName ?? "", headers: provider?.headers ?? [], models: provider?.models.length ? provider.models : [emptyProviderModel()] };
}

function providerEditorAuthentication(provider?: ProviderConfigurationView): ProviderEditorAuthentication {
  if (provider?.kind === "oauth" || provider?.kind === "subscription") return "oauth";
  if (provider?.keyless === true || provider?.kind === "localKeyless") return "none";
  return "apiKey";
}

function uniqueProviderId(name: string, providerIds: readonly string[]): string {
  const normalized = name.normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[-._]+$/gu, "")
    .slice(0, 96);
  const base = normalized || "custom-provider";
  const occupied = new Set(providerIds);
  if (!occupied.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base.slice(0, 120 - String(suffix).length)}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  return `${base.slice(0, 111)}-${Date.now().toString(36)}`;
}

function providerCredentialId(providerId: string): string {
  return `credential-${providerId}`.slice(0, 128);
}

function providerCredentialEnvironment(providerId: string): string {
  const suffix = providerId.toLocaleUpperCase().replace(/[^A-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "PROVIDER";
  return `JOKO_PROVIDER_${suffix.slice(0, 96)}_API_KEY`;
}

function providerCompatibilityLabel(compatibility: ProviderDraft["compatibility"]): string {
  switch (compatibility) {
    case "openaiResponses": return "OpenAI Responses";
    case "openaiChat": return "OpenAI Chat Completions";
    case "anthropic": return "Anthropic Messages";
    case "google": return "Google Generative AI";
    case "openaiCompletions": return "OpenAI Completions";
    case "native": return "Native";
  }
}

function emptyProviderModel(): ProviderModelConfigurationView {
  return { modelId: "", name: "", reasoning: false, inputModalities: ["text"], contextWindowTokens: 128_000, maximumOutputTokens: 8_192, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, cacheReadCostMicrosPerMillion: 0, cacheWriteCostMicrosPerMillion: 0, thinkingLevels: [], supportsFastMode: false };
}

function providerDraftValid(draft: ProviderDraft): boolean {
  return draft.id.trim().length > 0 && draft.name.trim().length > 0
    && (draft.endpoint.trim().length > 0 || draft.kind === "managed" || draft.kind === "localKeyless")
    && draft.models.length > 0
    && draft.models.every((model) => model.modelId.trim().length > 0 && model.name.trim().length > 0 && model.inputModalities.length > 0 && model.contextWindowTokens > 0 && model.maximumOutputTokens > 0)
    && new Set(draft.models.map((model) => model.modelId.trim())).size === draft.models.length
    && draft.headers.every((header) => header.headerName.trim().length > 0 && (header.credentialId.length > 0 || header.environmentName.trim().length > 0));
}

function providerCompatibilityOptions(): JSX.Element {
  return <><option value="openaiResponses">OpenAI Responses</option><option value="openaiChat">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option><option value="google">Google Generative AI</option><option value="native">Native</option><option value="openaiCompletions">OpenAI Completions</option></>;
}

function numericInput(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function toggleModality(current: readonly ModelInputModalityView[], modality: ModelInputModalityView, checked: boolean): readonly ModelInputModalityView[] {
  return checked ? [...new Set([...current, modality])] : current.filter((candidate) => candidate !== modality);
}

function thinkingLevels(value: string): ProviderModelConfigurationView["thinkingLevels"] {
  return value.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [effortId = "", nativeLevel] = part.split(":", 2).map((value) => value.trim());
    return { effortId, ...(nativeLevel ? { nativeLevel } : {}) };
  });
}

function providerStatusTone(state: AppSnapshot["providers"][number]["authenticationState"], enabled: boolean): string {
  if (!enabled) return "muted";
  if (state === "authenticated" || state === "notRequired") return "healthy";
  if (state === "error" || state === "expired") return "error";
  return state;
}

function providerAuthTone(state: AppSnapshot["providers"][number]["authenticationState"]): "success" | "warning" | "danger" | "neutral" {
  if (state === "authenticated" || state === "notRequired") return "success";
  if (state === "error" || state === "expired") return "danger";
  if (state === "pending" || state === "refreshing") return "warning";
  return "neutral";
}

function CredentialEditor({ open, initialProviderId = "", providers, t, onClose, onSave }: { readonly open: boolean; readonly initialProviderId?: string; readonly providers: AppSnapshot["settings"]["providers"]; readonly t: Translator; readonly onClose: () => void; readonly onSave: (draft: CredentialDraft) => void }): JSX.Element {
  const [draft, setDraft] = useState<CredentialDraft>(() => credentialDraft(initialProviderId));
  useEffect(() => { if (open) setDraft(credentialDraft(initialProviderId)); }, [initialProviderId, open]);
  const valid = draft.id.trim().length > 0 && draft.name.trim().length > 0 && draft.secret.length > 0;
  return <Modal open={open} title={t("settings.addCredential")} description={t("settings.credentialBody")} size="medium" className="provider-flow-modal credential-editor-modal" onClose={onClose} headerLeading={<ProviderFlowBackButton onBack={onClose} t={t} />}><form className="settings-form credential-editor-form" onSubmit={(event) => { event.preventDefault(); if (valid) onSave(draft); }}><div className="settings-form__grid"><label className="field"><span>{t("settings.referenceId")}</span><input required value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} placeholder="cred_my_provider" /></label><label className="field"><span>{t("settings.displayName")}</span><input required value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label><label className="field"><span>{t("settings.kind")}</span><SelectControl value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as CredentialDraft["kind"] }))}><option value="apiKey">{t("settings.apiKey")}</option><option value="headerSecret">{t("settings.headerSecret")}</option><option value="oauth">{t("settings.oauthToken")}</option><option value="subscription">{t("providerLogin.subscriptionMethod")}</option><option value="localKeyless">{t("settings.localKeyless")}</option></SelectControl></label><label className="field"><span>{t("settings.provider")}</span><SelectControl value={draft.providerId} onChange={(event) => setDraft((current) => ({ ...current, providerId: event.target.value }))}><option value="">{t("settings.unbound")}</option>{providers.filter(providerConfigurationEditable).map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</SelectControl></label><label className="field"><span>{t("settings.environmentName")}</span><input value={draft.environmentName} onChange={(event) => setDraft((current) => ({ ...current, environmentName: event.target.value }))} placeholder="OPENAI_API_KEY" /></label><label className="field"><span>{t("settings.secretValue")}</span><input required type="password" autoComplete="off" value={draft.secret} onChange={(event) => setDraft((current) => ({ ...current, secret: event.target.value }))} /></label></div><ProviderFlowFooter className="credential-editor-form__footer"><Button type="submit" tone="primary" disabled={!valid}>{t("common.save")}</Button></ProviderFlowFooter></form></Modal>;
}

function credentialDraft(providerId = ""): CredentialDraft {
  return { id: "", name: "", kind: "apiKey", providerId, environmentName: "", secret: "" };
}

function PolicySettings({ controller, snapshot, runAction, showHeading = true, t }: { readonly controller: AppController; readonly snapshot: AppSnapshot; readonly runAction: RunAction; readonly showHeading?: boolean; readonly t: Translator }): JSX.Element {
  const counts = snapshot.sessions.reduce((result, session) => ({ ...result, [session.permissionMode]: result[session.permissionMode] + 1 }), { ask: 0, auto: 0, bypassPermissions: 0 });
  const policy = snapshot.settings.policy;
  return <>{showHeading && <SettingsHeading title={t("settings.policy")} body={t("settings.policyBody")} />}<section className="settings-card"><div className="setting-row"><div><strong>{t("settings.defaultPermission")}</strong><span>{t("settings.defaultPermissionBody")}</span></div><SelectControl aria-label={t("settings.defaultPermission")} value={policy.defaultMode} onChange={(event) => runAction("policy-default", () => controller.updatePolicy({ defaultMode: event.target.value as typeof policy.defaultMode }))}><option value="ask">{t("permission.ask")}</option><option value="auto">{t("permission.auto")}</option><option value="bypassPermissions">{t("permission.full")}</option></SelectControl></div><PolicyToggle label={t("settings.requireTrust")} detail={t("settings.requireTrustBody")} checked={policy.projectTrustRequired} onChange={(value) => runAction("policy-trust", () => controller.updatePolicy({ projectTrustRequired: value }))} /><PolicyToggle label={t("settings.redactCredentials")} detail={t("settings.redactCredentialsBody")} checked={policy.redactCredentials} onChange={(value) => runAction("policy-redact", () => controller.updatePolicy({ redactCredentials: value }))} /><PolicyToggle label={t("settings.stripCredentials")} detail={t("settings.stripCredentialsBody")} checked={policy.stripChildProcessCredentials} onChange={(value) => runAction("policy-strip", () => controller.updatePolicy({ stripChildProcessCredentials: value }))} /></section><p className="muted">{t("settings.policyRulesPreserved", { count: policy.ruleCount })}</p><div className="policy-grid"><PolicyCard title={t("permission.ask")} body={t("permission.askHelp")} count={counts.ask} tone="neutral" t={t} /><PolicyCard title={t("permission.auto")} body={t("permission.autoHelp")} count={counts.auto} tone="accent" t={t} /><PolicyCard title={t("permission.full")} body={t("permission.fullHelp")} count={counts.bypassPermissions} tone="danger" t={t} /></div><section className="security-callout"><Shield aria-hidden="true" /><div><h3>{t("settings.projectTrust")}</h3><p>{t("settings.projectTrustBody")}</p></div></section></>;
}

function PolicyToggle({ label, detail, checked, onChange }: { readonly label: string; readonly detail: string; readonly checked: boolean; readonly onChange: (value: boolean) => void }): JSX.Element {
  return <div className="setting-row"><div><strong>{label}</strong><span>{detail}</span></div><SwitchControl aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} /></div>;
}

function PolicyCard({ title, body, count, tone, t }: { readonly title: string; readonly body: string; readonly count: number; readonly tone: "neutral" | "accent" | "danger"; readonly t: Translator }): JSX.Element {
  return <article className={cx("policy-card", `policy-card--${tone}`)}><header><Shield aria-hidden="true" /><Pill tone={tone === "danger" ? "danger" : tone === "accent" ? "accent" : "neutral"}>{t("settings.sessionCount", { count })}</Pill></header><h3>{title}</h3><p>{body}</p></article>;
}

export function McpSettings({ controller, snapshot, runAction, showHeading = true, t }: { readonly controller: AppController; readonly snapshot: AppSnapshot; readonly runAction: RunAction; readonly showHeading?: boolean; readonly t: Translator }): JSX.Element {
  const [editor, setEditor] = useState<"create" | McpServerView | null>(null);
  return <>
    {showHeading && <SettingsSectionHeading title={t("settings.mcp")} body={t("settings.mcpBody")} actions={<Button tone="primary" onClick={() => setEditor("create")}>{t("settings.addMcp")}</Button>} />}
    <section className="settings-card settings-list">
      {snapshot.settings.mcpServers.map((server) => <article key={server.id}>
        <div><StatusDot state={server.state} label={server.state} /><span><strong>{server.name}</strong><small>{server.transport} · {server.endpoint || server.command || t("settings.managedLoopback")} · {t("settings.toolsGeneration", { tools: server.toolCount, generation: server.generation.toString() })}</small></span></div>
        <div><Pill tone={server.state === "connected" ? "success" : server.state === "error" ? "danger" : "warning"}>{server.state}</Pill><Button disabled={!server.enabled} onClick={() => runAction(`restart-mcp:${server.id}`, () => controller.restartMcpServer(server.id))}>{t("common.restart")}</Button>{server.transport !== "loopback" && <><IconButton label={t("settings.editMcp", { name: server.name })} onClick={() => setEditor(server)}><Pencil aria-hidden="true" /></IconButton><IconButton label={`${t("common.delete")} ${server.name}`} onClick={() => runAction(`delete-mcp:${server.id}`, () => controller.deleteMcpServer(server.id))}><Trash2 aria-hidden="true" /></IconButton></>}</div>
      </article>)}
      {snapshot.settings.mcpServers.length === 0 && <p className="muted">{t("settings.noMcp")}</p>}
    </section>
    <section className="security-callout"><Shield aria-hidden="true" /><div><h3>{t("settings.credentialReferences")}</h3><p>{t("settings.credentialReferencesBody")}</p></div></section>
    {editor !== null && <McpServerEditor
      server={editor === "create" ? undefined : editor}
      credentials={snapshot.settings.credentials}
      t={t}
      onClose={() => setEditor(null)}
      onSave={(draft) => controller.saveMcpServer(draft)}
      onSaved={() => setEditor(null)}
    />}
  </>;
}

export function providerConfigurationEditable(provider: ProviderConfigurationView): boolean {
  // Orchestrator deliberately projects built-in Pi Providers without managed models;
  // their API semantics remain owned by Pi and authentication is the only
  // configurable surface. Managed/BYOM entries always carry at least one model.
  return provider.models.length > 0;
}

export function LanguageToolSettings({ controller, snapshot, runAction, onSuccess, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly runAction: RunAction;
  readonly onSuccess: (text: string) => void;
  readonly t: Translator;
}): JSX.Element {
  const authoritative = snapshot.settings.languageTools.enabled;
  const [enabled, setEnabled] = useState(authoritative);
  const [pending, setPending] = useState(false);
  useEffect(() => setEnabled(authoritative), [authoritative]);
  const toggle = (next: boolean): void => {
    if (pending) return;
    const previous = enabled;
    setEnabled(next);
    setPending(true);
    runAction(`language-tools:${next ? "enabled" : "disabled"}`, async () => {
      try {
        await controller.updateLanguageToolSettings(next);
        onSuccess(t(next ? "settings.languageTools.toast.enabled" : "settings.languageTools.toast.disabled"));
      } catch (error) {
        setEnabled(previous);
        throw error;
      } finally {
        setPending(false);
      }
    });
  };
  return <section className="experimental-settings" aria-labelledby="language-tools-heading">
    <div className="settings-section-heading"><h3 id="language-tools-heading">{t("settings.experimental")}</h3><p>{t("settings.experimentalBody")}</p></div>
    <div className="settings-card">
      <div className="setting-row">
        <div><strong>{t("settings.languageTools.title")}</strong><span>{t("settings.languageTools.body")}</span></div>
        <SwitchControl
          aria-label={t("settings.languageTools.toggleAria")}
          checked={enabled}
          disabled={pending}
          onChange={(event) => toggle(event.target.checked)}
        />
      </div>
    </div>
  </section>;
}

function PiSettings({ controller, snapshot, runAction, t }: { readonly controller: AppController; readonly snapshot: AppSnapshot; readonly runAction: RunAction; readonly t: Translator }): JSX.Element {
  const [resourceEditorOpen, setResourceEditorOpen] = useState(false);
  const resourceBackendAvailable = snapshot.backends.some((backend) => backend.capabilities.get("runtime.resources")?.supported === true);
  return <><SettingsHeading title={t("settings.pi")} body={t("settings.piBody")} />{snapshot.settings.pi.length > 0 && <div className="settings-card-stack">{snapshot.settings.pi.map((settings) => {
    const backend = snapshot.backends.find((candidate) => candidate.id === settings.backendId);
    return <section className="settings-card" key={settings.backendId}><div className="setting-row"><div><strong>{backend?.name ?? settings.backendId}</strong><span>{t("settings.piDefaults")}</span></div></div><div className="setting-row"><div><strong>{t("settings.autoCompaction")}</strong><span>{t("settings.autoCompactionBody")}</span></div><SwitchControl aria-label={t("settings.autoCompaction")} checked={settings.autoCompaction} onChange={(event) => runAction(`pi-compact:${settings.backendId}`, () => controller.updatePiSettings(settings.backendId, { autoCompaction: event.target.checked }))} /></div><div className="setting-row"><div><strong>{t("settings.autoRetry")}</strong><span>{t("settings.autoRetryBody")}</span></div><SwitchControl aria-label={t("settings.autoRetry")} checked={settings.autoRetry} onChange={(event) => runAction(`pi-retry:${settings.backendId}`, () => controller.updatePiSettings(settings.backendId, { autoRetry: event.target.checked }))} /></div><div className="setting-row"><div><strong>{t("settings.steeringQueue")}</strong><span>{t("settings.steeringQueueBody")}</span></div><SelectControl aria-label={t("settings.steeringQueue")} value={settings.steeringMode} onChange={(event) => runAction(`pi-steer:${settings.backendId}`, () => controller.updatePiSettings(settings.backendId, { steeringMode: event.target.value as "all" | "oneAtATime" }))}><option value="all">{t("settings.all")}</option><option value="oneAtATime">{t("settings.oneAtATime")}</option></SelectControl></div><div className="setting-row"><div><strong>{t("settings.followUpQueue")}</strong><span>{t("settings.followUpQueueBody")}</span></div><SelectControl aria-label={t("settings.followUpQueue")} value={settings.followUpMode} onChange={(event) => runAction(`pi-follow:${settings.backendId}`, () => controller.updatePiSettings(settings.backendId, { followUpMode: event.target.value as "all" | "oneAtATime" }))}><option value="all">{t("settings.all")}</option><option value="oneAtATime">{t("settings.oneAtATime")}</option></SelectControl></div></section>;
  })}</div>}<header className="settings-section-heading settings-section-heading--actions"><h3>{t("settings.managedResources")}</h3><Button tone="primary" disabled={!resourceBackendAvailable} title={!resourceBackendAvailable ? t("settings.resourceBackendUnavailable") : undefined} onClick={() => setResourceEditorOpen(true)}>{t("settings.addResource")}</Button></header>{!resourceBackendAvailable && <p className="muted settings-unavailable-hint" role="status">{t("settings.resourceBackendUnavailable")}</p>}<PiPackagesSection controller={controller} resources={snapshot.resources} runAction={runAction} t={t} /><ResourceEditor open={resourceEditorOpen} snapshot={snapshot} t={t} onClose={() => setResourceEditorOpen(false)} onSave={(draft) => { setResourceEditorOpen(false); runAction("add-pi-resource", () => controller.addResource(draft)); }} /></>;
}

function ResourceEditor({ open, snapshot, t, onClose, onSave }: { readonly open: boolean; readonly snapshot: AppSnapshot; readonly t: Translator; readonly onClose: () => void; readonly onSave: (draft: ResourceDraft) => void }): JSX.Element {
  const capableBackends = snapshot.backends.filter((backend) => backend.capabilities.get("runtime.resources")?.supported === true);
  const [draft, setDraft] = useState<ResourceDraft>(() => emptyResourceDraft(capableBackends[0]?.id ?? ""));
  useEffect(() => {
    if (open) setDraft(emptyResourceDraft(capableBackends[0]?.id ?? ""));
  }, [open]);
  const valid = resourceDraftIsValid(draft);
  const setResourceKind = (kind: ResourceDraft["kind"]): void => setDraft((current) => ({
    ...current,
    kind,
    source: kind === "package" || current.source.kind === "local" ? current.source : emptyResourceAcquisitionDraft("local")
  }));
  return <Modal open={open} title={t("settings.addResource")} description={t("settings.addResourceBody")} size="large" onClose={onClose} headerLeading={<ModalBackButton label={t("common.back")} onClick={onClose} />}><form className="settings-form" onSubmit={(event) => { event.preventDefault(); const normalized = normalizeResourceDraft(draft); if (normalized !== undefined) onSave(normalized); }}><div className="settings-form__grid"><label className="field"><span>{t("controls.backend")}</span><SelectControl value={draft.backendId} onChange={(event) => setDraft((current) => ({ ...current, backendId: event.target.value }))}>{capableBackends.map((backend) => <option key={backend.id} value={backend.id}>{backend.name}</option>)}</SelectControl></label><label className="field"><span>{t("settings.resourceKind")}</span><SelectControl value={draft.kind} onChange={(event) => setResourceKind(event.target.value as ResourceDraft["kind"])}><option value="extension">{t("resource.kindExtension")}</option><option value="skill">{t("resource.kindSkill")}</option><option value="prompt">{t("resource.kindPrompt")}</option><option value="theme">{t("resource.kindTheme")}</option><option value="package">{t("resource.kindPackage")}</option></SelectControl></label><label className="field"><span>{t("settings.resourceScope")}</span><SelectControl value={draft.scope} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value as ResourceDraft["scope"] }))}><option value="managed">{t("resource.scopeManaged")}</option><option value="user">{t("resource.scopeUser")}</option><option value="global">{t("resource.scopeGlobal")}</option></SelectControl></label><label className="field"><span>{t("settings.resourceSource")}</span><SelectControl value={draft.source.kind} onChange={(event) => setDraft((current) => ({ ...current, source: emptyResourceAcquisitionDraft(event.target.value as ResourceDraft["source"]["kind"]) }))}><option value="local">{t("settings.resourceSourceLocal")}</option><option value="npm" disabled={draft.kind !== "package"}>{t("settings.resourceSourceNpm")}</option><option value="git" disabled={draft.kind !== "package"}>{t("settings.resourceSourceGit")}</option></SelectControl></label><label className="field"><span>{t("settings.displayName")}</span><input value={draft.name} maxLength={120} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder={t("settings.resourceNameOptional")} /></label>{draft.source.kind === "local" && <label className="field settings-form__wide"><span>{t("projects.serverPath")}</span><input required value={draft.source.serverPath} onChange={(event) => setDraft((current) => ({ ...current, source: { kind: "local", serverPath: event.target.value } }))} placeholder={t("projects.serverPathPlaceholder")} /><small>{t("settings.resourcePathHelp")}</small></label>}{draft.source.kind === "npm" && <><label className="field settings-form__wide"><span>{t("settings.npmPackageName")}</span><input required value={draft.source.packageName} onChange={(event) => setDraft((current) => ({ ...current, source: current.source.kind === "npm" ? { ...current.source, packageName: event.target.value } : current.source }))} placeholder="@scope/package" /><small>{t("settings.npmPackageHelp")}</small></label><label className="field"><span>{t("settings.npmVersionSpec")}</span><input value={draft.source.versionSpec} maxLength={128} onChange={(event) => setDraft((current) => ({ ...current, source: current.source.kind === "npm" ? { ...current.source, versionSpec: event.target.value } : current.source }))} placeholder="^1.0.0" /></label></>}{draft.source.kind === "git" && <><label className="field settings-form__wide"><span>{t("settings.gitRepositoryUrl")}</span><input required type="url" value={draft.source.repositoryUrl} maxLength={2048} onChange={(event) => setDraft((current) => ({ ...current, source: current.source.kind === "git" ? { ...current.source, repositoryUrl: event.target.value } : current.source }))} placeholder="https://example.com/org/repository.git" /><small>{t("settings.gitRepositoryHelp")}</small></label><label className="field"><span>{t("settings.gitRef")}</span><input value={draft.source.ref} maxLength={256} onChange={(event) => setDraft((current) => ({ ...current, source: current.source.kind === "git" ? { ...current.source, ref: event.target.value } : current.source }))} placeholder="main" /></label><label className="field"><span>{t("settings.gitSubdirectory")}</span><input value={draft.source.subdirectory} maxLength={1024} onChange={(event) => setDraft((current) => ({ ...current, source: current.source.kind === "git" ? { ...current.source, subdirectory: event.target.value } : current.source }))} placeholder="packages/agent" /></label></>}<label className="field"><span>{t("settings.resourceVersion")}</span><input value={draft.version} onChange={(event) => setDraft((current) => ({ ...current, version: event.target.value }))} /></label></div><div className="modal__actions"><Button type="submit" tone="primary" disabled={!valid}>{t("common.add")}</Button></div></form></Modal>;
}

function emptyResourceDraft(backendId: string): ResourceDraft {
  return { backendId, kind: "skill", scope: "managed", source: emptyResourceAcquisitionDraft("local"), name: "", version: "" };
}

function DiagnosticSettings({ controller, snapshot, runAction, showHeading = true, t }: { readonly controller: AppController; readonly snapshot: AppSnapshot; readonly runAction: RunAction; readonly showHeading?: boolean; readonly t: Translator }): JSX.Element {
  const settings = snapshot.settings.diagnostics;
  return <>
    {showHeading && <SettingsSectionHeading title={t("settings.diagnostics")} body={t("settings.diagnosticsHint")} actions={<Button tone="primary" onClick={() => runAction("diagnostics-bundle", async () => { const artifact = await controller.createDiagnosticsBundle(); await controller.downloadArtifact(artifact.blobId, artifact.fileName); })}>{t("settings.createBundle")}</Button>} />}
    <section className="settings-card">
      <div className="setting-row"><div><strong>{t("settings.diagnosticLevel")}</strong><span>{t("settings.diagnosticLevelBody")}</span></div><SelectControl value={settings.level} onChange={(event) => runAction("diagnostics-level", () => controller.updateDiagnostics({ level: event.target.value as typeof settings.level }))}><option value="errors">{t("settings.errorsOnly")}</option><option value="standard">{t("settings.standard")}</option><option value="verbose">{t("settings.verbose")}</option></SelectControl></div>
      <div className="setting-row"><div><strong>{t("settings.retention")}</strong><span>{t("settings.retentionBody")}</span></div><input type="number" min={0} value={settings.retentionSeconds} onChange={(event) => runAction("diagnostics-retention", () => controller.updateDiagnostics({ retentionSeconds: Number(event.target.value) }))} /></div>
      <div className="setting-row"><div><strong>{t("settings.performanceMetrics")}</strong><span>{t("settings.performanceMetricsBody")}</span></div><SwitchControl aria-label={t("settings.performanceMetrics")} checked={settings.includePerformanceMetrics} onChange={(event) => runAction("diagnostics-metrics", () => controller.updateDiagnostics({ includePerformanceMetrics: event.target.checked }))} /></div>
      <div className="setting-row"><div><strong>{t("settings.backendPayloads")}</strong><span>{t("settings.backendPayloadsBody")}</span></div><SwitchControl aria-label={t("settings.backendPayloads")} checked={settings.includeSanitizedBackendPayloads} onChange={(event) => runAction("diagnostics-payloads", () => controller.updateDiagnostics({ includeSanitizedBackendPayloads: event.target.checked }))} /></div>
    </section>
    <section className="diagnostics-summary"><Database aria-hidden="true" /><div><h3>{t("settings.operationalDiagnostics")}</h3><p>{t("settings.revisionSummary", { snapshot: snapshot.revision.toString(), settings: snapshot.settings.revision.toString(), generation: snapshot.generation.toString(), cursor: snapshot.cursor.toString() })}</p></div><Pill tone={snapshot.diagnostics.length === 0 ? "success" : "warning"}>{t("settings.activeDiagnostics", { count: snapshot.diagnostics.length })}</Pill></section>
    {snapshot.diagnostics.length === 0 ? <div className="clean-state"><Check aria-hidden="true" />{t("diagnostics.empty")}</div> : <div className="diagnostic-list">{snapshot.diagnostics.map((error, index) => <article key={`${error.code}:${index}`}><StatusDot state={error.severity} label={error.severity} /><div><strong>{error.code}</strong><p>{error.message}</p><small>{error.phase} · {error.severity}</small></div></article>)}</div>}
  </>;
}

function uniqueModels(sessions: AppSnapshot["sessions"]): NonNullable<AppSnapshot["sessions"][number]["model"]>[] {
  const result = new Map<string, NonNullable<AppSnapshot["sessions"][number]["model"]>>();
  for (const session of sessions) if (session.model !== undefined) result.set(`${session.model.providerId}:${session.model.modelId}`, session.model);
  return [...result.values()];
}
