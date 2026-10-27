import { useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { allowsUnpinnedEndpoint, normalizeEndpointPublicKey, parseTrustedNodeInvitation, rememberEndpointTrust, replaceEndpointTrust, type EndpointTrust } from "@joko/connection-transport/trust";
import type { JSX } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, KeyRound, Laptop, Moon, RefreshCcw, Server, SlidersHorizontal, Sun, Trash2, Wifi } from "lucide-react";
import { connectionArtworkGroupAt, nextConnectionArtworkGroupIndex } from "../connection-artwork.js";
import type { ConnectionArtworkVariant } from "../connection-artwork.js";
import type { ConnectionScreenController, ConnectionScreenManagedStatus, ConnectionScreenMode, ConnectionScreenProfile } from "../connection-contract.js";
import { isInsecureLanOrigin, normalizeOrchestratorOrigin } from "../connection-origin.js";
import { persistentWebSecretEncryptionAvailable } from "../web-crypto.js";
import type { Translator } from "./types.js";
import { Button, ErrorBanner, IconButton, Pill, Spinner, formatRelativeTime, CheckboxControl } from "./ui.js";
import { DeviceAuthorizationEntry } from './DeviceAuthorizationEntry.js';
import { ConnectionEntries } from './ConnectionEntries.js';

