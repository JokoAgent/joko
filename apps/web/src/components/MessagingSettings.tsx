import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from "react";
import {
  Bot,
  CheckCircle2,
  KeyRound,
  MessageCircleMore,
  Plus,
  RefreshCw,
  Route,
  Settings2,
  ShieldAlert,
  Trash2
} from "lucide-react";

import type { AppController } from "../controller.js";
import type {
  AppSnapshot,
  MessagingChannelView,
  MessagingConnectionTestResultView,
  MessagingConnectionView,
  MessagingRouteView,
  MessagingSettingsView,
  PermissionMode,
  TelegramMessagingConfigurationView
} from "../model.js";
import type { Translator } from "./types.js";
import {
  Button,
  CheckboxControl,
  ErrorBanner,
  Modal,
  SelectControl,
  Spinner,
  SwitchControl,
  cx,
  formatRelativeTime
} from "./ui.js";
import "./messaging-settings.css";

const DEFAULT_TELEGRAM_CONFIGURATION: TelegramMessagingConfigurationView = Object.freeze({
  emojiReactions: "minimal",
  replyQuoteDm: "off",
  replyQuoteGroup: "first",
  groupActivation: Object.freeze({})
});

type MessagingDialog =
  | { readonly kind: "create" }
  | { readonly kind: "credential"; readonly connectionId: string }
  | { readonly kind: "configuration"; readonly connectionId: string }
  | { readonly kind: "clear"; readonly connectionId: string }
  | { readonly kind: "route"; readonly connectionId?: string };

interface MessagingTestMessage {
  readonly ok: boolean;
  readonly text: string;
}

