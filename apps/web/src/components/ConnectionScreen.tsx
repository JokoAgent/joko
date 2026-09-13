import { useMemo, useReducer, useState } from "react";
import type { JSX } from "react";
import { AlertTriangle, ArrowRight, KeyRound, Laptop, Moon, RefreshCcw, Server, Sun, Trash2, Wifi } from "lucide-react";
import { connectionArtworkGroupAt, nextConnectionArtworkGroupIndex } from "../connection-artwork.js";
import type { ConnectionArtworkVariant } from "../connection-artwork.js";
import type { AppController } from "../controller.js";
import { isInsecureLanOrigin, normalizeOrchestratorOrigin } from "../connection-origin.js";
import type { ConnectionProfile } from "../model.js";
import { persistentWebSecretEncryptionAvailable } from "../web-crypto.js";
import type { Translator } from "./types.js";
import { Button, ErrorBanner, IconButton, Pill, Spinner, formatRelativeTime, CheckboxControl } from "./ui.js";

export function ConnectionScreen({ controller, t }: { readonly controller: AppController; readonly t: Translator }): JSX.Element {
  const { state } = controller;
  const remoteProfiles = useMemo(() => state.profiles.filter((profile) => profile.managedLocal !== true), [state.profiles]);
  const [{ mode, artworkGroupIndex, artworkVariant }, dispatchView] = useReducer(connectionViewReducer, {
    mode: remoteProfiles.length === 0 ? "nearby" : "saved",
    artworkGroupIndex: 0,
    artworkVariant: "base"
  });
  const artworkGroup = connectionArtworkGroupAt(artworkGroupIndex);
  const artwork = artworkGroup[artworkVariant];
  const selectMode = (nextMode: ConnectionMode): void => {
    controller.cancelAutomaticConnectionAttempt();
    dispatchView({ type: "selectMode", mode: nextMode });
  };
  const [origin, setOrigin] = useState("http://127.0.0.1:4318");
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(() => defaultDeviceName());
  const [insecureConfirmed, setInsecureConfirmed] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [rememberAutomatically, setRememberAutomatically] = useState(
    state.preferences.automaticConnectionTarget !== undefined
      || (state.automaticConnectionAvailable && state.managedOrchestratorStatus !== undefined && state.managedOrchestratorStatus.state !== "disabled")
  );
  const isConnecting = state.connectionState === "connecting";
  const insecureLan = isInsecureLanOrigin(origin);
  const sessionOnlySecret = insecureLan && window.jokoDesktop === undefined && !persistentWebSecretEncryptionAvailable();
  const automaticEntryAvailable = state.automaticConnectionAvailable;
  const darkThemeActive = state.preferences.theme === "dark" || (state.preferences.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const themeTarget = darkThemeActive ? "light" : "dark";
  const themeToggleLabel = `${t("settings.theme")}: ${t(themeTarget === "light" ? "settings.light" : "settings.dark")}`;
  const toggleArtwork = (): void => dispatchView({ type: "toggleArtwork" });
  const cycleTitleArtworkAndTheme = (): void => {
    dispatchView({ type: "nextArtworkGroup" });
    void controller.setTheme(themeTarget);
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

  const connect = (profile: ConnectionProfile): void => {
    setLocalError(undefined);
    setBusy(profile.id);
    void controller.connect(profile, { automatic: automaticEntryAvailable ? rememberAutomatically : undefined }).catch((error: unknown) => setLocalError(messageOf(error, t("error.unexpected")))).finally(() => setBusy(undefined));
  };

  const pair = (): void => {
    setLocalError(undefined);
    setBusy("pair");
    void controller.pair(origin, code, deviceName, { automatic: automaticEntryAvailable ? rememberAutomatically : undefined }).catch((error: unknown) => setLocalError(messageOf(error, t("error.unexpected")))).finally(() => setBusy(undefined));
  };

  const setAutomaticChoice = (automatic: boolean): void => {
    setRememberAutomatically(automatic);
    if (automatic || state.preferences.automaticConnectionTarget === undefined) return;
    void controller.setAutomaticConnectionEnabled(false).catch((error: unknown) => {
      setRememberAutomatically(true);
      setLocalError(messageOf(error, t("error.unexpected")));
    });
  };

  const selectDiscovered = (selectedOrigin: string): void => {
    setOrigin(selectedOrigin);
    setInsecureConfirmed(false);
    selectMode("pair");
  };

  return (
    <main className="connection-screen">
      <IconButton className="connection-theme-toggle" label={themeToggleLabel} onClick={() => void controller.setTheme(themeTarget)}>
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
            <button className="connection-title-icon" type="button" aria-label={t("connection.nextArtworkGroup")} onClick={cycleTitleArtworkAndTheme} />
            <div className="connection-title-copy">
              <h1 id="joko-title">{t("app.name")}</h1>
              <p className="connection-hero__tagline">{t("app.tagline")}</p>
            </div>
          </div>
        </div>

        <section className="connection-card" aria-label={t("connection.method")} aria-busy={isConnecting}>
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
            disabled={busy !== undefined}
          >
            {busy === readyManagedProfile.id ? <Spinner label={t("connection.connecting")} /> : <ArrowRight aria-hidden="true" />}
            {t("connection.connectLocal")}
          </Button> : managedStatus.state === "starting" ? <Button disabled><Spinner label={t("managedOrchestrator.startingTitle")} />{t("managedOrchestrator.startingTitle")}</Button> : managedStatus.state === "recoveryRequired" ? <div className="local-connection-card__actions">
            <Button onClick={() => void controller.retryManagedOrchestrator()}><RefreshCcw aria-hidden="true" />{t("common.retry")}</Button>
            <Button tone="primary" onClick={openManagedRecovery}><KeyRound aria-hidden="true" />{t("managedOrchestrator.recoverAccess")}</Button>
          </div> : <Button onClick={() => void controller.retryManagedOrchestrator()}><RefreshCcw aria-hidden="true" />{t("common.retry")}</Button>}
        </div>}
        <div className="connection-tabs" aria-label={t("connection.method")}>
          <button type="button" aria-pressed={mode === "nearby"} className={mode === "nearby" ? "is-active" : ""} onClick={() => selectMode("nearby")} disabled={isConnecting}>
            <Wifi aria-hidden="true" /> {t("connection.nearby")}
          </button>
          <button type="button" aria-pressed={mode === "saved"} className={mode === "saved" ? "is-active" : ""} onClick={() => selectMode("saved")} disabled={isConnecting || remoteProfiles.length === 0}>
            <Server aria-hidden="true" /> {t("connection.savedNodes")}
          </button>
          <button type="button" aria-pressed={mode === "pair"} className={mode === "pair" ? "is-active" : ""} onClick={() => selectMode("pair")} disabled={isConnecting}>
            <KeyRound aria-hidden="true" /> {t("connection.add")}
          </button>
        </div>

        {visibleError !== undefined && <ErrorBanner message={visibleError} />}

        {isConnecting && state.activeProfile !== undefined ? (
          <div className="connecting-state" role="status">
            <Spinner label={t("connection.connecting")} />
            <div><strong>{t("connection.connecting")}</strong><span>{state.activeProfile.name} · {state.activeProfile.origin}</span></div>
            <Button tone="ghost" onClick={() => void controller.disconnect()}>{t("common.cancel")}</Button>
          </div>
        ) : mode === "nearby" ? (
          <div className="discovery-panel">
            <header className="discovery-panel__header">
              <strong>{t("connection.discovered")}</strong>
              <Button tone="ghost" onClick={() => void controller.refreshDiscoveredNodes()} disabled={state.discoveryState === "discovering"}>
                {state.discoveryState === "discovering" ? <Spinner label={t("connection.discovering")} /> : <RefreshCcw aria-hidden="true" />}
                {t("common.refresh")}
              </Button>
            </header>
            {state.discoveryError !== undefined && <ErrorBanner message={connectionFacingMessage(state.discoveryError)} />}
            {state.discoveryState === "discovering" && discoveredNodes.length === 0 ? (
              <div className="discovery-empty" role="status"><Spinner label={t("connection.discovering")} /><span>{t("connection.discovering")}</span></div>
            ) : discoveredNodes.length === 0 ? (
              <div className="discovery-empty"><Wifi aria-hidden="true" /><strong>{t("connection.noneDiscovered")}</strong><span>{t("connection.discoveryFallback")}</span><Button onClick={() => selectMode("pair")}>{t("connection.enterManually")}</Button></div>
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
                    <Button tone="primary" onClick={() => selectDiscovered(node.origin)}>{t("connection.useNode")}</Button>
                  </article>
                ))}
              </div>
            )}
          </div>
        ) : mode === "saved" ? (
          <div className="profile-list">
            {sortedProfiles.map((profile) => (
              <article className="profile-card" key={profile.id}>
                <div className="profile-card__icon"><Server aria-hidden="true" /></div>
                <div className="profile-card__body">
                  <strong>{profile.name}</strong>
                  <span>{profile.origin}</span>
                  {profile.lastConnectedAt !== undefined && <small>{t("connection.lastUsed", { time: formatRelativeTime(profile.lastConnectedAt, state.preferences.locale) })}</small>}
                </div>
                <Button tone="primary" onClick={() => connect(profile)} disabled={busy !== undefined}>
                  {busy === profile.id ? <Spinner label={t("connection.connecting")} /> : <ArrowRight aria-hidden="true" />}
                  {t("connection.connect")}
                </Button>
                {profile.managedLocal !== true && <IconButton className="profile-card__forget" label={t("connection.forget", { name: profile.name })} onClick={() => void controller.forgetProfile(profile.id)}>
                  <Trash2 aria-hidden="true" />
                </IconButton>}
              </article>
            ))}
          </div>
        ) : (
          <form className="pair-form" onSubmit={(event) => { event.preventDefault(); pair(); }}>
            <div className="pair-form__intro">
              <Laptop aria-hidden="true" />
              <div><strong>{t("connection.pair")}</strong><p>{t("connection.pairHelp")}</p></div>
            </div>
            <label>
              <span>{t("connection.origin")}</span>
              <input type="url" inputMode="url" required value={origin} onChange={(event) => { setOrigin(event.target.value); setInsecureConfirmed(false); }} placeholder="http://192.168.1.20:4318" autoComplete="url" />
              <small>{t("connection.secureHint")}</small>
            </label>
            {insecureLan && <div className="lan-http-warning" role="note">
              <AlertTriangle aria-hidden="true" />
              <div><strong>{t("connection.insecureLanTitle")}</strong><p>{t("connection.insecureLanBody")}</p>{sessionOnlySecret && <p>{t("connection.sessionOnlySecret")}</p>}</div>
            </div>}
            {insecureLan && <label className="lan-http-confirm">
              <CheckboxControl checked={insecureConfirmed} onChange={(event) => setInsecureConfirmed(event.target.checked)} />
              <span>{t("connection.insecureLanConfirm")}</span>
            </label>}
            <div className="pair-form__row">
              <label>
                <span>{t("connection.code")}</span>
                <input required value={code} onChange={(event) => setCode(event.target.value)} placeholder="XXXX-XXXX" autoComplete="one-time-code" spellCheck={false} />
              </label>
              <label>
                <span>{t("connection.deviceName")}</span>
                <input required value={deviceName} onChange={(event) => setDeviceName(event.target.value)} autoComplete="off" />
              </label>
            </div>
            <Button type="submit" tone="primary" className="pair-form__submit" disabled={busy !== undefined || origin.trim() === "" || code.trim() === "" || deviceName.trim() === "" || (insecureLan && !insecureConfirmed)}>
              {busy === "pair" ? <Spinner label={t("connection.connecting")} /> : <KeyRound aria-hidden="true" />}
              {t("connection.pair")}
            </Button>
          </form>
        )}
        <label className="connection-auto-choice">
          <CheckboxControl
            checked={rememberAutomatically}
            disabled={busy !== undefined || isConnecting || (!automaticEntryAvailable && !rememberAutomatically)}
            onChange={(event) => setAutomaticChoice(event.target.checked)}
          />
          <span><strong>{t("connection.rememberAutomatically")}</strong><small>{t(automaticEntryAvailable ? "connection.rememberAutomaticallyHelp" : "connection.rememberAutomaticallyUnavailable")}</small></span>
        </label>
        </section>
      </div>
    </main>
  );
}

function managedOrchestratorStatusText(status: JokoDesktopManagedOrchestratorStatus, t: Translator): string {
  if (status.state === "ready") return t("connection.localReady");
  if (status.state === "disabled") return t("common.disabled");
  if (status.state === "starting") return t("managedOrchestrator.startingTitle");
  if (status.reason === "serviceUnavailable") return t("managedOrchestrator.serviceUnavailable");
  if (status.reason === "startFailed") return t("managedOrchestrator.startFailed");
  if (status.reason === "credentialUnavailable") return t("managedOrchestrator.credentialUnavailable");
  if (status.reason === "credentialRejected") return t("managedOrchestrator.credentialRejected");
  return t("managedOrchestrator.identityConflict");
}

type ConnectionMode = "nearby" | "saved" | "pair";

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