export function ConnectionScreen({ controller, t, initialInvitation }: { readonly controller: ConnectionScreenController; readonly t: Translator; readonly initialInvitation?: string }): JSX.Element {
  const { state } = controller;
  const originHintId = useId();
  const remoteProfiles = useMemo(() => {
    const nodes = new Map<string, ConnectionScreenProfile>();
    for (const profile of state.profiles.filter(p => p.managedLocal !== true)) {
      const key = profile.endpointPublicKey ? JSON.stringify([profile.serverId, profile.endpointPublicKey]) : profile.id;
      const prior = nodes.get(key);
      if (!prior || profile.id === state.activeProfile?.id || prior.id !== state.activeProfile?.id && (profile.lastConnectedAt ?? 0) > (prior.lastConnectedAt ?? 0)) nodes.set(key, profile);
    }
    return [...nodes.values()];
  }, [state.profiles, state.activeProfile?.id]);
  const [{ mode, artworkGroupIndex, artworkVariant }, dispatchView] = useReducer(connectionViewReducer, {
    mode: state.initialMode ?? (remoteProfiles.length === 0 ? "nearby" : "saved"),
    artworkGroupIndex: 0,
    artworkVariant: "base"
  });
  const artworkGroup = connectionArtworkGroupAt(artworkGroupIndex);
  useEffect(() => {
    if (initialInvitation ?? state.invitationLink) { setManualOpen(false); dispatchView({ type: 'selectMode', mode: 'pair' }); }
  }, [initialInvitation, state.invitationLink]);
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
  const [discoveredNode, setDiscoveredNode] = useState<ConnectionScreenController['state']['discoveredNodes'][number]>();
  const [code, setCode] = useState("");
  const [trustedIdentity, setTrustedIdentity] = useState("");
  const [clientPublicKey, setClientPublicKey] = useState('');
  const [httpTransportMode, setHttpTransportMode] = useState<'https' | 'webrtc'>();
  const selectedTransport = useMemo(() => {
    try {
      const kind = trustedIdentity.trim().startsWith('{') ? parseTrustedNodeInvitation(trustedIdentity).endpointTransport?.kind : undefined;
      return kind === 'iroh' || kind === 'tailcat' || kind === 'http-connect' ? kind : httpTransportMode === 'https' ? undefined : httpTransportMode ?? kind;
    } catch { return httpTransportMode === 'webrtc' ? 'webrtc' : undefined; }
  }, [trustedIdentity, httpTransportMode]);
  const mobileIroh = state.capabilities?.irohNativeAvailable !== undefined;
  const [irohMobileMode, setIrohMobileMode] = useState<'native' | 'relay'>(state.capabilities?.irohNativeAvailable === true ? 'native' : 'relay');
  const clientBindingAvailable = selectedTransport === 'http-connect' ? state.capabilities?.httpConnectNativeAvailable === true || window.jokoDesktop?.linkspan !== undefined
    : selectedTransport === 'webrtc' ? state.capabilities?.webRtcAvailable !== false : selectedTransport === 'tailcat' ? state.capabilities?.tailcatRelayAvailable !== false
    : !mobileIroh || (irohMobileMode === 'native' ? state.capabilities?.irohNativeAvailable === true : state.capabilities?.irohRelayAvailable === true);
  const [replaceIdentity, setReplaceIdentity] = useState(false);
  const prepareTrust = async (): Promise<void> => {
    if (trustedIdentity.trim() === "") {
      if (selectedTransport === 'webrtc' || !allowsUnpinnedEndpoint(origin)) throw new Error(t("connection.trustedKeyRequired"));
      return;
    }
    const pin: EndpointTrust & { readonly endpointPublicKey: string } = trustedIdentity.trim().startsWith("{")
      ? parseTrustedNodeInvitation(trustedIdentity) : { origin: normalizeOrchestratorOrigin(origin), endpointPublicKey: normalizeEndpointPublicKey(trustedIdentity) };
    if (pin.origin !== normalizeOrchestratorOrigin(origin)) throw new Error(t("connection.invitationOriginMismatch"));
    const endpointTransport = pin.endpointTransport?.kind === 'iroh' && mobileIroh ? { ...pin.endpointTransport, mobileMode: irohMobileMode }
      : selectedTransport === 'webrtc' ? { kind: 'webrtc' as const } : pin.endpointTransport?.kind === 'webrtc' ? undefined : pin.endpointTransport;
    if (endpointTransport?.kind === 'iroh' && endpointTransport.relayUrls?.length === 0 && window.jokoDesktop?.linkspan === undefined && (!mobileIroh || irohMobileMode !== 'native')) throw new Error(t('connection.irohDirectOnly'));
    if (endpointTransport !== undefined && !clientBindingAvailable) throw new Error(t('connection.sdkNotDelivered'));
    if (endpointTransport?.kind === 'iroh' && mobileIroh && endpointTransport.mobileMode === 'native' && state.capabilities?.irohNativeAvailable !== true) throw new Error(t('connection.irohNativeUnavailable'));
    if (clientPublicKey !== '' && pin.endpointTransport?.kind === 'iroh' && pin.endpointTransport.relayToken !== undefined && pin.endpointTransport.clientEndpointId !== clientPublicKey) throw new Error(t('connection.irohClientLeaseRequired'));
    if (controller.trustEndpoint) await controller.trustEndpoint(pin.origin, pin.endpointPublicKey, replaceIdentity, pin.serverId, endpointTransport);
    else if (replaceIdentity) replaceEndpointTrust({ ...pin, endpointTransport, transportKind: endpointTransport?.kind ?? 'https' });
    else rememberEndpointTrust({ ...pin, endpointTransport, transportKind: endpointTransport?.kind ?? 'https' });
  };
  const [deviceName, setDeviceName] = useState(() => state.defaultDeviceName ?? defaultDeviceName());
  const [manualOpen, setManualOpen] = useState(controller.deviceAuthorization === undefined);
  const [authorizationStage, setAuthorizationStage] = useState<'choice' | 'invite' | 'pending'>('choice');
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
  const automaticChoiceKey = state.preferences.automaticConnectionTarget?.kind === 'profile'
    ? `profile:${state.preferences.automaticConnectionTarget.profileId}` : state.preferences.automaticConnectionTarget?.kind;
  const lastAutomaticChoice = useRef(automaticChoiceKey);
  useEffect(() => {
    if (lastAutomaticChoice.current === automaticChoiceKey) return;
    lastAutomaticChoice.current = automaticChoiceKey;
    setRememberAutomatically(automaticChoiceKey !== undefined);
    setSavedAutomaticChoices({});
  }, [automaticChoiceKey]);
  const isConnecting = state.connectionState === "connecting";
  const actionsDisabled = busy !== undefined || state.busy === true || state.interactive === false;
  const challengePairing = state.capabilities?.challengePairing === true;
  const insecureLan = isInsecureLanOrigin(origin) && trustedIdentity.trim() === "";
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
    runAction("pair", async () => { await prepareTrust(); await controller.pair(origin, code, deviceName, { automatic: automaticEntryAvailable ? rememberAutomatically : undefined }); },
      undefined, () => setCode(""));
  };

  const setAutomaticChoice = (automatic: boolean): void => {
    if (actionsDisabled || actionRef.current !== undefined) return;
    setRememberAutomatically(automatic);
    if (automatic || state.preferences.automaticConnectionTarget === undefined) return;
    runAction("automatic", () => controller.setAutomaticConnectionEnabled(false), () => setRememberAutomatically(true));
  };

  const selectDiscovered = (selectedOrigin: string): void => {
    setDiscoveredNode(state.discoveredNodes.find(node => node.origin === selectedOrigin));
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
    try { void Promise.resolve(controller.cancelPairing?.()).catch(error => setLocalError(messageOf(error, t("error.unexpected")))); }
    catch (error) { setLocalError(messageOf(error, t("error.unexpected"))); }
  };
  const cancelConnection = (): void => {
    actionRef.current = undefined;
    runAction("cancel", () => controller.disconnect());
  };
  const cancelPairing = (): void => {
    actionRef.current = undefined;
    setCode("");
    runAction("cancel", async () => { await controller.cancelPairing?.(); });
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
              <div className="discovery-empty"><Wifi aria-hidden="true" /><strong>{t("connection.noneDiscovered")}</strong><span>{t(controller.deviceAuthorization ? "authorization.linkHelp" : "connection.discoveryFallback")}</span><Button disabled={actionsDisabled} onClick={() => selectMode("pair")}>{t(controller.deviceAuthorization ? "entries.chooseMethod" : "connection.enterManually")}</Button></div>
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
                {profile.transportKind === 'iroh' && mobileIroh && controller.setProfileIrohMode !== undefined && <>
                  <Button disabled={actionsDisabled || state.capabilities?.irohNativeAvailable !== true} onClick={() => runAction('iroh-native', () => controller.setProfileIrohMode!(profile.id, 'native'))}>{t('connection.irohNativeMode')}</Button>
                  <Button disabled={actionsDisabled || state.capabilities?.irohRelayAvailable !== true} onClick={() => runAction('iroh-relay', () => controller.setProfileIrohMode!(profile.id, 'relay'))}>{t('connection.irohRelayMode')}</Button>
                </>}
                {profile.managedLocal !== true && <IconButton className="profile-card__forget" label={t("connection.forget", { name: profile.name })} disabled={actionsDisabled}
                  onClick={() => runAction("forget", () => controller.forgetProfile(profile.id))}>
                  <Trash2 aria-hidden="true" />
                </IconButton>}
                <ConnectionEntries profile={profile} controller={controller} t={t} disabled={actionsDisabled} run={runAction} />
              </article>
            ))}
          </div>
        ) : (
          <>
          {controller.deviceAuthorization && !manualOpen && <DeviceAuthorizationEntry controller={controller} t={t} defaultName={deviceName} initialInvitation={initialInvitation ?? state.invitationLink} automatic={automaticEntryAvailable ? rememberAutomatically : undefined} onStageChange={setAuthorizationStage} discoveredNode={discoveredNode} onClearDiscovered={() => setDiscoveredNode(undefined)} />}
          {(controller.deviceAuthorization === undefined || manualOpen || authorizationStage === 'choice') && <details className="device-authorization__manual" open={manualOpen} onToggle={event => setManualOpen(event.currentTarget.open)}>
          <summary aria-label={t(manualOpen ? 'authorization.chooseAnother' : 'authorization.manual')}>
            {manualOpen ? <><ArrowLeft aria-hidden="true" /><span>{t('authorization.chooseAnother')}</span></> : <>
              <span className="connection-method__icon"><SlidersHorizontal aria-hidden="true" /></span>
              <span><strong>{t('authorization.manual')}</strong><small>{t('authorization.manualHelp')}</small></span><ArrowRight aria-hidden="true" />
            </>}
          </summary>
          <form className="pair-form" onSubmit={(event) => { event.preventDefault(); pair(); }}>
            <div className="pair-form__intro">
              <Laptop aria-hidden="true" />
              <div><strong>{t("connection.pair")}</strong><p>{state.labels?.pairingHelp ?? t("connection.pairHelp")}</p></div>
            </div>
            <label>
              <span>{t("connection.origin")}</span>
              <input type="url" inputMode="url" aria-label={t("connection.origin")} aria-describedby={originHintId} required disabled={actionsDisabled} value={origin} onChange={(event) => { setOrigin(event.target.value); setInsecureConfirmed(false); invalidatePairing(); }} placeholder="http://192.168.1.20:4318" autoComplete="url" />
              <small id={originHintId}>{t("connection.secureHint")}</small>
            </label>
            <label>
              <span>{t("connection.trustedIdentity")}</span>
              <textarea aria-label={t("connection.trustedIdentity")} disabled={actionsDisabled} value={trustedIdentity} maxLength={32768}
                onChange={event => { const value = event.target.value; setTrustedIdentity(value); setClientPublicKey(''); setReplaceIdentity(false); invalidatePairing();
                  if (value.trim().startsWith("{")) { setHttpTransportMode(undefined); try { setOrigin(parseTrustedNodeInvitation(value).origin); } catch { /* Keep incomplete invitation drafts editable. */ } }
                  else if (selectedTransport === 'webrtc') setHttpTransportMode('webrtc'); }}
                placeholder="ed25519:…" autoComplete="off" spellCheck={false} />
              <small>{t("connection.trustedIdentityHelp")}</small>
              {selectedTransport !== undefined && <small role="note">{t(selectedTransport === 'http-connect' ? 'connection.transportHttpConnectHelp' : selectedTransport === 'webrtc' ? 'connection.transportWebRtcHelp' : selectedTransport === 'iroh' ? 'connection.transportIrohHelp' : 'connection.transportTailcatHelp')}</small>}
              {selectedTransport === 'http-connect' && !clientBindingAvailable && <small role="note">{t('connection.httpConnectNativeRequired')}</small>}
            </label>
            {(selectedTransport === undefined || selectedTransport === 'webrtc') && <div className="connection-transport-choice" role="group" aria-label={t('connection.transport')}>
              <button type="button" aria-pressed={selectedTransport === undefined} className={selectedTransport === undefined ? 'is-active' : ''} disabled={actionsDisabled}
                onClick={() => { setHttpTransportMode('https'); invalidatePairing(); }}>HTTPS / WSS</button>
              <button type="button" aria-pressed={selectedTransport === 'webrtc'} className={selectedTransport === 'webrtc' ? 'is-active' : ''}
                disabled={actionsDisabled || state.capabilities?.webRtcAvailable === false}
                onClick={() => { setHttpTransportMode('webrtc'); invalidatePairing(); }}>WebRTC</button>
            </div>}
            {mobileIroh && (selectedTransport === undefined || selectedTransport === 'iroh') && <label><span>{t('connection.irohMobileMode')}</span>
              <select aria-label={t('connection.irohMobileMode')} value={irohMobileMode} disabled={actionsDisabled} onChange={event => { setIrohMobileMode(event.target.value === 'native' ? 'native' : 'relay'); invalidatePairing(); }}>
                <option value="native" disabled={state.capabilities?.irohNativeAvailable !== true}>{t('connection.irohNativeMode')}</option>
                <option value="relay" disabled={state.capabilities?.irohRelayAvailable !== true}>{t('connection.irohRelayMode')}</option>
              </select><small>{t(state.capabilities?.irohNativeAvailable === true ? 'connection.irohMobileModeHelp' : 'connection.irohNativeUnavailable')}</small>
            </label>}
            <details className="pair-form__advanced"><summary>{t('authorization.advanced')}</summary><div>
            {selectedTransport !== 'webrtc' && selectedTransport !== 'http-connect' && (selectedTransport === 'tailcat' ? controller.createTailcatClient : controller.createIrohClient) !== undefined && <>
              {selectedTransport === undefined && <small>{t('connection.irohBeforeInvitationHelp')}</small>}
              <Button disabled={actionsDisabled || !clientBindingAvailable} onClick={() => runAction('client-identity', async () => {
                let result: { readonly publicKey: string };
                if (selectedTransport === undefined) result = await controller.createIrohClient!(undefined, undefined, undefined, mobileIroh ? irohMobileMode : undefined);
                else {
                  const invitation = parseTrustedNodeInvitation(trustedIdentity);
                  if (invitation.endpointTransport === undefined) throw new Error(t('connection.trustedKeyRequired'));
                  result = invitation.endpointTransport.kind === 'tailcat'
                    ? await controller.createTailcatClient!(invitation.origin, invitation.endpointPublicKey, invitation.endpointTransport)
                    : await controller.createIrohClient!(invitation.origin, invitation.endpointPublicKey, invitation.endpointTransport, mobileIroh ? irohMobileMode : undefined);
                }
                if (mountedRef.current) setClientPublicKey(result.publicKey);
              })}>{t(selectedTransport === 'tailcat' ? 'connection.createTailcatClient' : 'connection.createIrohClient')}</Button>
              {!clientBindingAvailable && <small>{t('connection.sdkNotDelivered')}</small>}
              {clientPublicKey !== '' && <label><span>{t(selectedTransport === 'tailcat' ? 'connection.tailcatPublicKey' : 'connection.irohPublicKey')}</span><input readOnly value={clientPublicKey} aria-label={t(selectedTransport === 'tailcat' ? 'connection.tailcatPublicKey' : 'connection.irohPublicKey')} /><small>{t(selectedTransport === 'tailcat' ? 'connection.tailcatAllowlistHelp' : 'connection.irohLeaseHelp')}</small></label>}
            </>}
            <label className="connection-checkbox"><CheckboxControl checked={replaceIdentity} disabled={actionsDisabled}
              onChange={event => setReplaceIdentity(event.target.checked)} /><span>{t("connection.replaceIdentity")}</span></label>
            </div></details>
            {insecureLan && <div className="lan-http-warning" role="note">
              <AlertTriangle aria-hidden="true" />
              <div><strong>{t("connection.insecureLanTitle")}</strong><p>{t("connection.insecureLanBody")}</p>{sessionOnlySecret && <p>{t("connection.sessionOnlySecret")}</p>}</div>
            </div>}
            {insecureLan && <label className="lan-http-confirm">
              <CheckboxControl checked={insecureConfirmed} disabled={actionsDisabled} onChange={(event) => setInsecureConfirmed(event.target.checked)} />
              <span>{t("connection.insecureLanConfirm")}</span>
            </label>}
            {challengePairing && <>
              <Button disabled={actionsDisabled || normalizedOrigin === undefined || controller.inspect === undefined || (insecureLan && !insecureConfirmed)}
                onClick={() => runAction("inspect", async () => { await prepareTrust(); await controller.inspect!(origin); })}>{busy === "inspect" && <Spinner label={state.labels?.checking ?? t("connection.connecting")} />}{state.labels?.inspect ?? t("connection.properties")}</Button>
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
              <Button disabled={actionsDisabled || candidate?.pairingEnabled !== true || !deviceName.trim() || controller.requestPairing === undefined || (insecureLan && !insecureConfirmed)}
                onClick={() => { setCode(""); runAction("challenge", async () => { await prepareTrust(); await controller.requestPairing!(origin, deviceName); }); }}>
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
          </details>}
          </>
        )}
        {(!challengePairing || mode !== "saved") && (mode !== 'pair' || manualOpen || authorizationStage !== 'choice') && <label className="connection-auto-choice">
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