export function MessagingSettings({ controller, snapshot, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly t: Translator;
}): JSX.Element {
  const ownerKey = controller.state.activeProfile?.id ?? "disconnected";
  const [settings, setSettings] = useState<MessagingSettingsView>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [dialog, setDialog] = useState<MessagingDialog>();
  const [testResults, setTestResults] = useState<Readonly<Record<string, MessagingTestMessage>>>({});
  const reloadRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    const abort = new AbortController();
    let inFlight = false;
    const load = async (initial: boolean): Promise<void> => {
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      if (initial) setLoading(true);
      else setRefreshing(true);
      try {
        const next = await controller.getMessagingSettings(abort.signal);
        if (!abort.signal.aborted) {
          setSettings(next);
          setError(undefined);
        }
      } catch (reason) {
        if (!abort.signal.aborted) setError(errorMessage(reason, t("messaging.loadFailed")));
      } finally {
        inFlight = false;
        if (!abort.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };
    reloadRef.current = () => load(false);
    void load(true);
    const timer = window.setInterval(() => void load(false), 5_000);
    return () => {
      window.clearInterval(timer);
      abort.abort();
      reloadRef.current = async () => undefined;
    };
  }, [controller, ownerKey, t]);

  const replaceConnection = (connection: MessagingConnectionView): void => {
    setSettings((current) => current === undefined ? current : {
      ...current,
      connections: current.connections.some((value) => value.id === connection.id)
        ? current.connections.map((value) => value.id === connection.id ? connection : value)
        : [...current.connections, connection]
    });
  };

  const replaceRoute = (route: MessagingRouteView): void => {
    setSettings((current) => current === undefined ? current : {
      ...current,
      routes: current.routes.some((value) => value.scopeKey === route.scopeKey)
        ? current.routes.map((value) => value.scopeKey === route.scopeKey ? route : value)
        : [...current.routes, route]
    });
  };

  const run = async <T,>(key: string, action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    setError(undefined);
    try {
      return await action();
    } catch (reason) {
      setError(errorMessage(reason, t("messaging.actionFailed")));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  const connectionForDialog = dialog !== undefined && "connectionId" in dialog
    ? settings?.connections.find((value) => value.id === dialog.connectionId)
    : undefined;
  const globalRoute = settings?.routes.find((route) => route.connectionId === undefined);

  const createTelegram = async (ownerProviderUserId: string): Promise<void> => {
    const connection = await run("create", () => controller.createTelegramMessagingConnection(
      ownerProviderUserId,
      DEFAULT_TELEGRAM_CONFIGURATION
    ));
    if (connection === undefined) return;
    replaceConnection(connection);
    setDialog({ kind: "credential", connectionId: connection.id });
  };

  const saveCredential = async (connection: MessagingConnectionView, secret: string, enable: boolean): Promise<void> => {
    const updated = await run(`credential:${connection.id}`, () => controller.saveMessagingCredential(
      connection.id,
      connection.revision,
      connection.generation,
      secret,
      enable
    ));
    if (updated === undefined) return;
    replaceConnection(updated);
    setDialog(undefined);
  };

  const setEnabled = async (connection: MessagingConnectionView, enabled: boolean): Promise<void> => {
    const updated = await run(`enabled:${connection.id}`, () => controller.setMessagingConnectionEnabled(
      connection.id,
      connection.revision,
      connection.generation,
      enabled
    ));
    if (updated !== undefined) replaceConnection(updated);
  };

  const testConnection = async (connection: MessagingConnectionView): Promise<void> => {
    const result = await run(`test:${connection.id}`, () => controller.testMessagingConnection(connection.id));
    if (result === undefined) return;
    setTestResults((current) => ({
      ...current,
      [connection.id]: { ok: result.ok, text: testResultLabel(result, t) }
    }));
  };

  const updateConfiguration = async (
    connection: MessagingConnectionView,
    ownerProviderUserId: string,
    configuration: TelegramMessagingConfigurationView
  ): Promise<void> => {
    const updated = await run(`configuration:${connection.id}`, () => controller.updateTelegramMessagingConfiguration(
      connection.id,
      connection.revision,
      connection.generation,
      ownerProviderUserId,
      configuration
    ));
    if (updated === undefined) return;
    replaceConnection(updated);
    setDialog(undefined);
  };

  const clearCredential = async (connection: MessagingConnectionView): Promise<void> => {
    const updated = await run(`clear:${connection.id}`, () => controller.clearMessagingCredential(
      connection.id,
      connection.revision,
      connection.generation
    ));
    if (updated === undefined) return;
    replaceConnection(updated);
    setDialog(undefined);
  };

  if (loading && settings === undefined) {
    return <section className="messaging-settings messaging-settings--loading" aria-busy="true">
      <Spinner />
      <p>{t("common.loading")}</p>
    </section>;
  }

  return <section className="messaging-settings">
    {error !== undefined && <ErrorBanner
      message={error}
      onRetry={() => { void reloadRef.current(); }}
      onClose={() => setError(undefined)}
    />}

    <header className="messaging-settings__hero">
      <div>
        <span className="messaging-settings__eyebrow"><MessageCircleMore aria-hidden="true" />{t("messaging.channels")}</span>
        <h2>{t("settings.messaging")}</h2>
        <p>{t("settings.messagingBody")}</p>
      </div>
      <div className="messaging-settings__hero-actions">
        <Button tone="secondary" disabled={refreshing} onClick={() => { void reloadRef.current(); }}>
          <RefreshCw aria-hidden="true" className={refreshing ? "is-spinning" : undefined} />
          {t("common.refresh")}
        </Button>
        <Button tone="primary" onClick={() => setDialog({ kind: "create" })}>
          <Plus aria-hidden="true" />{t("messaging.addTelegram")}
        </Button>
      </div>
    </header>

    <div className="messaging-channel-grid" aria-label={t("messaging.channelAvailability")}>
      {(settings?.channels ?? []).map((capability) => <div
        className={cx("messaging-channel", capability.available && "is-available")}
        key={capability.channel}
      >
        <Bot aria-hidden="true" />
        <div><strong>{channelLabel(capability.channel)}</strong><span>{capability.available
          ? t("common.available")
          : t("messaging.comingSoon")}</span></div>
      </div>)}
    </div>

    <section className="messaging-route-overview">
      <div className="messaging-section-heading">
        <div><h3>{t("messaging.defaultRoute")}</h3><p>{t("messaging.routeBody")}</p></div>
        <Button tone="secondary" onClick={() => setDialog({ kind: "route" })}>
          <Route aria-hidden="true" />{globalRoute === undefined ? t("messaging.setRoute") : t("messaging.editRoute")}
        </Button>
      </div>
      <RouteSummary route={globalRoute} snapshot={snapshot} t={t} />
    </section>

    <div className="messaging-section-heading">
      <div><h3>{t("messaging.connections")}</h3><p>{t("messaging.connectionsBody")}</p></div>
    </div>

    {(settings?.connections.length ?? 0) === 0
      ? <div className="messaging-empty">
          <Bot aria-hidden="true" />
          <h3>{t("messaging.emptyTitle")}</h3>
          <p>{t("messaging.emptyBody")}</p>
          <Button tone="primary" onClick={() => setDialog({ kind: "create" })}>
            <Plus aria-hidden="true" />{t("messaging.addTelegram")}
          </Button>
        </div>
      : <div className="messaging-connections">
          {settings!.connections.map((connection) => {
            const route = settings!.routes.find((candidate) => candidate.connectionId === connection.id);
            const pending = busy?.endsWith(connection.id) === true;
            return <article className="messaging-connection-card" key={connection.id}>
              <header>
                <div className="messaging-connection-card__identity">
                  <span className="messaging-connection-card__icon"><Bot aria-hidden="true" /></span>
                  <div>
                    <div className="messaging-connection-card__title-row">
                      <h4>{channelLabel(connection.channel)}</h4>
                      <ConnectionStatus status={connection.runtimeStatus} t={t} />
                    </div>
                    <p>{connection.providerUsername === undefined
                      ? t("messaging.ownerIdentity", { id: connection.ownerProviderUserId ?? "—" })
                      : `@${connection.providerUsername}`}</p>
                  </div>
                </div>
                <label className="messaging-switch-label">
                  <span>{connection.enabled ? t("common.enabled") : t("common.disabled")}</span>
                  <SwitchControl
                    aria-label={t("messaging.toggleConnection")}
                    checked={connection.enabled}
                    disabled={pending || !connection.credentialConfigured}
                    onChange={(event) => { void setEnabled(connection, event.target.checked); }}
                  />
                </label>
              </header>

              <div className="messaging-connection-card__facts">
                <span><strong>{t("messaging.credential")}</strong>{connection.credentialConfigured
                  ? t("messaging.credentialConfigured")
                  : t("messaging.credentialMissing")}</span>
                <span><strong>{t("messaging.lastConnected")}</strong>{connection.lastConnectedAt === undefined
                  ? t("common.none")
                  : formatRelativeTime(connection.lastConnectedAt, controller.state.preferences.locale)}</span>
                <span><strong>{t("messaging.ownerId")}</strong>{connection.ownerProviderUserId ?? "—"}</span>
              </div>

              {(connection.runtimeStatus === "conflict" || connection.runtimeStatus === "authLoss" || connection.runtimeStatus === "error") &&
                <div className="messaging-connection-card__warning" role="status">
                  <ShieldAlert aria-hidden="true" />
                  <span>{connection.errorSummary ?? connection.errorCode ?? t("messaging.runtimeError")}</span>
                </div>}
              {testResults[connection.id] !== undefined && <p className={cx("messaging-test-result", !testResults[connection.id]!.ok && "is-error")} aria-live="polite">
                {testResults[connection.id]!.ok ? <CheckCircle2 aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
                {testResults[connection.id]!.text}
              </p>}

              <div className="messaging-connection-card__route">
                <div><strong>{t("messaging.connectionRoute")}</strong><RouteSummary route={route} fallback={globalRoute} snapshot={snapshot} t={t} compact /></div>
                <Button tone="ghost" onClick={() => setDialog({ kind: "route", connectionId: connection.id })}>{t("common.edit")}</Button>
              </div>

              <footer>
                <Button tone="secondary" disabled={pending || !connection.credentialConfigured} onClick={() => { void testConnection(connection); }}>
                  {busy === `test:${connection.id}` ? <Spinner /> : <RefreshCw aria-hidden="true" />}{t("messaging.test")}
                </Button>
                <Button tone="secondary" disabled={pending} onClick={() => setDialog({ kind: "configuration", connectionId: connection.id })}>
                  <Settings2 aria-hidden="true" />{t("messaging.configure")}
                </Button>
                <Button tone="secondary" disabled={pending} onClick={() => setDialog({ kind: "credential", connectionId: connection.id })}>
                  <KeyRound aria-hidden="true" />{connection.credentialConfigured ? t("messaging.replaceCredential") : t("messaging.addCredential")}
                </Button>
                {connection.credentialConfigured && <Button tone="ghost" disabled={pending} onClick={() => setDialog({ kind: "clear", connectionId: connection.id })}>
                  <Trash2 aria-hidden="true" />{t("messaging.clearCredential")}
                </Button>}
              </footer>
            </article>;
          })}
        </div>}

    <CreateTelegramDialog
      open={dialog?.kind === "create"}
      busy={busy === "create"}
      t={t}
      onClose={() => setDialog(undefined)}
      onSubmit={(ownerId) => { void createTelegram(ownerId); }}
    />
    {connectionForDialog !== undefined && <CredentialDialog
      open={dialog?.kind === "credential"}
      connection={connectionForDialog}
      busy={busy === `credential:${connectionForDialog.id}`}
      t={t}
      onClose={() => setDialog(undefined)}
      onSubmit={(secret, enable) => { void saveCredential(connectionForDialog, secret, enable); }}
    />}
    {connectionForDialog !== undefined && connectionForDialog.telegramConfiguration !== undefined && <TelegramConfigurationDialog
      open={dialog?.kind === "configuration"}
      connection={connectionForDialog}
      busy={busy === `configuration:${connectionForDialog.id}`}
      t={t}
      onClose={() => setDialog(undefined)}
      onSubmit={(ownerId, configuration) => { void updateConfiguration(connectionForDialog, ownerId, configuration); }}
    />}
    {connectionForDialog !== undefined && <ClearCredentialDialog
      open={dialog?.kind === "clear"}
      busy={busy === `clear:${connectionForDialog.id}`}
      t={t}
      onClose={() => setDialog(undefined)}
      onConfirm={() => { void clearCredential(connectionForDialog); }}
    />}
    {dialog?.kind === "route" && <MessagingRouteDialog
      open
      connectionId={dialog.connectionId}
      existing={settings?.routes.find((route) => route.connectionId === dialog.connectionId)}
      fallback={dialog.connectionId === undefined ? undefined : globalRoute}
      snapshot={snapshot}
      busy={busy === `route:${dialog.connectionId ?? "global"}`}
      t={t}
      onClose={() => setDialog(undefined)}
      onSubmit={(draft) => { void (async () => {
        const route = await run(`route:${dialog.connectionId ?? "global"}`, () => controller.putMessagingRoute(draft));
        if (route !== undefined) {
          replaceRoute(route);
          setDialog(undefined);
        }
      })(); }}
    />}
  </section>;
}

function ConnectionStatus({ status, t }: {
  readonly status: MessagingConnectionView["runtimeStatus"];
  readonly t: Translator;
}): JSX.Element {
  return <span className={cx("messaging-status", `messaging-status--${status}`)}>
    <span aria-hidden="true" />{t(`messaging.status.${status}`)}
  </span>;
}

function RouteSummary({ route, fallback, snapshot, t, compact = false }: {
  readonly route?: MessagingRouteView;
  readonly fallback?: MessagingRouteView;
  readonly snapshot: AppSnapshot;
  readonly t: Translator;
  readonly compact?: boolean;
}): JSX.Element {
  const effective = route ?? fallback;
  if (effective === undefined) return <p className={cx("messaging-route-summary", compact && "is-compact")}>{t("messaging.noRoute")}</p>;
  const target = snapshot.targets.find((value) => value.id === effective.targetId);
  const model = snapshot.models.find((value) => value.backendId === effective.backendId
    && value.providerId === effective.providerId && value.modelId === effective.modelId);
  return <p className={cx("messaging-route-summary", compact && "is-compact")}>
    {route === undefined && fallback !== undefined && <span className="messaging-route-summary__inherit">{t("messaging.inherited")}</span>}
    <span>{target?.name ?? effective.targetId}</span>
    <span aria-hidden="true">·</span>
    <span>{model?.name ?? effective.modelId ?? t("messaging.backendDefaultModel")}</span>
    <span aria-hidden="true">·</span>
    <span>{permissionLabel(effective.permissionMode, t)}</span>
  </p>;
}

function CreateTelegramDialog({ open, busy, t, onClose, onSubmit }: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSubmit: (ownerId: string) => void;
}): JSX.Element {
  const [ownerId, setOwnerId] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) setOwnerId(""); }, [open]);
  const valid = /^\d+$/u.test(ownerId.trim());
  return <Modal
    open={open}
    title={t("messaging.createTitle")}
    description={t("messaging.createBody")}
    closeLabel={t("common.close")}
    onClose={onClose}
    initialFocus={() => inputRef.current}
    showClose
  >
    <form className="messaging-form" onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit(ownerId.trim()); }}>
      <label><span>{t("messaging.ownerId")}</span><input ref={inputRef} value={ownerId} onChange={(event) => setOwnerId(event.target.value)} inputMode="numeric" autoComplete="off" placeholder="123456789" /></label>
      <p className="messaging-form__hint">{t("messaging.ownerIdBody")}</p>
      <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={!valid || busy}>{busy ? <Spinner /> : null}{t("common.continue")}</Button></div>
    </form>
  </Modal>;
}

