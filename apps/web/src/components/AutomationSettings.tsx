import { useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleCheck,
  Download,
  ExternalLink,
  Globe,
  LoaderCircle,
  LogIn,
  MonitorCog,
  RefreshCw,
  Smartphone
} from "lucide-react";

import type { AppController } from "../controller.js";
import type {
  AppSnapshot,
  AndroidAdbPathSourceView,
  AndroidAutomationSettingsView,
  AutomationPermissionStateView,
  BrowserSettingsView,
  BrowserSettingsPatchView,
  ComputerAutomationSettingsView
} from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { Button, cx, CheckboxControl, SwitchControl } from "./ui.js";
import {
  androidConnectionGuideKind,
  androidDeviceLabel,
  describeAndroidDeviceStatus,
  type AndroidConnectionGuideKind
} from "./android-automation-presentation.js";
import { moveTablistSelection } from "./tablist-navigation.js";

const CHROME_DOWNLOAD_URL = "https://www.google.com/chrome/";
const DRIVER_PROJECT_URL = "https://github.com/trycua/cua";
const MAX_BROWSER_PROFILE_CODE_POINTS = 128;
const MIN_BROWSER_TAKEOVER_TIMEOUT_SECONDS = 1;
const MAX_BROWSER_TAKEOVER_TIMEOUT_SECONDS = 86_400;

export interface BrowserServiceSettingsValidation {
  readonly profileValid: boolean;
  readonly timeoutValid: boolean;
  readonly timeoutSeconds?: number;
}

export function validateBrowserServiceSettings(
  profileDisplayName: string,
  takeoverTimeoutInput: string
): BrowserServiceSettingsValidation {
  const timeoutSeconds = Number(takeoverTimeoutInput);
  const profileValid = profileDisplayName.length > 0 &&
    profileDisplayName === profileDisplayName.trim() &&
    [...profileDisplayName].length <= MAX_BROWSER_PROFILE_CODE_POINTS &&
    !/[\u0000-\u001f\u007f]/u.test(profileDisplayName);
  const timeoutValid = /^\d+$/u.test(takeoverTimeoutInput) &&
    Number.isSafeInteger(timeoutSeconds) &&
    timeoutSeconds >= MIN_BROWSER_TAKEOVER_TIMEOUT_SECONDS &&
    timeoutSeconds <= MAX_BROWSER_TAKEOVER_TIMEOUT_SECONDS;
  return {
    profileValid,
    timeoutValid,
    ...(timeoutValid ? { timeoutSeconds } : {})
  };
}

export interface AutomationSettingsProps {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly activeTargetId?: string;
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onSuccess?: (message: string) => void;
}

export function AutomationSettings({ controller, snapshot, activeTargetId, t, runAction, onSuccess }: AutomationSettingsProps): JSX.Element {
  const initialComputerProbeStarted = useRef(false);
  const initialComputerUpdateCheckStarted = useRef(false);
  const initialAndroidPrepareStarted = useRef(false);
  const browserSettings = snapshot.settings.browsers[0];
  const browserTargetId = activeTargetId !== undefined && snapshot.targets.some((target) => target.id === activeTargetId)
    ? activeTargetId
    : undefined;
  useEffect(() => {
    if (snapshot.settings.computerAutomation.support === "notImplemented" || initialComputerProbeStarted.current) return;
    initialComputerProbeStarted.current = true;
    runAction("automation-computer:initial-probe", () => controller.probeComputerAutomation(false));
  }, [controller, runAction, snapshot.settings.computerAutomation.support]);
  useEffect(() => {
    const computer = snapshot.settings.computerAutomation;
    if (!computer.installed || computer.support !== "supported" || initialComputerUpdateCheckStarted.current) return;
    initialComputerUpdateCheckStarted.current = true;
    runAction("automation-computer:update-check", () => controller.checkComputerAutomationUpdate(false));
  }, [controller, runAction, snapshot.settings.computerAutomation.installed, snapshot.settings.computerAutomation.support]);
  useEffect(() => {
    const android = snapshot.settings.androidAutomation;
    if (!android.enabled || android.support !== "supported") {
      initialAndroidPrepareStarted.current = false;
      return;
    }
    if (initialAndroidPrepareStarted.current) return;
    initialAndroidPrepareStarted.current = true;
    runAction("automation-android:initial-prepare", () => controller.prepareAndroidAdb());
  }, [controller, runAction, snapshot.settings.androidAutomation.enabled, snapshot.settings.androidAutomation.support]);

  return (
    <section className="automation-settings">
      <header className="automation-heading">
        <h2 className="automation-heading__title">{t("settings.automation")}</h2>
        <p className="automation-heading__body">{t("settings.automationBody")}</p>
      </header>

      <BrowserAutomationCard
        controller={controller}
        settings={browserSettings}
        targetId={browserTargetId}
        runAction={runAction}
        t={t}
      />

      <div className="automation-divider" aria-hidden="true" />

      <ComputerAutomationCard
        controller={controller}
        settings={snapshot.settings.computerAutomation}
        runAction={runAction}
        onSuccess={onSuccess}
        t={t}
      />

      <div className="automation-divider" aria-hidden="true" />

      <AndroidAutomationCard
        controller={controller}
        settings={snapshot.settings.androidAutomation}
        onEnablePreparation={() => { initialAndroidPrepareStarted.current = true; }}
        runAction={runAction}
        t={t}
      />
    </section>
  );
}

