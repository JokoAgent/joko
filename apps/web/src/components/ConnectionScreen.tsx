import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { JSX } from "react";
import { AlertTriangle, ArrowRight, KeyRound, Laptop, Moon, RefreshCcw, Server, Sun, Trash2, Wifi } from "lucide-react";
import { connectionArtworkGroupAt, nextConnectionArtworkGroupIndex } from "../connection-artwork.js";
import type { ConnectionArtworkVariant } from "../connection-artwork.js";
import type { ConnectionScreenController, ConnectionScreenManagedStatus, ConnectionScreenMode, ConnectionScreenProfile } from "../connection-contract.js";
import { isInsecureLanOrigin, normalizeOrchestratorOrigin } from "../connection-origin.js";
import { persistentWebSecretEncryptionAvailable } from "../web-crypto.js";
import type { Translator } from "./types.js";
import { Button, ErrorBanner, IconButton, Pill, Spinner, formatRelativeTime, CheckboxControl } from "./ui.js";

export function ConnectionScreen({ controller, t }: { readonly controller: ConnectionScreenController; readonly t: Translator }): JSX.Element {
  const { state } = controller;
  const remoteProfiles = useMemo(() => state.profiles.filter((profile) => profile.managedLocal !== true), [state.profiles]);
  const [{ mode, artworkGroupIndex, artworkVariant }, dispatchView] = useReducer(connectionViewReducer, {
    mode: state.initialMode ?? (remoteProfiles.length === 0 ? "nearby" : "saved"),
    artworkGroupIndex: 0,
    artworkVariant: "base"
  });
  const artworkGroup = connectionArtworkGroupAt(artworkGroupIndex);
  const artwork = artworkGroup[artworkVariant];
  const selectMode = (nextMode: ConnectionMode): void => {
    if (actionsDisabled || actionRef.current !== undefined) return;
    try {
      controller.cancelAutomaticConnectionAttempt();
      controller.selectMode?.(nextMode);
      if (challengePairing) setCode("");
      setLocalError(undefined);
      dispatchView({ type: "selectMode", mode: nextMode });
    } catch (error) {
      setLocalError(messageOf(error, t("error.unexpected")));
    }
  };
  const [origin, setOrigin] = useState(state.candidate?.origin ?? (state.capabilities?.challengePairing === true ? "" : "http://127.0.0.1:4318"));
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(() => state.defaultDeviceName ?? defaultDeviceName());
  const [insecureConfirmed, setInsecureConfirmed] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const actionRef = useRef<number | undefined>(undefined);
  const actionSequence = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; actionRef.current = undefined; };
  }, []);
  const [savedAutomaticChoices, setSavedAutomaticChoices] = useState<Readonly<Record<string, boolean>>>({});
  const [rememberAutomatically, setRememberAutomatically] = useState(
    state.capabilities?.challengePairing === true ? false : state.preferences.automaticConnectionTarget !== undefined
      || (state.automaticConnectionAvailable && state.managedOrchestratorStatus !== undefined && state.managedOrchestratorStatus.state !== "disabled")
  );
  const isConnecting = state.connectionState === "connecting";
  const actionsDisabled = busy !== undefined || state.busy === true || state.interactive === false;
  const challengePairing = state.capabilities?.challengePairing === true;
  const insecureLan = isInsecureLanOrigin(origin);
  const sessionOnlySecret = insecureLan && (state.sessionOnlyCredential ?? (window.jokoDesktop === undefined && !persistentWebSecretEncryptionAvailable()));
  const automaticEntryAvailable = state.automaticConnectionAvailable;
  const darkThemeActive = state.preferences.theme === "dark" || (state.preferences.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const themeTarget = darkThemeActive ? "light" : "dark";
  const themeToggleLabel = `${t("settings.theme")}: ${t(themeTarget === "light" ? "settings.light" : "settings.dark")}`;
  const toggleArtwork = (): void => dispatchView({ type: "toggleArtwork" });
  const runAction = (key: string, action: () => Promise<void>, onFailure?: () => void, onSuccess?: () => void): void => {
    if (actionRef.current !== undefined || state.interactive === false || (state.busy === true && key !== "cancel")) return;
    const request = ++actionSequence.current;
    actionRef.current = request;
    setLocalError(undefined);
    setBusy(key);
    void Promise.resolve().then(() => {
      if (mountedRef.current && actionRef.current === request) return action();
    }).then(() => {
      if (mountedRef.current && actionRef.current === request) onSuccess?.();
    }).catch((error: unknown) => {
      if (!mountedRef.current || actionRef.current !== request) return;
      onFailure?.();
      setLocalError(messageOf(error, t("error.unexpected")));
    }).finally(() => {
      if (actionRef.current !== request) return;
      actionRef.current = undefined;
      if (mountedRef.current) setBusy(undefined);
    });
  };
  const cycleTitleArtworkAndTheme = (): void => {
    if (actionsDisabled || actionRef.current !== undefined) return;
    dispatchView({ type: "nextArtworkGroup" });
    runAction("theme", () => controller.setTheme(themeTarget));
  };

  const sortedProfiles = useMemo(() => [...remoteProfiles].sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0)), [remoteProfiles]);
  const managedStatus = state.managedOrchestratorStatus;
  const managedRecoveryProfile = state.profiles.find((profile) => profile.managedLocal === true);
  const readyManagedProfile = managedStatus?.state === "ready"
    ? state.profiles.find((profile) => profile.managedLocal === true && profile.id === managedStatus.connection.profileId)
    : undefined;
  const discoveredNodes = managedStatus?.state === "ready"
    ? state.discoveredNodes.filter((node) => node.serverId !== managedStatus.connection.serverId)
    : state.discoveredNodes;
  const automaticTarget = state.preferences.automaticConnectionTarget;
  const rememberedProfile = automaticTarget?.kind === "profile" ? remoteProfiles.find((profile) => profile.id === automaticTarget.profileId) : undefined;
  const rememberedTargetUnavailable = automaticTarget?.kind === "profile"
    ? !remoteProfiles.some((profile) => profile.id === automaticTarget.profileId)
    : automaticTarget?.kind === "managedLocal"
      && (managedStatus === undefined || managedStatus.state === "disabled");
  const rawVisibleError = localError ?? state.error ?? (rememberedTargetUnavailable ? t("connection.rememberedTargetUnavailable") : undefined);
  const visibleError = rawVisibleError === undefined ? undefined : connectionFacingMessage(rawVisibleError);

  const openManagedRecovery = (): void => {
    if (managedRecoveryProfile !== undefined) {
      try {
        setOrigin(normalizeOrchestratorOrigin(managedRecoveryProfile.origin));
      } catch (error) {
        setLocalError(messageOf(error, t("error.unexpected")));
      }
    }
    setInsecureConfirmed(false);
    selectMode("pair");
  };

  const connect = (profile: ConnectionScreenProfile): void => {
    const automatic = profile.automatic === undefined ? rememberAutomatically : savedAutomaticChoices[profile.id] ?? profile.automatic;
    runAction(profile.id, () => controller.connect(profile, { automatic: automaticEntryAvailable ? automatic : undefined }));
  };

  const pair = (): void => {
    if (!code.trim() || !deviceName.trim() || !origin.trim() || (insecureLan && !insecureConfirmed)
      || (challengePairing && !challengeMatches)) return;
    runAction("pair", () => controller.pair(origin, code, deviceName, { automatic: automaticEntryAvailable ? rememberAutomatically : undefined }),
      undefined, () => setCode(""));
  };

  const setAutomaticChoice = (automatic: boolean): void => {
    if (actionsDisabled || actionRef.current !== undefined) return;
    setRememberAutomatically(automatic);
    if (automatic || state.preferences.automaticConnectionTarget === undefined) return;
    runAction("automatic", () => controller.setAutomaticConnectionEnabled(false), () => setRememberAutomatically(true));
  };

  const selectDiscovered = (selectedOrigin: string): void => {
    setOrigin(selectedOrigin);
    setInsecureConfirmed(false);
    selectMode("pair");
  };
  let normalizedOrigin: string | undefined;
  try { normalizedOrigin = normalizeOrchestratorOrigin(origin); } catch { /* Invalid drafts remain editable. */ }
  const candidate = state.candidate !== undefined && normalizedOrigin !== undefined && state.candidate.origin === normalizedOrigin ? state.candidate.node : undefined;
  const challengeMatches = candidate?.pairingEnabled === true && state.challenge !== undefined && state.challenge.origin === normalizedOrigin
    && state.challenge.deviceName === deviceName;
  const invalidatePairing = (): void => {
    if (!challengePairing) return;
    setCode("");
    try { controller.cancelPairing?.(); }
    catch (error) { setLocalError(messageOf(error, t("error.unexpected"))); }
  };
  const cancelConnection = (): void => {
    actionRef.current = undefined;
    runAction("cancel", () => controller.disconnect());
  };
  const cancelPairing = (): void => {
    actionRef.current = undefined;
    setCode("");
    runAction("cancel", async () => { controller.cancelPairing?.(); });
  };
  const connectingProfile = state.activeProfile ?? state.profiles.find((profile) => profile.id === busy);

  return (
    <main className="connection-screen">
      <IconButton className="connection-theme-toggle" label={themeToggleLabel} disabled={actionsDisabled} onClick={() => runAction("theme", () => controller.setTheme(themeTarget))}>
        {darkThemeActive ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      </IconButton>
      <span className="connection-curve-clip" aria-hidden="true"><span className="connection-curve-traces" /></span>
      <div className="connection-hero">
        <button
          className="connection-hero__artwork"
          type="button"
          data-artwork={artwork.id}
          aria-label={t("connection.toggleArtwork")}
          aria-pressed={artworkVariant === "alt"}
          onClick={toggleArtwork}
          onContextMenu={(event) => {
            event.preventDefault();
            toggleArtwork();
          }}
        >
          <img className="connection-hero__artwork-light" src={artwork.lightUrl} alt="" draggable={false} />
          <img className="connection-hero__artwork-dark" src={artwork.darkUrl} alt="" draggable={false} />
        </button>
      </div>

      <div className="connection-panel">
        <div className="connection-hero__copy">
          <div className="connection-title-lockup">
            <button className="connection-title-icon" type="button" aria-label={t("connection.nextArtworkGroup")} disabled={actionsDisabled} onClick={cycleTitleArtworkAndTheme} />
            <div className="connection-title-copy">
              <h1 id="joko-title">{t("app.name")}</h1>
              <p className="connection-hero__tagline">{t("app.tagline")}</p>
            </div>
          </div>
        </div>

        <section className="connection-card" aria-label={t("connection.method")} aria-busy={isConnecting || actionsDisabled}>
        {state.capabilities?.back === true && controller.goBack !== undefined && <Button tone="ghost" disabled={actionsDisabled || isConnecting}
          onClick={() => runAction("back", () => controller.goBack!())}>{state.labels?.back ?? t("common.back")}</Button>}
        {challengePairing && automaticTarget !== undefined && <div className="local-connection-card" data-automatic-connection>
          <div className="profile-card__icon"><Server aria-hidden="true" /></div>
          <div className="profile-card__body"><small>{state.labels?.automaticEntry ?? t("connection.rememberAutomatically")}</small>
            <strong>{rememberedProfile?.name ?? t(automaticTarget.kind === "managedLocal" ? "connection.thisComputer" : "connection.rememberedTargetUnavailable")}</strong></div>
          <Button disabled={actionsDisabled || isConnecting} onClick={() => runAction("automatic", () => controller.setAutomaticConnectionEnabled(false))}>
            {state.labels?.turnOff ?? t("common.disable")}</Button>
        </div>}
        {managedStatus !== undefined && managedStatus.state !== "disabled" && <div className="local-connection-card" data-state={managedStatus.state}>
          <div className="profile-card__icon"><Laptop aria-hidden="true" /></div>
          <div className="profile-card__body">
            <strong>{t("connection.thisComputer")}</strong>
            <span>{readyManagedProfile?.origin ?? managedOrchestratorStatusText(managedStatus, t)}</span>
            <small>{managedStatus.state === "recoveryRequired" ? t("managedOrchestrator.recoverySafety") : readyManagedProfile === undefined ? t("connection.localBundledHelp") : t("connection.localReady")}</small>
          </div>
          {managedStatus.state === "ready" && readyManagedProfile !== undefined ? <Button
            tone="primary"
            data-managed-local-connect
            onClick={() => connect(readyManagedProfile)}
            disabled={actionsDisabled}
          >
            {busy === readyManagedProfile.id ? <Spinner label={t("connection.connecting")} /> : <ArrowRight aria-hidden="true" />}
            {t("connection.connectLocal")}
          </Button> : managedStatus.state === "starting" ? <Button disabled><Spinner label={t("managedOrchestrator.startingTitle")} />{t("managedOrchestrator.startingTitle")}</Button> : managedStatus.state === "recoveryRequired" ? <div className="local-connection-card__actions">
            <Button disabled={actionsDisabled} onClick={() => runAction("managed", () => controller.retryManagedOrchestrator())}><RefreshCcw aria-hidden="true" />{t("common.retry")}</Button>
            <Button tone="primary" disabled={actionsDisabled} onClick={openManagedRecovery}><KeyRound aria-hidden="true" />{t("managedOrchestrator.recoverAccess")}</Button>
          </div> : <Button disabled={actionsDisabled} onClick={() => runAction("managed", () => controller.retryManagedOrchestrator())}><RefreshCcw aria-hidden="true" />{t("common.retry")}</Button>}
        </div>}
        <div className="connection-tabs" aria-label={t("connection.method")}>
          <button type="button" aria-pressed={mode === "nearby"} className={mode === "nearby" ? "is-active" : ""} onClick={() => selectMode("nearby")} disabled={actionsDisabled || isConnecting}>
            <Wifi aria-hidden="true" /> {t("connection.nearby")}
          </button>
          <button type="button" aria-pressed={mode === "saved"} className={mode === "saved" ? "is-active" : ""} onClick={() => selectMode("saved")} disabled={actionsDisabled || isConnecting || (remoteProfiles.length === 0 && state.capabilities?.recheckSaved !== true)}>
            <Server aria-hidden="true" /> {t("connection.savedNodes")}
          </button>
          <button type="button" aria-pressed={mode === "pair"} className={mode === "pair" ? "is-active" : ""} onClick={() => selectMode("pair")} disabled={actionsDisabled || isConnecting}>
            <KeyRound aria-hidden="true" /> {t("connection.add")}
          </button>
        </div>

        {visibleError !== undefined && <ErrorBanner message={visibleError} />}

        {isConnecting ? (
          <div className="connecting-state" role="status">
            <Spinner label={t("connection.connecting")} />
            <div><strong>{t("connection.connecting")}</strong><span>{connectingProfile?.name ?? candidate?.name ?? deviceName} · {connectingProfile?.origin ?? candidate?.origin ?? origin}</span></div>
            <Button tone="ghost" disabled={state.interactive === false || busy === "cancel"} onClick={cancelConnection}>{t("common.cancel")}</Button>
          </div>
        ) : mode === "nearby" ? (
          <div className="discovery-panel">
            <header className="discovery-panel__header">
              <strong>{t("connection.discovered")}</strong>
              <Button tone="ghost" onClick={() => runAction("discovery", () => controller.refreshDiscoveredNodes())} disabled={actionsDisabled || state.discoveryState === "discovering"}>
                {state.discoveryState === "discovering" ? <Spinner label={t("connection.discovering")} /> : <RefreshCcw aria-hidden="true" />}
                {t("common.refresh")}
              </Button>
            </header>
            {state.discoveryError !== undefined && <ErrorBanner message={connectionFacingMessage(state.discoveryError)} />}
            {state.discoveryState === "discovering" && discoveredNodes.length === 0 ? (
              <div className="discovery-empty" role="status"><Spinner label={t("connection.discovering")} /><span>{t("connection.discovering")}</span></div>
            ) : discoveredNodes.length === 0 ? (
              <div className="discovery-empty"><Wifi aria-hidden="true" /><strong>{t("connection.noneDiscovered")}</strong><span>{t("connection.discoveryFallback")}</span><Button disabled={actionsDisabled} onClick={() => selectMode("pair")}>{t("connection.enterManually")}</Button></div>
            ) : (
              <div className="profile-list">
                {discoveredNodes.map((node) => (
                  <article className="profile-card discovery-card" key={`${node.serverId}:${node.origin}`}>
                    <div className="profile-card__icon"><Server aria-hidden="true" /></div>
                    <div className="profile-card__body">
                      <strong>{node.name}</strong>
                      <span>{node.origin}</span>
                      <small>{node.version} · {node.pairingEnabled ? t("connection.pairingOpen") : t("connection.pairingClosed")}</small>
                    </div>
                    <Pill tone={node.transport === "https" ? "success" : node.transport === "lanHttp" ? "warning" : "neutral"}>{node.transport === "https" ? "HTTPS" : node.transport === "lanHttp" ? t("connection.lanHttp") : t("connection.localHttp")}</Pill>
                    <Button tone="primary" disabled={actionsDisabled} onClick={() => selectDiscovered(node.origin)}>{t("connection.useNode")}</Button>
                  </article>
                ))}
              </div>
            )}
          </div>
        ) : mode === "saved" ? (
          <div className="profile-list">
            {state.capabilities?.recheckSaved === true && controller.recheckSavedProfiles !== undefined && <header className="discovery-panel__header">
              <strong>{t("connection.savedNodes")}</strong><Button tone="ghost" disabled={actionsDisabled || sortedProfiles.some((profile) => profile.credentialState === "checking")}
                onClick={() => runAction("recheck", () => controller.recheckSavedProfiles!())}><RefreshCcw aria-hidden="true" />{state.labels?.recheckSaved ?? t("common.refresh")}</Button>
            </header>}
            {sortedProfiles.length === 0 && <div className="discovery-empty">{t("connection.empty")}</div>}
            {sortedProfiles.map((profile) => (
              <article className="profile-card" key={profile.id}>
                <div className="profile-card__icon"><Server aria-hidden="true" /></div>
                <div className="profile-card__body">
                  <strong>{profile.name}</strong>
                  <span>{profile.origin}</span>
                  {profile.identityLabel !== undefined && <small>{profile.identityLabel}</small>}
                  {profile.lastConnectedAt !== undefined && <small>{t("connection.lastUsed", { time: formatRelativeTime(profile.lastConnectedAt, state.effectiveLocale ?? "en") })}</small>}
                  {profile.statusLabel !== undefined && <small role="status">{profile.statusLabel}</small>}
                  {profile.error !== undefined && <small role="alert">{profile.error}</small>}
                  {(profile.pendingCount ?? 0) > 0 && <small role="alert">{profile.pendingLabel ?? String(profile.pendingCount)}</small>}
                  {profile.automatic !== undefined && <label className="connection-auto-choice">
                    <CheckboxControl checked={savedAutomaticChoices[profile.id] ?? profile.automatic} disabled={actionsDisabled || isConnecting || !automaticEntryAvailable}
                      onChange={(event) => setSavedAutomaticChoices((choices) => ({ ...choices, [profile.id]: event.target.checked }))} />
                    <span><strong>{t("connection.rememberAutomatically")}</strong><small>{t("connection.rememberAutomaticallyHelp")}</small></span>
                  </label>}
                </div>
                <Button tone="primary" onClick={() => connect(profile)} disabled={actionsDisabled || profile.credentialState === "checking"}>
                  {busy === profile.id ? <Spinner label={t("connection.connecting")} /> : <ArrowRight aria-hidden="true" />}
                  {t("connection.connect")}
                </Button>
                {profile.managedLocal !== true && <IconButton className="profile-card__forget" label={t("connection.forget", { name: profile.name })} disabled={actionsDisabled}
                  onClick={() => runAction("forget", () => controller.forgetProfile(profile.id))}>
                  <Trash2 aria-hidden="true" />
                </IconButton>}
              </article>
            ))}
          </div>
        ) : (
          <form className="pair-form" onSubmit={(event) => { event.preventDefault(); pair(); }}>
            <div className="pair-form__intro">
              <Laptop aria-hidden="true" />
              <div><strong>{t("connection.pair")}</strong><p>{state.labels?.pairingHelp ?? t("connection.pairHelp")}</p></div>
            </div>
            <label>
              <span>{t("connection.origin")}</span>
              <input type="url" inputMode="url" required disabled={actionsDisabled} value={origin} onChange={(event) => { setOrigin(event.target.value); setInsecureConfirmed(false); invalidatePairing(); }} placeholder="http://192.168.1.20:4318" autoComplete="url" />
              <small>{t("connection.secureHint")}</small>
            </label>
            {insecureLan && <div className="lan-http-warning" role="note">
              <AlertTriangle aria-hidden="true" />
              <div><strong>{t("connection.insecureLanTitle")}</strong><p>{t("connection.insecureLanBody")}</p>{sessionOnlySecret && <p>{t("connection.sessionOnlySecret")}</p>}</div>
            </div>}
            {insecureLan && <label className="lan-http-confirm">
              <CheckboxControl checked={insecureConfirmed} disabled={actionsDisabled} onChange={(event) => setInsecureConfirmed(event.target.checked)} />
              <span>{t("connection.insecureLanConfirm")}</span>
            </label>}
            {challengePairing && <>
              <Button disabled={actionsDisabled || normalizedOrigin === undefined || controller.inspect === undefined}
                onClick={() => runAction("inspect", () => controller.inspect!(origin))}>{busy === "inspect" && <Spinner label={state.labels?.checking ?? t("connection.connecting")} />}{state.labels?.inspect ?? t("connection.properties")}</Button>
              {candidate !== undefined && <div className="profile-card__body" role="status">
                <strong>{candidate.name}</strong><span>{candidate.identityLabel ?? candidate.serverId}</span>
                <small>{candidate.summaryLabel ?? `${candidate.version} · ${t(candidate.pairingEnabled ? "connection.pairingOpen" : "connection.pairingClosed")}`}</small>
              </div>}
            </>}
            <div className="pair-form__row">
              {(!challengePairing || challengeMatches) && <label>
                <span>{t("connection.code")}</span>
                <input required disabled={actionsDisabled} value={code} onChange={(event) => setCode(event.target.value)} placeholder="XXXX-XXXX" autoComplete="one-time-code" spellCheck={false} />
              </label>}
              <label>
                <span>{t("connection.deviceName")}</span>
                <input required disabled={actionsDisabled} value={deviceName} onChange={(event) => { setDeviceName(event.target.value); invalidatePairing(); }} autoComplete="off" />
              </label>
            </div>
            {challengePairing && <>
              <Button disabled={actionsDisabled || candidate?.pairingEnabled !== true || !deviceName.trim() || controller.requestPairing === undefined}
                onClick={() => { setCode(""); runAction("challenge", () => controller.requestPairing!(origin, deviceName)); }}>
                {busy === "challenge" && <Spinner label={t("connection.connecting")} />}{state.labels?.requestPairing ?? t("connection.pair")}
              </Button>
              {challengeMatches && <p role="status">{state.labels?.challengeHint ?? t("connection.pairHelp")}</p>}
            </>}
            <Button type="submit" tone="primary" className="pair-form__submit" disabled={actionsDisabled || origin.trim() === "" || code.trim() === "" || deviceName.trim() === "" || (insecureLan && !insecureConfirmed) || (challengePairing && !challengeMatches)}>
              {busy === "pair" ? <Spinner label={t("connection.connecting")} /> : <KeyRound aria-hidden="true" />}
              {t("connection.pair")}
            </Button>
            {challengePairing && controller.cancelPairing !== undefined && (busy === "inspect" || busy === "challenge" || busy === "pair") && <Button tone="ghost"
              disabled={state.interactive === false} onClick={cancelPairing}>{t("common.cancel")}</Button>}
          </form>
        )}
        {(!challengePairing || mode !== "saved") && <label className="connection-auto-choice">
          <CheckboxControl
            checked={rememberAutomatically}
            disabled={actionsDisabled || isConnecting || (!automaticEntryAvailable && !rememberAutomatically)}
            onChange={(event) => setAutomaticChoice(event.target.checked)}
          />
          <span><strong>{t("connection.rememberAutomatically")}</strong><small>{t(automaticEntryAvailable ? "connection.rememberAutomaticallyHelp" : "connection.rememberAutomaticallyUnavailable")}</small></span>
        </label>}
        </section>
      </div>
    </main>
  );
}