function CredentialDialog({ open, connection, busy, t, onClose, onSubmit }: {
  readonly open: boolean;
  readonly connection: MessagingConnectionView;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSubmit: (secret: string, enable: boolean) => void;
}): JSX.Element {
  const [secret, setSecret] = useState("");
  const [enable, setEnable] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setSecret(""); setEnable(true); } }, [open, connection.id]);
  return <Modal open={open} title={connection.credentialConfigured ? t("messaging.replaceCredential") : t("messaging.addCredential")} description={t("messaging.credentialBody")} closeLabel={t("common.close")} onClose={onClose} initialFocus={() => inputRef.current} showClose>
    <form className="messaging-form" onSubmit={(event) => { event.preventDefault(); if (secret.trim() !== "") onSubmit(secret, enable); }}>
      <label><span>{t("messaging.botToken")}</span><input ref={inputRef} type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" spellCheck={false} /></label>
      <label className="messaging-choice-row"><CheckboxControl checked={enable} onChange={(event) => setEnable(event.target.checked)} aria-label={t("messaging.enableAfterSave")} /><span>{t("messaging.enableAfterSave")}</span></label>
      <p className="messaging-form__secure"><KeyRound aria-hidden="true" />{t("messaging.secretSafety")}</p>
      <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={secret.trim() === "" || busy}>{busy ? <Spinner /> : null}{t("common.save")}</Button></div>
    </form>
  </Modal>;
}