function BrowserAutomationCard({ controller, settings, targetId, runAction, t }: {
  readonly controller: AppController;
  readonly settings: BrowserSettingsView | undefined;
  readonly targetId: string | undefined;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element {
  const [pending, runBrowserAction] = usePendingRunAction(runAction);
  const [profileName, setProfileName] = useState(settings?.profileDisplayName ?? "");
  const [timeoutInput, setTimeoutInput] = useState(String(settings?.takeoverTimeoutSeconds ?? MIN_BROWSER_TAKEOVER_TIMEOUT_SECONDS));
  const profileErrorId = useId();
  const timeoutErrorId = useId();
  const configurable = settings?.support === "supported";
  const visible = configurable || settings?.support === "upstreamMissing";
  const providerId = settings?.browserProviderId;
  const target = settings?.automationTarget ?? "external";
  const backendHealth = settings?.backendHealth ?? { active: false, status: "disconnected" as const, canRecover: true };
  const enabled = targetId === undefined
    ? false
    : settings?.targetSettings?.find((candidate) => candidate.targetId === targetId)?.enabled ?? false;
  const serviceValidation = validateBrowserServiceSettings(profileName, timeoutInput);
  const serviceSettingsDirty = settings !== undefined && (
    profileName !== settings.profileDisplayName ||
    timeoutInput !== String(settings.takeoverTimeoutSeconds)
  );

  useEffect(() => {
    setProfileName(settings?.profileDisplayName ?? "");
    setTimeoutInput(String(settings?.takeoverTimeoutSeconds ?? MIN_BROWSER_TAKEOVER_TIMEOUT_SECONDS));
  }, [settings?.browserProviderId, settings?.profileDisplayName, settings?.takeoverTimeoutSeconds]);

  const update = (patch: BrowserSettingsPatchView): void => {
    if (providerId === undefined) return;
    runBrowserAction(`automation-browser:${providerId}`, () => controller.updateBrowserSettings(providerId, patch));
  };

  const showBrowser = (): void => {
    if (providerId === undefined || targetId === undefined) return;
    runBrowserAction(`automation-browser-show:${providerId}`, () => controller.showBrowserAutomation(providerId, targetId));
  };

  const recoverBrowser = (): void => {
    if (providerId === undefined) return;
    runBrowserAction(`automation-browser-recover:${providerId}`, () => controller.restartBrowser(providerId));
  };

  const saveServiceSettings = (): void => {
    if (!serviceValidation.profileValid || serviceValidation.timeoutSeconds === undefined) return;
    update({
      profileDisplayName: profileName,
      takeoverTimeoutSeconds: serviceValidation.timeoutSeconds
    });
  };

  return (
    <div className="automation-card-stack" data-automation-card="browser">
      <article className={cx("automation-card", !visible && "automation-card--unavailable")}>
        <header className="automation-card__header">
          <span className="automation-card__icon" aria-hidden="true"><Globe /></span>
          <span className="automation-card__heading">
            <strong className="automation-card__title">{t("settings.automationBrowser")}</strong>
            <small className="automation-card__description">{t("settings.automationBrowserBody")}</small>
          </span>
          <AutomationSwitch
            checked={enabled}
            disabled={!configurable || settings === undefined || targetId === undefined || pending}
            label={t("settings.automationBrowser")}
            marker="browser"
            onChange={(nextEnabled) => update({ targetId, enabled: nextEnabled })}
          />
        </header>

        {visible && settings !== undefined ? (
          <>
            {targetId === undefined && <div className="automation-card__status automation-card__status--unavailable" role="status"><AlertTriangle aria-hidden="true" /><span>{t("settings.automationBrowserNoProjectHint")}</span></div>}
            <div className="automation-browser-target" role="tablist" aria-label={t("settings.automationBrowserTarget")} aria-orientation="horizontal">
              <span className="automation-browser-target__copy">
                <strong>{t("settings.automationBrowserTarget")}</strong>
                <small>{t("settings.automationBrowserTargetBody")}</small>
              </span>
              <div className="automation-browser-target__segments">
                <button
                  type="button"
                  role="tab"
                  className={cx(
                    "automation-browser-target__segment",
                    target === "sidebar" && "automation-browser-target__segment--active"
                  )}
                  aria-selected={target === "sidebar"}
                  tabIndex={target === "sidebar" ? 0 : -1}
                  disabled={!configurable || pending}
                  data-automation-target="sidebar"
                  onClick={() => update({ automationTarget: "sidebar" })}
                  onKeyDown={(event) => moveTablistSelection(event, "horizontal")}
                >
                  {t("settings.automationSidebar")}
                </button>
                <button
                  type="button"
                  role="tab"
                  className={cx(
                    "automation-browser-target__segment",
                    target === "external" && "automation-browser-target__segment--active"
                  )}
                  aria-selected={target === "external"}
                  tabIndex={target === "external" ? 0 : -1}
                  disabled={!configurable || pending}
                  data-automation-target="external"
                  onClick={() => update({ automationTarget: "external" })}
                  onKeyDown={(event) => moveTablistSelection(event, "horizontal")}
                >
                  {t("settings.automationExternal")}
                </button>
              </div>
            </div>

            {target === "sidebar"
              ? <BrowserBackendHealthStatus health={backendHealth} pending={pending} onRecover={recoverBrowser} t={t} />
              : <ExternalBrowserStatus
                  controller={controller}
                  detectedBrowser={settings.detectedBrowser}
                  enabled={enabled}
                  pending={pending}
                  onOpen={showBrowser}
                  runAction={runAction}
                  t={t}
                />}
            <form
              className="automation-browser-service-settings"
              aria-label={t("settings.browserBody")}
              onSubmit={(event) => {
                event.preventDefault();
                saveServiceSettings();
              }}
            >
              <div className="setting-row">
                <div>
                  <strong>{t("settings.browserProfile")}</strong>
                  <span>{t("settings.browserProfileBody")}</span>
                  {!serviceValidation.profileValid && <small id={profileErrorId} className="automation-browser-service-settings__error" role="alert">{t("settings.browserProfileInvalid")}</small>}
                </div>
                <input
                  type="text"
                  value={profileName}
                  required
                  disabled={!configurable || pending}
                  aria-label={t("settings.browserProfile")}
                  aria-invalid={!serviceValidation.profileValid}
                  aria-describedby={!serviceValidation.profileValid ? profileErrorId : undefined}
                  data-automation-browser-service="profile"
                  onChange={(event) => setProfileName(event.currentTarget.value)}
                />
              </div>
              <div className="setting-row">
                <div>
                  <strong>{t("settings.takeoverTimeout")}</strong>
                  <span>{t("settings.takeoverTimeoutBody")}</span>
                  {!serviceValidation.timeoutValid && <small id={timeoutErrorId} className="automation-browser-service-settings__error" role="alert">{t("settings.takeoverTimeoutInvalid")}</small>}
                </div>
                <label className="number-field">
                  <input
                    type="number"
                    min={MIN_BROWSER_TAKEOVER_TIMEOUT_SECONDS}
                    max={MAX_BROWSER_TAKEOVER_TIMEOUT_SECONDS}
                    step={1}
                    value={timeoutInput}
                    disabled={!configurable || pending}
                    aria-label={t("settings.takeoverTimeout")}
                    aria-invalid={!serviceValidation.timeoutValid}
                    aria-describedby={!serviceValidation.timeoutValid ? timeoutErrorId : undefined}
                    data-automation-browser-service="timeout"
                    onChange={(event) => setTimeoutInput(event.currentTarget.value)}
                  />
                  <span>{t("settings.seconds")}</span>
                </label>
              </div>
              <div className="setting-row">
                <div><strong>{t("settings.allowUploads")}</strong><span>{t("settings.allowUploadsBody")}</span></div>
                <SwitchControl checked={settings.allowUploads} disabled={!configurable || pending} aria-label={t("settings.allowUploads")} data-automation-browser-service="uploads" onChange={(event) => update({ allowUploads: event.currentTarget.checked })} />
              </div>
              <div className="setting-row">
                <div><strong>{t("settings.allowDownloads")}</strong><span>{t("settings.allowDownloadsBody")}</span></div>
                <SwitchControl checked={settings.allowDownloads} disabled={!configurable || pending} aria-label={t("settings.allowDownloads")} data-automation-browser-service="downloads" onChange={(event) => update({ allowDownloads: event.currentTarget.checked })} />
              </div>
              <div className="automation-browser-service-settings__actions">
                <Button type="submit" tone="primary" disabled={!configurable || pending || !serviceSettingsDirty || !serviceValidation.profileValid || !serviceValidation.timeoutValid}>{t("settings.saveBrowser")}</Button>
              </div>
            </form>
          </>
        ) : (
          <div className="automation-card__status automation-card__status--unavailable" role="status">
            <AlertTriangle aria-hidden="true" />
            <span>{t("settings.automationUnavailable")}</span>
          </div>
        )}
      </article>
      {target === "external" && settings?.detectedBrowser.trim() && (
        <p className="automation-card-stack__hint">{t("settings.automationBrowserLoginHint")}</p>
      )}
      <p className="automation-card-stack__hint">{t("settings.automationNewSessionsHint")}</p>
    </div>
  );
}

function BrowserBackendHealthStatus({ health, pending, onRecover, t }: {
  readonly health: BrowserSettingsView["backendHealth"];
  readonly pending: boolean;
  readonly onRecover: () => void;
  readonly t: Translator;
}): JSX.Element {
  const ready = health.status === "ready" && health.active;
  const recovering = health.status === "recovering";
  const error = health.status === "error";
  const recoverLabel = recovering
    ? t("settings.automationRecovering")
    : error
      ? t("browser.recover")
      : health.status === "disconnected" || ready
      ? t("settings.automationReconnect")
      : t("browser.recover");
  return (
    <div
      className={cx("automation-card__status", error && "automation-card__status--error")}
      role={error ? "alert" : "status"}
    >
      {error ? <AlertTriangle aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
      <span>{ready
        ? t("settings.automationSidebarReady")
        : t(browserHealthReasonKey(health.reason))}</span>
      <Button className="automation-browser__recover" disabled={pending || !health.canRecover} onClick={onRecover}>
          <RefreshCw className={cx((pending || recovering) && "automation-icon--spinning")} aria-hidden="true" />
          {recoverLabel}
      </Button>
    </div>
  );
}

function ExternalBrowserStatus({ controller, detectedBrowser, enabled, pending, onOpen, runAction, t }: {
  readonly controller: AppController;
  readonly detectedBrowser: string;
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly onOpen: () => void;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element {
  const detected = detectedBrowser.trim().length > 0;
  return (
    <div className="automation-card__status" role="status">
      <p>
        {detected
          ? t("settings.automationDetectedBrowser", { browser: detectedBrowser })
          : t("settings.automationBrowserMissing")}
      </p>
      {detected ? (
        <Button className="automation-browser__external-action" disabled={!enabled || pending} onClick={onOpen}>
          <LogIn aria-hidden="true" />
          {t("settings.automationOpenBrowser")}
        </Button>
      ) : (
        <Button
          className="automation-browser__download"
          disabled={pending}
          onClick={() => runAction(
            "automation-browser-download",
            () => controller.openHttpLink(CHROME_DOWNLOAD_URL, { forceExternal: true })
          )}
        >
          <Download aria-hidden="true" />
          {t("settings.automationDownloadBrowser")}
        </Button>
      )}
    </div>
  );
}

function ComputerAutomationCard({ controller, settings, runAction, onSuccess, t }: {
  readonly controller: AppController;
  readonly settings: ComputerAutomationSettingsView;
  readonly runAction: RunAction;
  readonly onSuccess?: (message: string) => void;
  readonly t: Translator;
}): JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pending, runPendingComputerAction] = usePendingRunAction(runAction);
  const [driverUpdatePending, setDriverUpdatePending] = useState(false);
  const [activity, setActivity] = useState<"idle" | "checking" | "installing" | "authorizing" | "updating">("idle");
  const joinedUpdate = useRef(false);
  const permissionGrantActive = useRef(false);
  const permissionFlowGeneration = useRef(0);
  const supported = settings.support === "supported";
  const checking = settings.runtimeState === "checking" || pending;
  const isMac = settings.platform === "darwin";
  const accessibilityReady = permissionReady(settings.accessibilityPermission);
  const screenRecordingReady = permissionReady(settings.screenRecordingPermission)
    && settings.screenRecordingCapturable;
  const permissionMissing = isMac && (!accessibilityReady || !screenRecordingReady);
  const accessibilityPending = activity === "authorizing" && !accessibilityReady;
  const screenRecordingPending = activity === "authorizing" && accessibilityReady && !screenRecordingReady;

  useEffect(() => {
    if (accessibilityReady && screenRecordingReady) permissionGrantActive.current = false;
  }, [accessibilityReady, screenRecordingReady]);
  useEffect(() => () => {
    permissionFlowGeneration.current += 1;
    if (!permissionGrantActive.current) return;
    permissionGrantActive.current = false;
    void controller.cancelComputerAutomationPermission().catch(() => undefined);
  }, [controller]);

  const runComputerAction = (
    key: string,
    action: () => Promise<void>,
    nextActivity: Exclude<typeof activity, "idle"> = "checking"
  ): void => {
    setActivity(nextActivity);
    runPendingComputerAction(`automation-computer:${key}`, async () => {
      try {
        await action();
      } finally {
        setActivity("idle");
      }
    });
  };
  const runDriverUpdate = (joinOnly: boolean): void => {
    setDriverUpdatePending(true);
    runComputerAction(joinOnly ? "update-join" : "update-driver", async () => {
      try {
        await controller.updateComputerAutomationDriver(joinOnly);
        if (!joinOnly) onSuccess?.(t("settings.automationComputerUpdateSuccess"));
      } finally {
        setDriverUpdatePending(false);
      }
    }, "updating");
  };
  const openOrRequestPermission = async (
    permission: "accessibility" | "screenRecording",
    granted: boolean
  ): Promise<void> => {
    const generation = ++permissionFlowGeneration.current;
    await controller.openComputerAutomationPermissionSettings(permission);
    if (granted || permissionFlowGeneration.current !== generation) return;
    permissionGrantActive.current = true;
    try {
      await controller.requestComputerAutomationPermission(permission);
    } catch (error) {
      if (permissionFlowGeneration.current === generation) {
        permissionGrantActive.current = false;
        await controller.cancelComputerAutomationPermission().catch(() => undefined);
      }
      throw error;
    }
  };
  useEffect(() => {
    if (!settings.updateInProgress || joinedUpdate.current) return;
    joinedUpdate.current = true;
    runDriverUpdate(true);
  }, [controller, settings.updateInProgress]);

  return (
    <div className="automation-card-stack" data-automation-card="computer">
      <article className={cx("automation-card", !supported && "automation-card--unavailable")}>
        <header className="automation-card__header">
          <span className="automation-card__icon" aria-hidden="true"><MonitorCog /></span>
          <span className="automation-card__heading">
            <strong className="automation-card__title">{t("settings.automationComputer")}</strong>
            <small className="automation-card__description">{t("settings.automationComputerBody")}</small>
          </span>
          <AutomationSwitch
            checked={settings.enabled}
            disabled={!supported || checking}
            label={t("settings.automationComputer")}
            marker="computer"
            onChange={(enabled) => runComputerAction(
              "enabled",
              async () => {
                if (!enabled) permissionFlowGeneration.current += 1;
                if (!enabled && permissionGrantActive.current) {
                  permissionGrantActive.current = false;
                  await controller.cancelComputerAutomationPermission();
                }
                await controller.updateComputerAutomationSettings(enabled);
              },
              enabled && !settings.installed ? "installing" : enabled && permissionMissing ? "authorizing" : "checking"
            )}
          />
        </header>

        {!supported ? (
          <div className="automation-card__status automation-card__status--unavailable" role="status">
            <AlertTriangle aria-hidden="true" />
            <span>{t("settings.automationUnavailable")}</span>
          </div>
        ) : (
          <>
            {isMac && (
              <section className="automation-permissions" aria-labelledby="automation-permissions-title">
                <div className="automation-permissions__heading">
                  <strong id="automation-permissions-title">{t("settings.automationSystemPermission")}</strong>
                {activity === "installing" || activity === "authorizing" ? (
                  <span className="automation-computer__pending" role="status">
                    <RefreshCw className="automation-icon--spinning" aria-hidden="true" />
                    {t(activity === "installing"
                      ? "settings.automationComputerInstalling"
                      : "settings.automationComputerAuthorizing")}
                  </span>
                ) : (
                  <Button
                      className="automation-computer__recheck"
                      disabled={checking}
                      onClick={() => runComputerAction("probe", () => controller.probeComputerAutomation(true))}
                    >
                      <RefreshCw className={cx(checking && "automation-icon--spinning")} aria-hidden="true" />
                      {t("settings.automationComputerRecheck")}
                    </Button>
                )}
                </div>
                <div className="automation-permissions__grid">
                  <PermissionCard
                    icon="accessibility"
                    label={t("settings.automationAccessibility")}
                    granted={accessibilityReady}
                    permission="accessibility"
                    pending={accessibilityPending}
                    onAuthorize={() => runComputerAction(
                      "permission-accessibility",
                      () => settings.installed
                        ? openOrRequestPermission("accessibility", accessibilityReady)
                        : controller.updateComputerAutomationSettings(true),
                      settings.installed ? "authorizing" : "installing"
                    )}
                    t={t}
                  />
                  <PermissionCard
                    icon="screenRecording"
                    label={t("settings.automationScreenRecording")}
                    granted={screenRecordingReady}
                    permission="screenRecording"
                    pending={screenRecordingPending}
                    onAuthorize={() => runComputerAction(
                      "permission-screen-recording",
                      () => settings.installed
                        ? openOrRequestPermission("screenRecording", screenRecordingReady)
                        : controller.updateComputerAutomationSettings(true),
                      settings.installed ? "authorizing" : "installing"
                    )}
                    t={t}
                  />
                </div>
              </section>
            )}
            <ComputerDriverStatus
              activity={activity}
              isMac={isMac}
              pending={driverUpdatePending}
              settings={settings}
              detailsOpen={detailsOpen}
              onToggleDetails={() => setDetailsOpen((current) => !current)}
              onUpdate={() => runDriverUpdate(false)}
              t={t}
            />
          </>
        )}

        {detailsOpen && supported && (
          <div className="automation-details__body">
            <p>{t("settings.automationDriverInfo")}</p>
            {isMac && <p>{t(settings.ready ? "settings.automationRuntimeConfirmations" : "settings.automationMacHint")}</p>}
            <Button
              className="automation-details__link"
              onClick={() => runAction(
                "automation-computer:driver-project",
                () => controller.openHttpLink(DRIVER_PROJECT_URL, { forceExternal: true })
              )}
            >
              <ExternalLink aria-hidden="true" />
              {t("settings.automationDriverLink")}
            </Button>
          </div>
        )}
      </article>
      <p className="automation-card-stack__hint">{t("settings.automationNewSessionsHint")}</p>
    </div>
  );
}

function ComputerDriverStatus({ activity, isMac, pending, settings, detailsOpen, onToggleDetails, onUpdate, t }: {
  readonly activity: "idle" | "checking" | "installing" | "authorizing" | "updating";
  readonly isMac: boolean;
  readonly pending: boolean;
  readonly settings: ComputerAutomationSettingsView;
  readonly detailsOpen: boolean;
  readonly onToggleDetails: () => void;
  readonly onUpdate: () => void;
  readonly t: Translator;
}): JSX.Element {
  const updating = settings.updateInProgress || pending;
  const installing = settings.updatePhase === "installing";
  const updateVisible = settings.installed
    && settings.updateLatestVersion !== ""
    && (settings.updateAvailable || settings.updateInProgress);
  const hasProgress = settings.updatePhase === "downloading"
    && settings.updateDownloadedBytes !== undefined
    && settings.updateTotalBytes !== undefined
    && settings.updateTotalBytes > 0;
  const progress = hasProgress
    ? Math.max(0, Math.min(100, settings.updateDownloadedBytes! / settings.updateTotalBytes! * 100))
    : 0;
  return (
    <div className="automation-card__status automation-card__status--driver" role="status">
      <span className="automation-computer__driver-status">
        <span>{settings.installed
          ? t("settings.automationComputerInstalled", { version: settings.driverVersion })
          : t("settings.automationComputerNotDetected")}</span>
        {!isMac && activity === "installing" && (
          <>
            <i className="automation-computer__separator" aria-hidden="true">·</i>
            <small className="automation-computer__installing">
              <RefreshCw className="automation-icon--spinning" aria-hidden="true" />
              {t("settings.automationComputerInstalling")}
            </small>
          </>
        )}
        {updateVisible && (
          <>
            <i className="automation-computer__separator" aria-hidden="true">·</i>
            <small className="automation-computer-update__copy" aria-live="polite">
              {updating
                ? t(installing ? "settings.automationComputerUpdateInstalling" : "settings.automationComputerUpdating")
                : t("settings.automationComputerUpdateAvailable", { version: settings.updateLatestVersion })}
            </small>
            <Button className="automation-computer-update__button" disabled={updating} onClick={onUpdate}>
              <Download aria-hidden="true" />
              {t(updating ? "settings.automationComputerUpdating" : "settings.automationComputerUpdate")}
            </Button>
          </>
        )}
      </span>
      <Button
        className="automation-details__toggle"
        tone="ghost"
        aria-expanded={detailsOpen}
        onClick={onToggleDetails}
      >
        {t(detailsOpen ? "settings.automationLess" : "settings.automationMore")}
        <ChevronDown className={cx(detailsOpen && "automation-details__chevron--open")} aria-hidden="true" />
      </Button>
      {hasProgress && (
        <span className="automation-computer-update__track" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </span>
      )}
    </div>
  );
}

function PermissionCard({ icon, label, granted, permission, pending, onAuthorize, t }: {
  readonly icon: "accessibility" | "screenRecording";
  readonly label: string;
  readonly granted: boolean;
  readonly permission: "accessibility" | "screenRecording";
  readonly pending: boolean;
  readonly onAuthorize: () => void;
  readonly t: Translator;
}): JSX.Element {
  return (
    <button
      type="button"
      className={cx("automation-permission", granted && "automation-permission--granted")}
      data-automation-permission={permission}
      data-permission-state={granted ? "granted" : "missing"}
      disabled={pending}
      onClick={onAuthorize}
    >
      <span className="automation-permission__icon" aria-hidden="true">
        <PermissionSystemIcon kind={icon} />
      </span>
      <strong className="automation-permission__label">{label}</strong>
      {pending ? (
        <span className="automation-permission__action automation-permission__action--pending">
          <LoaderCircle className="automation-icon--spinning" aria-hidden="true" />
          {t("settings.automationWaiting")}
        </span>
      ) : granted ? (
        <span className="automation-permission__state">{t("settings.automationGranted")}<Check aria-hidden="true" /></span>
      ) : (
        <span className="automation-permission__action">
          {t("settings.automationAuthorize")}
        </span>
      )}
    </button>
  );
}

function PermissionSystemIcon({ kind }: { readonly kind: "accessibility" | "screenRecording" }): JSX.Element {
  if (kind === "accessibility") {
    return (
      <svg viewBox="0 0 32 32" focusable="false">
        <defs>
          <linearGradient id="automation-accessibility-fill" x1="16" y1="1" x2="16" y2="31" gradientUnits="userSpaceOnUse">
            <stop stopColor="#18b8ef" />
            <stop offset="1" stopColor="#087ff4" />
          </linearGradient>
        </defs>
        <circle cx="16" cy="16" r="15.25" fill="url(#automation-accessibility-fill)" />
        <circle cx="16" cy="16" r="12.75" fill="none" stroke="white" strokeWidth="1.35" />
        <circle cx="16" cy="9.7" r="1.75" fill="white" />
        <path d="M10.2 13.25c3.85.95 7.75.95 11.6 0M16 14.1v6.2m0-1.05-3.05 6.05m3.05-6.05 3.05 6.05" fill="none" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.15" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 32 32" focusable="false">
      <defs>
        <linearGradient id="automation-screen-recording-fill" x1="14" y1="1" x2="14" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2d9cff" />
          <stop offset="1" stopColor="#087ff4" />
        </linearGradient>
      </defs>
      <rect x="0.75" y="0.75" width="26.5" height="26.5" rx="7.5" fill="url(#automation-screen-recording-fill)" />
      <path d="M9.4 8.3v8.25m3-10.4v10.4m3-11.15v11.15m3-9.35v10.2m0-4.6 2.05-1.95c.9-.86 2.2-.8 2.86.03.5.64.42 1.58-.18 2.25l-3.65 4.08c-1.6 1.79-3.4 2.58-5.5 2.3-2.58-.34-4.58-2.4-4.58-5.01v-6.2" fill="none" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.1" />
      <rect x="19" y="17.8" width="12" height="12" rx="3.8" fill="#ff4d50" />
      <circle cx="25" cy="23.8" r="3.25" fill="none" stroke="white" strokeWidth="1.65" />
      <circle cx="25" cy="23.8" r="1.3" fill="white" />
    </svg>
  );
}

function AndroidAutomationCard({ controller, settings, onEnablePreparation, runAction, t }: {
  readonly controller: AppController;
  readonly settings: AndroidAutomationSettingsView;
  readonly onEnablePreparation: () => void;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element {
  const [pending, runPendingAndroidAction] = usePendingRunAction(runAction);
  const [pathDraft, setPathDraft] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const supported = settings.support === "supported";
  const busy = pending || settings.runtimeState === "checking" || settings.runtimeState === "preparing";
  const guide = androidConnectionGuideKind(settings);
  const deviceStatus = describeAndroidDeviceStatus(settings, t);
  const effectivePath = settings.adbPathOverride || settings.adbPath;
  useEffect(() => {
    if (!pathEdited) setPathDraft(effectivePath);
  }, [effectivePath, pathEdited]);

  const runAndroidAction = (key: string, action: () => Promise<void>): void => {
    runPendingAndroidAction(`automation-android:${key}`, action);
  };
  const savePath = (): void => {
    const path = pathDraft.trim();
    if (path === "") return;
    runAndroidAction("adb-path", async () => {
      await controller.setAndroidAdbPath(path);
      setPathDraft(path);
      setPathEdited(false);
    });
  };
  const resetPath = (): void => {
    runAndroidAction("adb-path-default", async () => {
      await controller.setAndroidAdbPath();
      setPathEdited(false);
    });
  };
  const pathCanSave = pathEdited
    && pathDraft.trim() !== ""
    && pathDraft.trim() !== settings.adbPathOverride.trim();

  return (
    <div className="automation-card-stack" data-automation-card="android">
      <article className={cx("automation-card", !supported && "automation-card--unavailable")}>
        <header className="automation-card__header">
          <span className="automation-card__icon" aria-hidden="true"><Smartphone /></span>
          <span className="automation-card__heading">
            <strong className="automation-card__title">{t("settings.automationAndroid")}</strong>
            <small className="automation-card__description">{t("settings.automationAndroidBody")}</small>
          </span>
          <AutomationSwitch
            checked={settings.enabled}
            disabled={!supported || busy}
            label={t("settings.automationAndroid")}
            marker="android"
            onChange={(enabled) => {
              if (enabled) onEnablePreparation();
              runAndroidAction("enabled", () => controller.updateAndroidAutomationSettings(enabled));
            }}
          />
        </header>

        {!supported ? (
          <div className="automation-card__status automation-card__status--unavailable" role="status">
            <AlertTriangle aria-hidden="true" />
            <span>{t("settings.automationUnavailable")}</span>
          </div>
        ) : (
          <>
            <div className="automation-android__row automation-android__device-row">
              <span className="automation-android__copy">
                <strong>{t("settings.automationAndroidDevice")}</strong>
                <small>{deviceStatus}</small>
              </span>
              <div className="automation-android__actions">
                <AndroidDevicePicker
                  settings={settings}
                  disabled={busy || (!settings.enabled && !settings.statusObserved)}
                  onSelect={(serial) => runAndroidAction(
                    `device:${serial ?? "automatic"}`,
                    () => controller.selectAndroidAutomationDevice(serial)
                  )}
                  t={t}
                />
                <Button
                  className="automation-android__refresh"
                  disabled={busy}
                  onClick={() => runAndroidAction("probe", () => controller.probeAndroidAutomation(true))}
                >
                  <RefreshCw className={cx(busy && "automation-icon--spinning")} aria-hidden="true" />
                  {t("settings.automationAndroidRefresh")}
                </Button>
              </div>
            </div>

            {guide !== undefined && <AndroidConnectionGuide kind={guide} t={t} />}

            <div className="automation-android__row automation-android__adb-row">
              <span className="automation-android__copy">
                <strong>{t("settings.automationAndroidAdb")}</strong>
                <small>{androidAdbStatus(settings, t)}</small>
              </span>
              <div className="automation-android__path-actions">
                <input
                  type="text"
                  value={pathDraft}
                  disabled={busy}
                  placeholder={t("settings.automationAndroidAdbPlaceholder")}
                  aria-label={t("settings.automationAndroidAdbPathAria")}
                  onChange={(event) => {
                    setPathDraft(event.currentTarget.value);
                    setPathEdited(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && pathCanSave && !busy) savePath();
                  }}
                />
                <Button disabled={!pathCanSave || busy} onClick={savePath}>
                  {t("settings.automationAndroidAdbSave")}
                </Button>
                <Button disabled={busy} onClick={resetPath}>
                  {t("settings.automationAndroidAdbUseDefault")}
                </Button>
              </div>
            </div>
          </>
        )}
      </article>
      <p className="automation-card-stack__hint">{t("settings.automationAndroidHint")}</p>
    </div>
  );
}

function AndroidDevicePicker({ settings, disabled, onSelect, t }: {
  readonly settings: AndroidAutomationSettingsView;
  readonly disabled: boolean;
  readonly onSelect: (serial: string | undefined) => void;
  readonly t: Translator;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openFocusRef = useRef<"selected" | "first" | "last">("selected");
  const typeaheadRef = useRef("");
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const menuId = useId();
  const configured = settings.configuredDefaultDeviceSerial.trim();
  const selected = configured === ""
    ? undefined
    : settings.devices.find((device) => device.deviceSerial === configured);
  const stale = configured !== "" && selected === undefined;
  const label = configured === ""
    ? t("settings.automationAndroidDeviceAuto")
    : androidDeviceLabel(selected) || configured;

  useEffect(() => {
    if (!open) return;
    const closeForPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeForPointer);
    const options = enabledDeviceOptions(menuRef.current);
    const selectedOption = menuRef.current?.querySelector<HTMLButtonElement>(
      '.automation-android__device-option[aria-selected="true"]:not(:disabled)'
    );
    const initial = openFocusRef.current === "first"
      ? options[0]
      : openFocusRef.current === "last"
        ? options.at(-1)
        : selectedOption ?? options[0];
    openFocusRef.current = "selected";
    initial?.focus();
    return () => {
      document.removeEventListener("pointerdown", closeForPointer);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => () => {
    if (typeaheadTimerRef.current !== undefined) clearTimeout(typeaheadTimerRef.current);
  }, []);

  const choose = (serial: string | undefined): void => {
    setOpen(false);
    onSelect(serial);
    triggerRef.current?.focus();
  };

  const moveFocus = (position: "first" | "last" | "next" | "previous"): void => {
    const options = enabledDeviceOptions(menuRef.current);
    if (options.length === 0) return;
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const index = position === "first"
      ? 0
      : position === "last"
        ? options.length - 1
        : position === "next"
          ? current < 0 || current === options.length - 1 ? 0 : current + 1
          : current <= 0 ? options.length - 1 : current - 1;
    options[index]?.focus();
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") return;
    const movement = event.key === "ArrowDown"
      ? "next"
      : event.key === "ArrowUp"
        ? "previous"
        : event.key === "Home"
          ? "first"
          : event.key === "End"
            ? "last"
            : undefined;
    if (movement !== undefined) {
      event.preventDefault();
      moveFocus(movement);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && document.activeElement instanceof HTMLButtonElement) {
      event.preventDefault();
      document.activeElement.click();
      return;
    }
    if (
      event.key.length !== 1
      || event.ctrlKey
      || event.altKey
      || event.metaKey
      || event.key.trim() === ""
    ) return;
    event.preventDefault();
    const key = event.key.toLocaleLowerCase();
    const previous = typeaheadRef.current;
    typeaheadRef.current = previous !== "" && [...previous].every((character) => character === key)
      ? key
      : `${previous}${key}`;
    if (typeaheadTimerRef.current !== undefined) clearTimeout(typeaheadTimerRef.current);
    typeaheadTimerRef.current = setTimeout(() => { typeaheadRef.current = ""; }, 750);
    const options = enabledDeviceOptions(menuRef.current);
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const ordered = [...options.slice(current + 1), ...options.slice(0, current + 1)];
    ordered.find((option) => option.textContent?.trim().toLocaleLowerCase().startsWith(typeaheadRef.current))?.focus();
  };

  return (
    <div
      className="automation-android__device-picker"
      ref={rootRef}
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="automation-android__device-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t("settings.automationAndroidDeviceSelect")}
        title={configured || undefined}
        onClick={() => {
          openFocusRef.current = "selected";
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          openFocusRef.current = event.key === "ArrowUp" || event.key === "End" ? "last" : "first";
          setOpen(true);
        }}
      >
        <Smartphone aria-hidden="true" />
        <span>{label}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className="automation-android__device-menu"
          role="listbox"
          aria-label={t("settings.automationAndroidDeviceSelect")}
          onKeyDown={handleMenuKeyDown}
        >
          <button
            type="button"
            role="option"
            aria-selected={configured === ""}
            className="automation-android__device-option"
            tabIndex={-1}
            onClick={() => choose(undefined)}
          >
            <Check className={cx(configured !== "" && "automation-android__option-check--hidden")} aria-hidden="true" />
            <span><strong>{t("settings.automationAndroidDeviceAuto")}</strong><small>{t("settings.automationAndroidDeviceAutoHint")}</small></span>
          </button>
          {stale && (
            <button
              type="button"
              role="option"
              aria-selected="true"
              className="automation-android__device-option"
              tabIndex={-1}
              onClick={() => choose(configured)}
            >
              <Check aria-hidden="true" />
              <span><strong>{configured}</strong><small>{t("settings.automationAndroidDeviceUnavailable")}</small></span>
            </button>
          )}
          {settings.devices.length === 0 ? (
            <p className="automation-android__device-empty">{t("settings.automationAndroidDeviceNone")}</p>
          ) : settings.devices.map((device) => {
            const ready = device.state === "device";
            const selectedDevice = configured === device.deviceSerial;
            return (
              <button
                type="button"
                role="option"
                aria-selected={selectedDevice}
                className="automation-android__device-option"
                disabled={!ready}
                tabIndex={-1}
                key={device.deviceSerial}
                onClick={() => choose(device.deviceSerial)}
              >
                <Check className={cx(!selectedDevice && "automation-android__option-check--hidden")} aria-hidden="true" />
                <span>
                  <strong>{androidDeviceLabel(device)}</strong>
                  <small>{ready
                    ? t("settings.automationAndroidDeviceReady")
                    : t("settings.automationAndroidDeviceState", { state: device.state })}</small>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function enabledDeviceOptions(menu: HTMLDivElement | null): HTMLButtonElement[] {
  return menu === null
    ? []
    : [...menu.querySelectorAll<HTMLButtonElement>('.automation-android__device-option:not(:disabled)')];
}

function AndroidConnectionGuide({ kind, t }: {
  readonly kind: AndroidConnectionGuideKind;
  readonly t: Translator;
}): JSX.Element {
  const title = kind === "connect"
    ? t("settings.automationAndroidConnectTitle")
    : kind === "unauthorized"
      ? t("settings.automationAndroidAuthorizeTitle")
      : t("settings.automationAndroidOfflineTitle");
  return (
    <div className="automation-android__guide">
      <div>
        <strong>{title}</strong>
        {kind === "connect" ? (
          <>
            <p>{t("settings.automationAndroidConnectNote")}</p>
            <ol>
              <li>{t("settings.automationAndroidConnectStep1")}</li>
              <li>{t("settings.automationAndroidConnectStep2")}</li>
              <li>{t("settings.automationAndroidConnectStep3")}</li>
              <li>{t("settings.automationAndroidConnectStep4")}</li>
            </ol>
          </>
        ) : (
          <p>{t(kind === "unauthorized"
            ? "settings.automationAndroidAuthorizeBody"
            : "settings.automationAndroidOfflineBody")}</p>
        )}
      </div>
    </div>
  );
}

function androidAdbStatus(settings: AndroidAutomationSettingsView, t: Translator): string {
  if (settings.runtimeState === "checking") return t("settings.automationAndroidChecking");
  if (settings.runtimeState === "preparing") return t("settings.automationAndroidPreparing");
  if (settings.adbAvailable && settings.adbPath !== "") {
    return t("settings.automationAndroidAdbReady", { source: androidAdbSourceLabel(settings.adbPathSource, t) });
  }
  if (settings.preparationError !== "") {
    return t("settings.automationAndroidAdbPrepareFailed", { message: settings.preparationError });
  }
  return t("settings.automationAndroidAdbAuto");
}

function androidAdbSourceLabel(source: AndroidAdbPathSourceView, t: Translator): string {
  switch (source) {
    case "custom": return t("settings.automationAndroidAdbSourceCustom");
    case "environment": return t("settings.automationAndroidAdbSourceEnvironment");
    case "prepared": return t("settings.automationAndroidAdbSourcePrepared");
    case "bundled": return t("settings.automationAndroidAdbSourceBundled");
    case "sdk": return t("settings.automationAndroidAdbSourceSdk");
    case "path": return t("settings.automationAndroidAdbSourcePath");
    case "fallback": return t("settings.automationAndroidAdbSourceFallback");
    case "unspecified": return t("settings.automationAndroidAdbSourceAuto");
  }
}

function AutomationSwitch({ checked, disabled, label, marker, onChange }: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly marker: "browser" | "computer" | "android";
  readonly onChange: (checked: boolean) => void;
}): JSX.Element {
  return <SwitchControl
    className="automation-switch"
    checked={checked}
    disabled={disabled}
    aria-label={label}
    data-automation-toggle={marker}
    onChange={(event) => onChange(event.currentTarget.checked)}
  />;
}

function permissionReady(permission: AutomationPermissionStateView): boolean {
  return permission === "granted" || permission === "notRequired";
}

function usePendingRunAction(runAction: RunAction): readonly [
  boolean,
  (key: string, action: () => Promise<void>) => void
] {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const run = (key: string, action: () => Promise<void>): void => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    runAction(key, async () => {
      try {
        await action();
      } finally {
        pendingRef.current = false;
        if (mountedRef.current) setPending(false);
      }
    });
  };
  return [pending, run] as const;
}

function browserHealthReasonKey(
  reason: BrowserSettingsView["backendHealth"]["reason"]
): Parameters<Translator>[0] {
  switch (reason) {
    case "disposing": return "settings.automationBrowserDisposing";
    case "hostUnavailable": return "settings.automationBrowserHostUnavailable";
    case "startFailed": return "settings.automationBrowserStartFailed";
    case "statusFailed": return "settings.automationBrowserStatusFailed";
    case "recoveryFailed": return "settings.automationBrowserRecoveryFailed";
    case undefined: return "settings.automationSidebarError";
  }
}