function managedOrchestratorStatusText(status: ConnectionScreenManagedStatus, t: Translator): string {
  if (status.state === "ready") return t("connection.localReady");
  if (status.state === "disabled") return t("common.disabled");
  if (status.state === "starting") return t("managedOrchestrator.startingTitle");
  if (status.reason === "serviceUnavailable") return t("managedOrchestrator.serviceUnavailable");
  if (status.reason === "startFailed") return t("managedOrchestrator.startFailed");
  if (status.reason === "credentialUnavailable") return t("managedOrchestrator.credentialUnavailable");
  if (status.reason === "credentialRejected") return t("managedOrchestrator.credentialRejected");
  return t("managedOrchestrator.identityConflict");
}

type ConnectionMode = ConnectionScreenMode;

interface ConnectionViewState {
  readonly mode: ConnectionMode;
  readonly artworkGroupIndex: number;
  readonly artworkVariant: ConnectionArtworkVariant;
}

type ConnectionViewAction =
  | { readonly type: "selectMode"; readonly mode: ConnectionMode }
  | { readonly type: "toggleArtwork" }
  | { readonly type: "nextArtworkGroup" };

function connectionViewReducer(state: ConnectionViewState, action: ConnectionViewAction): ConnectionViewState {
  if (action.type === "toggleArtwork") {
    return { ...state, artworkVariant: state.artworkVariant === "base" ? "alt" : "base" };
  }
  if (action.type === "nextArtworkGroup") {
    return {
      ...state,
      artworkGroupIndex: nextConnectionArtworkGroupIndex(state.artworkGroupIndex),
      artworkVariant: "base"
    };
  }
  if (state.mode === action.mode) return state;
  return {
    mode: action.mode,
    artworkGroupIndex: nextConnectionArtworkGroupIndex(state.artworkGroupIndex),
    artworkVariant: "base"
  };
}

function defaultDeviceName(): string {
  const platform = (navigator as Navigator & { readonly userAgentData?: { readonly platform?: string } }).userAgentData?.platform ?? navigator.platform;
  return `${platform || "Web"} browser`;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function connectionFacingMessage(message: string): string {
  return message.replace(/\borchestrator\b/giu, "Joko node");
}