function TelegramConfigurationDialog({ open, connection, busy, t, onClose, onSubmit }: {
  readonly open: boolean;
  readonly connection: MessagingConnectionView;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSubmit: (ownerId: string, configuration: TelegramMessagingConfigurationView) => void;
}): JSX.Element {
  const initial = connection.telegramConfiguration ?? DEFAULT_TELEGRAM_CONFIGURATION;
  const [ownerId, setOwnerId] = useState(connection.ownerProviderUserId ?? "");
  const [emoji, setEmoji] = useState(initial.emojiReactions);
  const [dmQuote, setDmQuote] = useState(initial.replyQuoteDm);
  const [groupQuote, setGroupQuote] = useState(initial.replyQuoteGroup);
  const [groups, setGroups] = useState(groupActivationText(initial.groupActivation));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const current = connection.telegramConfiguration ?? DEFAULT_TELEGRAM_CONFIGURATION;
    setOwnerId(connection.ownerProviderUserId ?? "");
    setEmoji(current.emojiReactions);
    setDmQuote(current.replyQuoteDm);
    setGroupQuote(current.replyQuoteGroup);
    setGroups(groupActivationText(current.groupActivation));
  }, [connection, open]);
  const parsedGroups = parseGroupActivation(groups);
  const valid = /^\d+$/u.test(ownerId.trim()) && parsedGroups !== undefined;
  return <Modal open={open} title={t("messaging.configureTitle")} description={t("messaging.configureBody")} closeLabel={t("common.close")} onClose={onClose} initialFocus={() => inputRef.current} showClose size="large">
    <form className="messaging-form messaging-form--grid" onSubmit={(event) => {
      event.preventDefault();
      if (valid && parsedGroups !== undefined) onSubmit(ownerId.trim(), {
        emojiReactions: emoji,
        replyQuoteDm: dmQuote,
        replyQuoteGroup: groupQuote,
        groupActivation: parsedGroups
      });
    }}>
      <label className="messaging-form__wide"><span>{t("messaging.ownerId")}</span><input ref={inputRef} value={ownerId} onChange={(event) => setOwnerId(event.target.value)} inputMode="numeric" /></label>
      <label><span>{t("messaging.emojiReactions")}</span><SelectControl value={emoji} onChange={(event) => setEmoji(event.target.value as typeof emoji)}><option value="off">{t("common.off")}</option><option value="minimal">{t("messaging.reactionsMinimal")}</option><option value="expressive">{t("messaging.reactionsExpressive")}</option></SelectControl></label>
      <label><span>{t("messaging.dmQuote")}</span><SelectControl value={dmQuote} onChange={(event) => setDmQuote(event.target.value as typeof dmQuote)}><option value="off">{t("common.off")}</option><option value="first">{t("messaging.quoteFirst")}</option></SelectControl></label>
      <label><span>{t("messaging.groupQuote")}</span><SelectControl value={groupQuote} onChange={(event) => setGroupQuote(event.target.value as typeof groupQuote)}><option value="off">{t("common.off")}</option><option value="first">{t("messaging.quoteFirst")}</option><option value="all">{t("messaging.quoteAll")}</option></SelectControl></label>
      <label className="messaging-form__wide"><span>{t("messaging.groupActivation")}</span><textarea value={groups} onChange={(event) => setGroups(event.target.value)} rows={5} placeholder={"-100123=mention\n-100456=always"} aria-invalid={parsedGroups === undefined} /></label>
      <p className="messaging-form__hint messaging-form__wide">{parsedGroups === undefined ? t("messaging.groupActivationInvalid") : t("messaging.groupActivationBody")}</p>
      <div className="modal__actions messaging-form__wide"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={!valid || busy}>{busy ? <Spinner /> : null}{t("common.save")}</Button></div>
    </form>
  </Modal>;
}

function ClearCredentialDialog({ open, busy, t, onClose, onConfirm }: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  return <Modal open={open} title={t("messaging.clearTitle")} description={t("messaging.clearBody")} closeLabel={t("common.close")} onClose={onClose} dialogRole="alertdialog">
    <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="danger" disabled={busy} onClick={onConfirm}>{busy ? <Spinner /> : null}{t("messaging.clearCredential")}</Button></div>
  </Modal>;
}

function MessagingRouteDialog({ open, connectionId, existing, fallback, snapshot, busy, t, onClose, onSubmit }: {
  readonly open: boolean;
  readonly connectionId?: string;
  readonly existing?: MessagingRouteView;
  readonly fallback?: MessagingRouteView;
  readonly snapshot: AppSnapshot;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSubmit: (draft: {
    readonly connectionId?: string;
    readonly expectedRevision?: bigint;
    readonly targetId: string;
    readonly providerId?: string;
    readonly modelId?: string;
    readonly effort?: string;
    readonly fastMode: boolean;
    readonly permissionMode: PermissionMode;
    readonly planMode: boolean;
  }) => void;
}): JSX.Element {
  const basis = existing ?? fallback;
  const availableTargets = useMemo(() => snapshot.targets.filter((target) => !target.archived), [snapshot.targets]);
  const initialTarget = basis?.targetId ?? availableTargets[0]?.id ?? "";
  const [targetId, setTargetId] = useState(initialTarget);
  const [modelKey, setModelKey] = useState(() => modelSelectionKey(basis?.providerId, basis?.modelId));
  const [effort, setEffort] = useState(basis?.effort ?? "");
  const [fastMode, setFastMode] = useState(basis?.fastMode ?? false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(basis?.permissionMode ?? "ask");
  const [planMode, setPlanMode] = useState(basis?.planMode ?? false);
  useEffect(() => {
    if (!open) return;
    const next = existing ?? fallback;
    setTargetId(next?.targetId ?? availableTargets[0]?.id ?? "");
    setModelKey(modelSelectionKey(next?.providerId, next?.modelId));
    setEffort(next?.effort ?? "");
    setFastMode(next?.fastMode ?? false);
    setPermissionMode(next?.permissionMode ?? "ask");
    setPlanMode(next?.planMode ?? false);
  }, [availableTargets, existing, fallback, open]);
  const target = availableTargets.find((value) => value.id === targetId);
  const models = snapshot.models.filter((model) => model.backendId === target?.backendId && model.available && model.routingEnabled !== false);
  const model = models.find((value) => modelSelectionKey(value.providerId, value.modelId) === modelKey);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (target === undefined) return;
    onSubmit({
      ...(connectionId === undefined ? {} : { connectionId }),
      ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
      targetId: target.id,
      ...(model === undefined ? {} : { providerId: model.providerId, modelId: model.modelId }),
      ...(model === undefined || effort === "" ? {} : { effort }),
      fastMode: model?.supportsFast === true && fastMode,
      permissionMode,
      planMode
    });
  };
  return <Modal open={open} title={connectionId === undefined ? t("messaging.defaultRoute") : t("messaging.connectionRoute")} description={t("messaging.routeBody")} closeLabel={t("common.close")} onClose={onClose} showClose size="large">
    <form className="messaging-form messaging-form--grid" onSubmit={submit}>
      <label className="messaging-form__wide"><span>{t("messaging.target")}</span><SelectControl value={targetId} onChange={(event) => { setTargetId(event.target.value); setModelKey(""); setEffort(""); setFastMode(false); }}>{availableTargets.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</SelectControl></label>
      <label className="messaging-form__wide"><span>{t("messaging.model")}</span><SelectControl value={modelKey} onChange={(event) => { setModelKey(event.target.value); setEffort(""); setFastMode(false); }}><option value="">{t("messaging.backendDefaultModel")}</option>{models.map((value) => <option key={modelSelectionKey(value.providerId, value.modelId)} value={modelSelectionKey(value.providerId, value.modelId)}>{value.providerName} · {value.name}</option>)}</SelectControl></label>
      <label><span>{t("messaging.effort")}</span><SelectControl value={effort} disabled={model === undefined || model.efforts.length === 0} onChange={(event) => setEffort(event.target.value)}><option value="">{t("common.none")}</option>{model?.efforts.map((value) => <option key={value} value={value}>{value}</option>)}</SelectControl></label>
      <label><span>{t("messaging.permission")}</span><SelectControl value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}><option value="ask">{t("messaging.permissionAsk")}</option><option value="auto">{t("messaging.permissionAuto")}</option><option value="bypassPermissions">{t("messaging.permissionBypass")}</option></SelectControl></label>
      <label className="messaging-choice-row"><CheckboxControl checked={fastMode} disabled={model?.supportsFast !== true} onChange={(event) => setFastMode(event.target.checked)} aria-label={t("messaging.fastMode")} /><span>{t("messaging.fastMode")}</span></label>
      <label className="messaging-choice-row"><CheckboxControl checked={planMode} onChange={(event) => setPlanMode(event.target.checked)} aria-label={t("messaging.planMode")} /><span>{t("messaging.planMode")}</span></label>
      {availableTargets.length === 0 && <p className="messaging-form__warning messaging-form__wide">{t("messaging.noTargets")}</p>}
      <p className="messaging-form__hint messaging-form__wide">{t("messaging.routeNewOnly")}</p>
      <div className="modal__actions messaging-form__wide"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={target === undefined || busy}>{busy ? <Spinner /> : null}{t("common.save")}</Button></div>
    </form>
  </Modal>;
}

function channelLabel(channel: MessagingChannelView): string {
  switch (channel) {
    case "telegram": return "Telegram";
    case "discord": return "Discord";
    case "dingtalk": return "DingTalk";
    case "feishu": return "Feishu";
    case "lark": return "Lark";
    case "wecom": return "WeCom";
    case "wechat": return "WeChat";
    case "slack": return "Slack";
  }
}

function permissionLabel(value: PermissionMode, t: Translator): string {
  return value === "ask" ? t("messaging.permissionAsk")
    : value === "auto" ? t("messaging.permissionAuto")
      : t("messaging.permissionBypass");
}

function testResultLabel(value: MessagingConnectionTestResultView, t: Translator): string {
  if (value.ok) return t("messaging.testPassed", { name: value.username === undefined ? value.displayName : `@${value.username}` });
  return t(`messaging.testFailure.${value.failure}`);
}

function groupActivationText(value: TelegramMessagingConfigurationView["groupActivation"]): string {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([chatId, activation]) => `${chatId}=${activation}`).join("\n");
}

function parseGroupActivation(value: string): Record<string, "mention" | "always" | "disabled"> | undefined {
  const result: Record<string, "mention" | "always" | "disabled"> = {};
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^(-?\d+)\s*=\s*(mention|always|disabled)$/u.exec(line);
    if (match === null || result[match[1]!] !== undefined) return undefined;
    result[match[1]!] = match[2]! as "mention" | "always" | "disabled";
  }
  return result;
}

function modelSelectionKey(providerId?: string, modelId?: string): string {
  return providerId === undefined || modelId === undefined ? "" : JSON.stringify([providerId, modelId]);
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() !== "" ? reason.message : fallback;
}
