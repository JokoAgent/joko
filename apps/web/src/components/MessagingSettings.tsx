import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
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
  DingTalkMessagingConfigurationView,
  DiscordMessagingConfigurationView,
  FeishuMessagingConfigurationView,
  MessagingChannelView,
  MessagingConnectionTestResultView,
  MessagingConnectionView,
  MessagingRouteView,
  MessagingSettingsView,
  PermissionMode,
  SlackMessagingConfigurationView,
  TelegramMessagingConfigurationView,
  WeComMessagingConfigurationView,
  WeChatAuthorizationAttemptView
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

const DEFAULT_DISCORD_CONFIGURATION: DiscordMessagingConfigurationView = Object.freeze({
  lifecycleAnnouncements: true,
  emojiReactions: "minimal",
  replyQuoteDm: "off",
  replyQuoteGroup: "first",
  groupActivation: Object.freeze({})
});

const DEFAULT_SLACK_CONFIGURATION: SlackMessagingConfigurationView = Object.freeze({
  lifecycleAnnouncements: true,
  emojiReactions: "minimal",
  groupActivation: Object.freeze({})
});

const DEFAULT_FEISHU_CONFIGURATION = Object.freeze({
  lifecycleAnnouncements: true,
  emojiReactions: "minimal",
  replyQuoteDm: "off",
  replyQuoteGroup: "all",
  groupActivation: Object.freeze({}),
  groupPermissionMode: "ask"
} as const satisfies Omit<FeishuMessagingConfigurationView, "appId">);

type MessagingCreateChannel = "telegram" | "discord" | "dingtalk" | "feishu" | "lark" | "wecom" | "slack";

type MessagingDialog =
  | { readonly kind: "create"; readonly channel: MessagingCreateChannel }
  | { readonly kind: "credential"; readonly connectionId: string }
  | { readonly kind: "configuration"; readonly connectionId: string }
  | { readonly kind: "clear"; readonly connectionId: string }
  | { readonly kind: "wechatAuthorization"; readonly connectionId: string }
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

  const refreshConnection = async (original: MessagingConnectionView): Promise<MessagingConnectionView> => {
    const refreshed = await controller.getMessagingSettings();
    setSettings(refreshed);
    const latest = refreshed.connections.find((candidate) => candidate.id === original.id);
    if (latest === undefined || latest.channel !== original.channel) {
      throw new Error(t("messaging.connectionChanged"));
    }
    return latest;
  };

  const refreshAfterRevisionConflict = async (
    reason: unknown,
    original: MessagingConnectionView
  ): Promise<MessagingConnectionView> => {
    if (ConnectError.from(reason).code !== Code.Aborted) throw reason;
    return refreshConnection(original);
  };

  const connectionForDialog = dialog !== undefined && "connectionId" in dialog
    ? settings?.connections.find((value) => value.id === dialog.connectionId)
    : undefined;
  const globalRoute = settings?.routes.find((route) => route.connectionId === undefined);
  const telegramAvailable = settings?.channels.some((capability) =>
    capability.channel === "telegram" && capability.available) === true;
  const discordAvailable = settings?.channels.some((capability) =>
    capability.channel === "discord" && capability.available) === true;
  const dingtalkAvailable = settings?.channels.some((capability) =>
    capability.channel === "dingtalk" && capability.available) === true;
  const feishuAvailable = settings?.channels.some((capability) =>
    capability.channel === "feishu" && capability.available) === true;
  const larkAvailable = settings?.channels.some((capability) =>
    capability.channel === "lark" && capability.available) === true;
  const wecomAvailable = settings?.channels.some((capability) =>
    capability.channel === "wecom" && capability.available) === true;
  const wechatAvailable = settings?.channels.some((capability) =>
    capability.channel === "wechat" && capability.available) === true;
  const slackAvailable = settings?.channels.some((capability) =>
    capability.channel === "slack" && capability.available) === true;

  const createWeChatConnection = async (): Promise<void> => {
    const connection = await run("create:wechat", () => controller.createWeChatMessagingConnection());
    if (connection === undefined) return;
    replaceConnection(connection);
    setDialog({ kind: "wechatAuthorization", connectionId: connection.id });
  };

  const createConnection = async (
    channel: MessagingCreateChannel,
    identity: string
  ): Promise<void> => {
    const connection = await run(`create:${channel}`, () => channel === "telegram"
      ? controller.createTelegramMessagingConnection(identity, DEFAULT_TELEGRAM_CONFIGURATION)
      : channel === "discord"
        ? controller.createDiscordMessagingConnection(identity, DEFAULT_DISCORD_CONFIGURATION)
        : channel === "slack"
          ? controller.createSlackMessagingConnection(identity, DEFAULT_SLACK_CONFIGURATION)
        : channel === "dingtalk"
          ? controller.createDingTalkMessagingConnection({ appKey: identity, groupActivation: {} })
          : channel === "wecom"
            ? controller.createWeComMessagingConnection({ botId: identity })
            : controller.createFeishuMessagingConnection(channel, {
                appId: identity,
                ...DEFAULT_FEISHU_CONFIGURATION
              }));
    if (connection === undefined) return;
    replaceConnection(connection);
    setDialog({ kind: "credential", connectionId: connection.id });
  };

  const saveCredential = async (connection: MessagingConnectionView, secret: string, enable: boolean): Promise<void> => {
    const updated = await run(`credential:${connection.id}`, async () => {
      const save = (candidate: MessagingConnectionView) => controller.saveMessagingCredential(
        candidate.id,
        candidate.revision,
        candidate.generation,
        secret,
        enable
      );
      let candidate = await refreshConnection(connection);
      if (candidate.generation !== connection.generation
        || candidate.credentialConfigured !== connection.credentialConfigured) {
        throw new Error(t("messaging.connectionChanged"));
      }
      try {
        return await save(candidate);
      } catch (reason) {
        candidate = await refreshAfterRevisionConflict(reason, connection);
        if (candidate.generation !== connection.generation
          || candidate.credentialConfigured !== connection.credentialConfigured) throw reason;
        return save(candidate);
      }
    });
    if (updated === undefined) return;
    replaceConnection(updated);
    setDialog(undefined);
  };

  const setEnabled = async (connection: MessagingConnectionView, enabled: boolean): Promise<void> => {
    const updated = await run(`enabled:${connection.id}`, async () => {
      const save = (candidate: MessagingConnectionView) => controller.setMessagingConnectionEnabled(
        candidate.id,
        candidate.revision,
        candidate.generation,
        enabled
      );
      let candidate = await refreshConnection(connection);
      if (candidate.enabled === enabled) return candidate;
      if (candidate.generation !== connection.generation || candidate.enabled !== connection.enabled) {
        throw new Error(t("messaging.connectionChanged"));
      }
      try {
        return await save(candidate);
      } catch (reason) {
        candidate = await refreshAfterRevisionConflict(reason, connection);
        if (candidate.enabled === enabled) return candidate;
        if (candidate.generation !== connection.generation || candidate.enabled !== connection.enabled) throw reason;
        return save(candidate);
      }
    });
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

  const updateTelegramConfiguration = async (
    connection: MessagingConnectionView,
    ownerProviderUserId: string,
    configuration: TelegramMessagingConfigurationView
  ): Promise<void> => {
    const updated = await run(`configuration:${connection.id}`, async () => {
      const save = (candidate: MessagingConnectionView) => controller.updateTelegramMessagingConfiguration(
        candidate.id,
        candidate.revision,
        candidate.generation,
        ownerProviderUserId,
        configuration
      );
      let candidate = await refreshConnection(connection);
      if (candidate.ownerProviderUserId === ownerProviderUserId
        && telegramConfigurationEqual(candidate.telegramConfiguration, configuration)) return candidate;
      if (candidate.generation !== connection.generation
        || candidate.ownerProviderUserId !== connection.ownerProviderUserId
        || !telegramConfigurationEqual(candidate.telegramConfiguration, connection.telegramConfiguration)) {
        throw new Error(t("messaging.connectionChanged"));
      }
      try {
        return await save(candidate);
      } catch (reason) {
        candidate = await refreshAfterRevisionConflict(reason, connection);
        if (candidate.ownerProviderUserId === ownerProviderUserId
          && telegramConfigurationEqual(candidate.telegramConfiguration, configuration)) return candidate;
        if (candidate.generation !== connection.generation
          || candidate.ownerProviderUserId !== connection.ownerProviderUserId
          || !telegramConfigurationEqual(candidate.telegramConfiguration, connection.telegramConfiguration)) throw reason;
        return save(candidate);
      }
    });
    if (updated === undefined) return;
    replaceConnection(updated);
    setDialog(undefined);
  };

  const updateDiscordConfiguration = async (
    connection: MessagingConnectionView,
    ownerProviderUserId: string,
    configuration: DiscordMessagingConfigurationView
  ): Promise<void> => {
    const updated = await run(`configuration:${connection.id}`, async () => {
      const save = (candidate: MessagingConnectionView) => controller.updateDiscordMessagingConfiguration(
        candidate.id,
        candidate.revision,
        candidate.generation,
        ownerProviderUserId,
        configuration
      );
      let candidate = await refreshConnection(connection);
      if (candidate.ownerProviderUserId === ownerProviderUserId
        && discordConfigurationEqual(candidate.discordConfiguration, configuration)) return candidate;
      if (candidate.generation !== connection.generation
        || candidate.ownerProviderUserId !== connection.ownerProviderUserId
        || !discordConfigurationEqual(candidate.discordConfiguration, connection.discordConfiguration)) {
        throw new Error(t("messaging.connectionChanged"));
      }
      try {
        return await save(candidate);
      } catch (reason) {
        candidate = await refreshAfterRevisionConflict(reason, connection);
        if (candidate.ownerProviderUserId === ownerProviderUserId
          && discordConfigurationEqual(candidate.discordConfiguration, configuration)) return candidate;
        if (candidate.generation !== connection.generation
          || candidate.ownerProviderUserId !== connection.ownerProviderUserId
          || !discordConfigurationEqual(candidate.discordConfiguration, connection.discordConfiguration)) throw reason;
        return save(candidate);
      }
    });
    if (updated === undefined) return;
    replaceConnection(updated);
    setDialog(undefined);
  };

  const updateSlackConfiguration = async (
    connection: MessagingConnectionView,
    ownerProviderUserId: string,
    configuration: SlackMessagingConfigurationView
  ): Promise<void> => {
    const updated = await run(`configuration:${connection.id}`, async () => {
      const save = (candidate: MessagingConnectionView) => controller.updateSlackMessagingConfiguration(
        candidate.id,
        candidate.revision,
        candidate.generation,
        ownerProviderUserId,
        configuration
      );
      let candidate = await refreshConnection(connection);
      if (candidate.ownerProviderUserId === ownerProviderUserId
        && slackConfigurationEqual(candidate.slackConfiguration, configuration)) return candidate;
      if (candidate.generation !== connection.generation
        || candidate.ownerProviderUserId !== connection.ownerProviderUserId
        || !slackConfigurationEqual(candidate.slackConfiguration, connection.slackConfiguration)) {
        throw new Error(t("messaging.connectionChanged"));
      }
      try {
        return await save(candidate);
      } catch (reason) {
        candidate = await refreshAfterRevisionConflict(reason, connection);
        if (candidate.ownerProviderUserId === ownerProviderUserId
          && slackConfigurationEqual(candidate.slackConfiguration, configuration)) return candidate;
        if (candidate.generation !== connection.generation
          || candidate.ownerProviderUserId !== connection.ownerProviderUserId
          || !slackConfigurationEqual(candidate.slackConfiguration, connection.slackConfiguration)) throw reason;
        return save(candidate);
      }
    });
    if (updated === undefined) return;
    replaceConnection(updated);
    setDialog(undefined);
  };

  const updateDingTalkConfiguration = async (
    connection: MessagingConnectionView,
    configuration: DingTalkMessagingConfigurationView
  ): Promise<void> => {
    const updated = await run(`configuration:${connection.id}`, async () => {
      const save = (candidate: MessagingConnectionView) => controller.updateDingTalkMessagingConfiguration(
        candidate.id,
        candidate.revision,
        candidate.generation,
        configuration
      );
      let candidate = await refreshConnection(connection);
      if (dingtalkConfigurationEqual(candidate.dingtalkConfiguration, configuration)) return candidate;
      if (candidate.generation !== connection.generation
        || !dingtalkConfigurationEqual(candidate.dingtalkConfiguration, connection.dingtalkConfiguration)) {
        throw new Error(t("messaging.connectionChanged"));
      }
      try {
        return await save(candidate);
      } catch (reason) {
        candidate = await refreshAfterRevisionConflict(reason, connection);
        if (dingtalkConfigurationEqual(candidate.dingtalkConfiguration, configuration)) return candidate;
        if (candidate.generation !== connection.generation
          || !dingtalkConfigurationEqual(candidate.dingtalkConfiguration, connection.dingtalkConfiguration)) throw reason;
        return save(candidate);
      }
    });
    if (updated === undefined) return;
    replaceConnection(updated);
    setDialog(undefined);
  };

  const updateFeishuConfiguration = async (
    connection: MessagingConnectionView,
    configuration: FeishuMessagingConfigurationView
  ): Promise<void> => {
    const updated = await run(`configuration:${connection.id}`, async () => {
      const save = (candidate: MessagingConnectionView) => controller.updateFeishuMessagingConfiguration(
        candidate.id,
        candidate.revision,
        candidate.generation,
        configuration
      );
      let candidate = await refreshConnection(connection);
      if (feishuConfigurationEqual(candidate.feishuConfiguration, configuration)) return candidate;
      if (candidate.generation !== connection.generation
        || !feishuConfigurationEqual(candidate.feishuConfiguration, connection.feishuConfiguration)) {
        throw new Error(t("messaging.connectionChanged"));
      }
      try {
        return await save(candidate);
      } catch (reason) {
        candidate = await refreshAfterRevisionConflict(reason, connection);
        if (feishuConfigurationEqual(candidate.feishuConfiguration, configuration)) return candidate;
        if (candidate.generation !== connection.generation
          || !feishuConfigurationEqual(candidate.feishuConfiguration, connection.feishuConfiguration)) throw reason;
        return save(candidate);
      }
    });
    if (updated === undefined) return;
    replaceConnection(updated);
    setDialog(undefined);
  };

  const updateWeComConfiguration = async (
    connection: MessagingConnectionView,
    configuration: WeComMessagingConfigurationView
  ): Promise<void> => {
    const updated = await run(`configuration:${connection.id}`, async () => {
      const save = (candidate: MessagingConnectionView) => controller.updateWeComMessagingConfiguration(
        candidate.id,
        candidate.revision,
        candidate.generation,
        configuration
      );
      let candidate = await refreshConnection(connection);
      if (wecomConfigurationEqual(candidate.wecomConfiguration, configuration)) return candidate;
      if (candidate.generation !== connection.generation
        || !wecomConfigurationEqual(candidate.wecomConfiguration, connection.wecomConfiguration)) {
        throw new Error(t("messaging.connectionChanged"));
      }
      try {
        return await save(candidate);
      } catch (reason) {
        candidate = await refreshAfterRevisionConflict(reason, connection);
        if (wecomConfigurationEqual(candidate.wecomConfiguration, configuration)) return candidate;
        if (candidate.generation !== connection.generation
          || !wecomConfigurationEqual(candidate.wecomConfiguration, connection.wecomConfiguration)) throw reason;
        return save(candidate);
      }
    });
    if (updated === undefined) return;
    replaceConnection(updated);
    setDialog(undefined);
  };

  const clearCredential = async (connection: MessagingConnectionView): Promise<void> => {
    const updated = await run(`clear:${connection.id}`, async () => {
      const clear = (candidate: MessagingConnectionView) => controller.clearMessagingCredential(
        candidate.id,
        candidate.revision,
        candidate.generation
      );
      let candidate = await refreshConnection(connection);
      if (!candidate.credentialConfigured) return candidate;
      if (candidate.generation !== connection.generation
        || candidate.credentialConfigured !== connection.credentialConfigured) {
        throw new Error(t("messaging.connectionChanged"));
      }
      try {
        return await clear(candidate);
      } catch (reason) {
        candidate = await refreshAfterRevisionConflict(reason, connection);
        if (!candidate.credentialConfigured) return candidate;
        if (candidate.generation !== connection.generation
          || candidate.credentialConfigured !== connection.credentialConfigured) throw reason;
        return clear(candidate);
      }
    });
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
        {telegramAvailable && <Button tone="secondary" onClick={() => setDialog({ kind: "create", channel: "telegram" })}>
          <Plus aria-hidden="true" />{t("messaging.addTelegram")}
        </Button>}
        {discordAvailable && <Button tone="primary" onClick={() => setDialog({ kind: "create", channel: "discord" })}>
          <Plus aria-hidden="true" />{t("messaging.addDiscord")}
        </Button>}
        {dingtalkAvailable && <Button tone="primary" onClick={() => setDialog({ kind: "create", channel: "dingtalk" })}>
          <Plus aria-hidden="true" />{t("messaging.addDingTalk")}
        </Button>}
        {feishuAvailable && <Button tone="primary" onClick={() => setDialog({ kind: "create", channel: "feishu" })}>
          <Plus aria-hidden="true" />{t("messaging.addFeishu")}
        </Button>}
        {larkAvailable && <Button tone="primary" onClick={() => setDialog({ kind: "create", channel: "lark" })}>
          <Plus aria-hidden="true" />{t("messaging.addLark")}
        </Button>}
        {wecomAvailable && <Button tone="primary" onClick={() => setDialog({ kind: "create", channel: "wecom" })}>
          <Plus aria-hidden="true" />{t("messaging.addWeCom")}
        </Button>}
        {wechatAvailable && <Button tone="primary" disabled={busy === "create:wechat"} onClick={() => { void createWeChatConnection(); }}>
          {busy === "create:wechat" ? <Spinner /> : <Plus aria-hidden="true" />}{t("messaging.addWeChat")}
        </Button>}
        {slackAvailable && <Button tone="primary" onClick={() => setDialog({ kind: "create", channel: "slack" })}>
          <Plus aria-hidden="true" />{t("messaging.addSlack")}
        </Button>}
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
          {telegramAvailable && <Button tone="secondary" onClick={() => setDialog({ kind: "create", channel: "telegram" })}>
            <Plus aria-hidden="true" />{t("messaging.addTelegram")}
          </Button>}
          {discordAvailable && <Button tone="primary" onClick={() => setDialog({ kind: "create", channel: "discord" })}>
            <Plus aria-hidden="true" />{t("messaging.addDiscord")}
          </Button>}
          {dingtalkAvailable && <Button tone="primary" onClick={() => setDialog({ kind: "create", channel: "dingtalk" })}>
            <Plus aria-hidden="true" />{t("messaging.addDingTalk")}
          </Button>}
          {feishuAvailable && <Button tone="primary" onClick={() => setDialog({ kind: "create", channel: "feishu" })}>
            <Plus aria-hidden="true" />{t("messaging.addFeishu")}
          </Button>}
          {larkAvailable && <Button tone="primary" onClick={() => setDialog({ kind: "create", channel: "lark" })}>
            <Plus aria-hidden="true" />{t("messaging.addLark")}
          </Button>}
          {wecomAvailable && <Button tone="primary" onClick={() => setDialog({ kind: "create", channel: "wecom" })}>
            <Plus aria-hidden="true" />{t("messaging.addWeCom")}
          </Button>}
          {wechatAvailable && <Button tone="primary" disabled={busy === "create:wechat"} onClick={() => { void createWeChatConnection(); }}>
            {busy === "create:wechat" ? <Spinner /> : <Plus aria-hidden="true" />}{t("messaging.addWeChat")}
          </Button>}
          {slackAvailable && <Button tone="primary" onClick={() => setDialog({ kind: "create", channel: "slack" })}>
            <Plus aria-hidden="true" />{t("messaging.addSlack")}
          </Button>}
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
                      <ConnectionStatus status={connection.runtimeStatus} channel={connection.channel} t={t} />
                    </div>
                    <p>{connection.channel === "wechat"
                      ? connection.providerAccountId === undefined
                        ? t("messaging.wechatAwaitingAuthorization")
                        : t("messaging.wechatConnectedAccount", { id: connection.providerAccountId })
                      : connection.channel === "dingtalk" || connection.channel === "feishu" || connection.channel === "lark" || connection.channel === "wecom"
                      ? connection.ownerProviderUserId === undefined
                        ? t(connection.channel === "dingtalk"
                          ? "messaging.dingtalkAwaitingOwner"
                          : connection.channel === "wecom" ? "messaging.wecomAwaitingOwner" : "messaging.feishuAwaitingOwner")
                        : t("messaging.ownerIdentity", { id: connection.ownerProviderUserId })
                      : connection.providerUsername === undefined
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
                <span><strong>{t(connection.channel === "wechat" ? "messaging.wechatAccountId"
                  : connection.channel === "discord" ? "messaging.discordOwnerId"
                  : connection.channel === "slack" ? "messaging.slackOwnerId"
                  : connection.channel === "dingtalk" ? "messaging.dingtalkOwnerId"
                    : connection.channel === "feishu" || connection.channel === "lark"
                      ? "messaging.feishuOwnerId"
                      : connection.channel === "wecom" ? "messaging.wecomOwnerId" : "messaging.ownerId")}</strong>{connection.ownerProviderUserId
                    ?? (connection.channel === "dingtalk" ? t("messaging.dingtalkAwaitingOwner")
                      : connection.channel === "feishu" || connection.channel === "lark"
                        ? t("messaging.feishuAwaitingOwner")
                        : connection.channel === "wecom" ? t("messaging.wecomAwaitingOwner") : "—")}</span>
                {connection.channel === "wecom" && connection.wecomConfiguration !== undefined && <span>
                  <strong>{t("messaging.wecomBotId")}</strong>{connection.wecomConfiguration.botId}
                </span>}
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
                {connection.channel !== "wechat" && <Button tone="secondary" disabled={pending} onClick={() => setDialog({ kind: "configuration", connectionId: connection.id })}>
                  <Settings2 aria-hidden="true" />{t("messaging.configure")}
                </Button>}
                {connection.channel === "wechat"
                  ? <Button tone="secondary" disabled={pending} onClick={() => setDialog({ kind: "wechatAuthorization", connectionId: connection.id })}>
                      <KeyRound aria-hidden="true" />{t(connection.credentialConfigured ? "messaging.wechatReauthorize" : "messaging.wechatAuthorize")}
                    </Button>
                  : <Button tone="secondary" disabled={pending} onClick={() => setDialog({ kind: "credential", connectionId: connection.id })}>
                      <KeyRound aria-hidden="true" />{messagingCredentialActionLabel(connection, t)}
                    </Button>}
                {connection.credentialConfigured && <Button tone="ghost" disabled={pending} onClick={() => setDialog({ kind: "clear", connectionId: connection.id })}>
                  <Trash2 aria-hidden="true" />{t(connection.channel === "dingtalk"
                    ? "messaging.dingtalkClearCredential"
                    : connection.channel === "feishu" || connection.channel === "lark"
                      ? "messaging.appSecretClearCredential"
                      : connection.channel === "wecom" ? "messaging.wecomClearCredential"
                      : connection.channel === "slack" ? "messaging.slackClearCredential"
                      : connection.channel === "wechat" ? "messaging.wechatClearCredential"
                      : "messaging.clearCredential")}
                </Button>}
              </footer>
            </article>;
          })}
        </div>}

    <CreateConnectionDialog
      open={dialog?.kind === "create"}
      channel={dialog?.kind === "create" ? dialog.channel : "telegram"}
      busy={dialog?.kind === "create" && busy === `create:${dialog.channel}`}
      t={t}
      onClose={() => setDialog(undefined)}
      onSubmit={(channel, ownerId) => { void createConnection(channel, ownerId); }}
    />
    {connectionForDialog !== undefined && connectionForDialog.channel === "wechat" && dialog?.kind === "wechatAuthorization" && <WeChatAuthorizationDialog
      key={`${ownerKey}:${connectionForDialog.id}`}
      connection={connectionForDialog}
      controller={controller}
      t={t}
      onConnection={replaceConnection}
      onClose={() => setDialog(undefined)}
    />}
    {connectionForDialog !== undefined && connectionForDialog.channel !== "wechat" && <CredentialDialog
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
      onSubmit={(ownerId, configuration) => { void updateTelegramConfiguration(connectionForDialog, ownerId, configuration); }}
    />}
    {connectionForDialog !== undefined && connectionForDialog.discordConfiguration !== undefined && <DiscordConfigurationDialog
      open={dialog?.kind === "configuration"}
      connection={connectionForDialog}
      busy={busy === `configuration:${connectionForDialog.id}`}
      t={t}
      onClose={() => setDialog(undefined)}
      onSubmit={(ownerId, configuration) => { void updateDiscordConfiguration(connectionForDialog, ownerId, configuration); }}
    />}
    {connectionForDialog !== undefined && connectionForDialog.slackConfiguration !== undefined && <SlackConfigurationDialog
      open={dialog?.kind === "configuration"}
      connection={connectionForDialog}
      busy={busy === `configuration:${connectionForDialog.id}`}
      t={t}
      onClose={() => setDialog(undefined)}
      onSubmit={(ownerId, configuration) => { void updateSlackConfiguration(connectionForDialog, ownerId, configuration); }}
    />}
    {connectionForDialog !== undefined && connectionForDialog.dingtalkConfiguration !== undefined && <DingTalkConfigurationDialog
      open={dialog?.kind === "configuration"}
      connection={connectionForDialog}
      busy={busy === `configuration:${connectionForDialog.id}`}
      t={t}
      onClose={() => setDialog(undefined)}
      onSubmit={(configuration) => { void updateDingTalkConfiguration(connectionForDialog, configuration); }}
    />}
    {connectionForDialog !== undefined && connectionForDialog.feishuConfiguration !== undefined && <FeishuConfigurationDialog
      open={dialog?.kind === "configuration"}
      connection={connectionForDialog}
      busy={busy === `configuration:${connectionForDialog.id}`}
      t={t}
      onClose={() => setDialog(undefined)}
      onSubmit={(configuration) => { void updateFeishuConfiguration(connectionForDialog, configuration); }}
    />}
    {connectionForDialog !== undefined && connectionForDialog.wecomConfiguration !== undefined && <WeComConfigurationDialog
      open={dialog?.kind === "configuration"}
      connection={connectionForDialog}
      busy={busy === `configuration:${connectionForDialog.id}`}
      t={t}
      onClose={() => setDialog(undefined)}
      onSubmit={(configuration) => { void updateWeComConfiguration(connectionForDialog, configuration); }}
    />}
    {connectionForDialog !== undefined && <ClearCredentialDialog
      open={dialog?.kind === "clear"}
      connection={connectionForDialog}
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

function ConnectionStatus({ status, channel, t }: {
  readonly status: MessagingConnectionView["runtimeStatus"];
  readonly channel: MessagingChannelView;
  readonly t: Translator;
}): JSX.Element {
  return <span className={cx("messaging-status", `messaging-status--${status}`)}>
    <span aria-hidden="true" />{t(status === "idle" && channel === "dingtalk"
      ? "messaging.status.dingtalkIdle"
      : status === "idle" && channel === "wechat"
        ? "messaging.status.wechatIdle"
      : status === "idle" && channel === "wecom"
        ? "messaging.status.wecomIdle"
      : status === "idle" && channel === "slack"
        ? "messaging.status.slackIdle"
      : status === "idle" && (channel === "feishu" || channel === "lark")
        ? "messaging.status.appSecretIdle"
      : `messaging.status.${status}`)}
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

function CreateConnectionDialog({ open, channel, busy, t, onClose, onSubmit }: {
  readonly open: boolean;
  readonly channel: MessagingCreateChannel;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSubmit: (channel: MessagingCreateChannel, identity: string) => void;
}): JSX.Element {
  const [identity, setIdentity] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) setIdentity(""); }, [channel, open]);
  const valid = channel === "slack"
    ? validSlackOwnerId(identity.trim())
    : channel === "discord"
    ? /^[1-9][0-9]{16,19}$/u.test(identity.trim())
    : channel === "dingtalk"
      ? validDingTalkProviderId(identity, 256)
      : channel === "feishu" || channel === "lark"
        ? validFeishuProviderId(identity, 256)
        : channel === "wecom"
          ? validWeComBotId(identity)
        : /^[1-9][0-9]{0,15}$/u.test(identity.trim());
  return <Modal
    open={open}
    title={channel === "slack" ? t("messaging.slackCreateTitle")
      : channel === "discord" ? t("messaging.discordCreateTitle")
      : channel === "dingtalk" ? t("messaging.dingtalkCreateTitle")
        : channel === "feishu" ? t("messaging.feishuCreateTitle")
          : channel === "lark" ? t("messaging.larkCreateTitle")
            : channel === "wecom" ? t("messaging.wecomCreateTitle") : t("messaging.createTitle")}
    description={channel === "slack" ? t("messaging.slackCreateBody")
      : channel === "discord" ? t("messaging.discordCreateBody")
      : channel === "dingtalk" ? t("messaging.dingtalkCreateBody")
        : channel === "feishu" || channel === "lark" ? t("messaging.feishuCreateBody")
          : channel === "wecom" ? t("messaging.wecomCreateBody") : t("messaging.createBody")}
    closeLabel={t("common.close")}
    onClose={onClose}
    initialFocus={() => inputRef.current}
    showClose
  >
    <form className="messaging-form" onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit(channel, identity.trim()); }}>
      <label><span>{channel === "slack" ? t("messaging.slackOwnerId")
        : channel === "discord" ? t("messaging.discordOwnerId")
        : channel === "dingtalk" ? t("messaging.dingtalkAppKey")
          : channel === "feishu" || channel === "lark" ? t("messaging.feishuAppId")
            : channel === "wecom" ? t("messaging.wecomBotId")
            : t("messaging.ownerId")}</span><input ref={inputRef} value={identity} onChange={(event) => setIdentity(event.target.value)} inputMode={channel === "telegram" || channel === "discord" ? "numeric" : "text"} autoComplete="off" placeholder={channel === "slack" ? "U12345678" : channel === "discord" ? "123456789012345678" : channel === "dingtalk" ? "dingxxxxxxxx" : channel === "feishu" || channel === "lark" ? "cli_xxxxxxxx" : channel === "wecom" ? "bot_xxxxxxxx" : "123456789"} /></label>
      <p className="messaging-form__hint">{channel === "slack" ? t("messaging.slackOwnerIdBody")
        : channel === "discord" ? t("messaging.discordOwnerIdBody")
        : channel === "dingtalk" ? t("messaging.dingtalkAppKeyBody")
          : channel === "feishu" || channel === "lark" ? t("messaging.feishuAppIdBody")
            : channel === "wecom" ? t("messaging.wecomBotIdBody")
            : t("messaging.ownerIdBody")}</p>
      {channel === "discord" && <p className="messaging-form__hint"><a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">{t("messaging.discordDeveloperPortal")}</a></p>}
      {channel === "slack" && <p className="messaging-form__hint"><a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">{t("messaging.slackDeveloperPortal")}</a></p>}
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
  const [slackAppToken, setSlackAppToken] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [enable, setEnable] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const slack = connection.channel === "slack";
  const appSecret = connection.channel === "dingtalk" || connection.channel === "feishu" || connection.channel === "lark" || connection.channel === "wecom";
  const credentialLabel = connection.channel === "dingtalk"
    ? "messaging.dingtalkAppSecret"
    : connection.channel === "wecom" ? "messaging.wecomBotSecret"
      : appSecret ? "messaging.appSecret" : "messaging.botToken";
  const secretSafety = connection.channel === "dingtalk"
    ? "messaging.dingtalkSecretSafety"
    : connection.channel === "wecom" ? "messaging.wecomSecretSafety"
      : appSecret ? "messaging.appSecretSafety" : "messaging.secretSafety";
  useEffect(() => { if (open) { setSecret(""); setSlackAppToken(""); setSlackBotToken(""); setEnable(true); } }, [open, connection.id]);
  const close = (): void => { setSecret(""); setSlackAppToken(""); setSlackBotToken(""); onClose(); };
  const valid = slack ? validSlackToken(slackAppToken, "xapp-") && validSlackToken(slackBotToken, "xoxb-")
    : secret.trim() !== "";
  return <Modal open={open} title={messagingCredentialActionLabel(connection, t)} description={t(slack ? "messaging.slackCredentialBody" : connection.channel === "dingtalk" ? "messaging.dingtalkCredentialBody" : connection.channel === "feishu" || connection.channel === "lark" ? "messaging.feishuCredentialBody" : connection.channel === "wecom" ? "messaging.wecomCredentialBody" : "messaging.credentialBody")} closeLabel={t("common.close")} onClose={close} initialFocus={() => inputRef.current} showClose>
    <form className="messaging-form" onSubmit={(event) => {
      event.preventDefault();
      if (!valid) return;
      const value = slack ? JSON.stringify({ format: 1, appToken: slackAppToken, botToken: slackBotToken }) : secret;
      setSecret(""); setSlackAppToken(""); setSlackBotToken("");
      onSubmit(value, enable);
    }}>
      {slack ? <>
        <label><span>{t("messaging.slackAppToken")}</span><input ref={inputRef} type="password" value={slackAppToken} onChange={(event) => setSlackAppToken(event.target.value)} autoComplete="new-password" spellCheck={false} /></label>
        <label><span>{t("messaging.slackBotToken")}</span><input type="password" value={slackBotToken} onChange={(event) => setSlackBotToken(event.target.value)} autoComplete="new-password" spellCheck={false} /></label>
        <p className="messaging-form__hint">{t("messaging.slackScopes")}</p>
      </> : <label><span>{t(credentialLabel)}</span><input ref={inputRef} type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" spellCheck={false} /></label>}
      <label className="messaging-choice-row"><CheckboxControl checked={enable} onChange={(event) => setEnable(event.target.checked)} aria-label={t("messaging.enableAfterSave")} /><span>{t("messaging.enableAfterSave")}</span></label>
      <p className="messaging-form__secure"><KeyRound aria-hidden="true" />{t(slack ? "messaging.slackSecretSafety" : secretSafety)}</p>
      <div className="modal__actions"><Button onClick={close}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={!valid || busy}>{busy ? <Spinner /> : null}{t("common.save")}</Button></div>
    </form>
  </Modal>;
}

function WeChatAuthorizationDialog({ connection, controller, t, onConnection, onClose }: {
  readonly connection: MessagingConnectionView;
  readonly controller: AppController;
  readonly t: Translator;
  readonly onConnection: (connection: MessagingConnectionView) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const originalGeneration = useRef(connection.generation);
  const originalCredentialConfigured = useRef(connection.credentialConfigured);
  const started = useRef(false);
  const cancelling = useRef(false);
  const actionAbort = useRef<AbortController | undefined>(undefined);
  const [attempt, setAttempt] = useState<WeChatAuthorizationAttemptView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pollRetry, setPollRetry] = useState(0);
  const [verificationCode, setVerificationCode] = useState("");
  const initialFocus = useRef<HTMLButtonElement>(null);
  const codeFocus = useRef<HTMLInputElement>(null);

  const begin = async (signal: AbortSignal): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setAttempt(undefined);
    try {
      const settings = await controller.getMessagingSettings(signal);
      const latest = settings.connections.find((value) => value.id === connection.id);
      if (latest === undefined || latest.channel !== "wechat" || latest.generation !== originalGeneration.current
        || latest.credentialConfigured !== originalCredentialConfigured.current) {
        throw new Error(t("messaging.connectionChanged"));
      }
      const next = await controller.beginWeChatAuthorization(latest.id, latest.revision, latest.generation, signal);
      if (signal.aborted) return;
      setAttempt(next);
      if (next.connection !== undefined) onConnection(next.connection);
    } catch (reason) {
      if (!signal.aborted) setError(errorMessage(reason, t("messaging.wechatAuthorizationFailed")));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const abort = new AbortController();
    actionAbort.current = abort;
    void begin(abort.signal);
    return () => abort.abort();
  }, []);

  useEffect(() => {
    if (attempt === undefined || attempt.status === "verificationRequired" || isWeChatAuthorizationTerminal(attempt.status)
      || busy || error !== undefined) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => { void (async () => {
      try {
        const next = await controller.getWeChatAuthorization(attempt, abort.signal);
        if (abort.signal.aborted) return;
        setAttempt(next);
        if (next.connection !== undefined) onConnection(next.connection);
      } catch (reason) {
        if (!abort.signal.aborted) setError(errorMessage(reason, t("messaging.wechatPollFailed")));
      }
    })(); }, 1_500);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [attempt, busy, controller, error, pollRetry]);

  useEffect(() => {
    if (attempt?.status === "verificationRequired") codeFocus.current?.focus();
  }, [attempt?.status]);

  const retryBegin = (): void => {
    actionAbort.current?.abort();
    const abort = new AbortController();
    actionAbort.current = abort;
    void begin(abort.signal);
  };

  const submitCode = async (): Promise<void> => {
    if (attempt?.status !== "verificationRequired" || !/^\d{1,12}$/u.test(verificationCode)) return;
    const code = verificationCode;
    setVerificationCode("");
    setBusy(true);
    setError(undefined);
    const abort = new AbortController();
    actionAbort.current = abort;
    try {
      const next = await controller.submitWeChatVerificationCode(attempt, code, abort.signal);
      if (abort.signal.aborted) return;
      setAttempt(next);
      if (next.connection !== undefined) onConnection(next.connection);
    } catch (reason) {
      if (!abort.signal.aborted) setError(errorMessage(reason, t("messaging.wechatVerificationFailed")));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };

  const close = async (): Promise<void> => {
    if (cancelling.current) return;
    setVerificationCode("");
    actionAbort.current?.abort();
    if (attempt === undefined || isWeChatAuthorizationTerminal(attempt.status)) {
      onClose();
      return;
    }
    cancelling.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await controller.cancelWeChatAuthorization(attempt);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason, t("messaging.wechatCancelFailed")));
      setBusy(false);
      cancelling.current = false;
    }
  };

  const terminal = attempt !== undefined && isWeChatAuthorizationTerminal(attempt.status);
  return <Modal
    open
    title={t(originalCredentialConfigured.current ? "messaging.wechatReauthorize" : "messaging.wechatAuthorize")}
    description={t(connection.runtimeStatus === "authLoss" ? "messaging.wechatRestoreBody"
      : originalCredentialConfigured.current ? "messaging.wechatRebindBody" : "messaging.wechatAuthorizeBody")}
    closeLabel={t("common.close")}
    onClose={() => { void close(); }}
    initialFocus={() => attempt?.status === "verificationRequired" ? codeFocus.current : initialFocus.current}
    showClose
  >
    <div className="messaging-wechat-authorization">
      {error !== undefined && <ErrorBanner message={error} onClose={() => setError(undefined)} onRetry={() => {
        if (attempt === undefined || terminal) retryBegin();
        else { setError(undefined); setPollRetry((value) => value + 1); }
      }} />}
      {attempt === undefined && <p className="messaging-wechat-authorization__status" role="status">{busy ? <Spinner /> : null}{t("messaging.wechatPreparing")}</p>}
      {attempt !== undefined && <>
        <p className="messaging-wechat-authorization__status" role="status" aria-live="polite">
          {t(`messaging.wechatStatus.${attempt.status}`)}
        </p>
        {attempt.errorSummary !== undefined && <p className="messaging-form__warning">{attempt.errorSummary}</p>}
        {!terminal && attempt.qrCodeUrl !== undefined && <div className="messaging-wechat-authorization__qr">
          <img src={attempt.qrCodeUrl} referrerPolicy="no-referrer" alt={t("messaging.wechatQrAlt")} />
          <a href={attempt.qrCodeUrl} target="_blank" rel="noreferrer">{t("messaging.wechatOpenQr")}</a>
          <span>{t("messaging.wechatExpiresAt", { time: new Date(attempt.expiresAt).toLocaleTimeString() })}</span>
        </div>}
        {attempt.status === "verificationRequired" && <form className="messaging-form" onSubmit={(event) => {
          event.preventDefault();
          void submitCode();
        }}>
          <label><span>{t("messaging.wechatVerificationCode")}</span><input ref={codeFocus} type="password" inputMode="numeric" autoComplete="one-time-code" value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} maxLength={12} /></label>
          {attempt.verificationRetry && <p className="messaging-form__warning">{t("messaging.wechatVerificationRetry")}</p>}
          <p className="messaging-form__secure"><KeyRound aria-hidden="true" />{t("messaging.wechatVerificationSafety")}</p>
          <Button tone="primary" type="submit" disabled={busy || !/^\d{1,12}$/u.test(verificationCode)}>{busy ? <Spinner /> : null}{t("messaging.wechatSubmitCode")}</Button>
        </form>}
      </>}
      <div className="modal__actions">
        <button ref={initialFocus} type="button" className="button button--secondary" onClick={() => { void close(); }} disabled={cancelling.current}>{terminal ? t("common.close") : t("common.cancel")}</button>
        {(attempt === undefined && !busy || attempt?.status === "failed" || attempt?.status === "expired" || attempt?.status === "cancelled")
          && <Button tone="primary" onClick={retryBegin} disabled={busy}>{t("messaging.wechatRetry")}</Button>}
      </div>
    </div>
  </Modal>;
}

function isWeChatAuthorizationTerminal(status: WeChatAuthorizationAttemptView["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "expired";
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

function DiscordConfigurationDialog({ open, connection, busy, t, onClose, onSubmit }: {
  readonly open: boolean;
  readonly connection: MessagingConnectionView;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSubmit: (ownerId: string, configuration: DiscordMessagingConfigurationView) => void;
}): JSX.Element {
  const initial = connection.discordConfiguration ?? DEFAULT_DISCORD_CONFIGURATION;
  const [ownerId, setOwnerId] = useState(connection.ownerProviderUserId ?? "");
  const [lifecycleAnnouncements, setLifecycleAnnouncements] = useState(initial.lifecycleAnnouncements);
  const [emoji, setEmoji] = useState(initial.emojiReactions);
  const [dmQuote, setDmQuote] = useState(initial.replyQuoteDm);
  const [groupQuote, setGroupQuote] = useState(initial.replyQuoteGroup);
  const [groups, setGroups] = useState(groupActivationText(initial.groupActivation));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const current = connection.discordConfiguration ?? DEFAULT_DISCORD_CONFIGURATION;
    setOwnerId(connection.ownerProviderUserId ?? "");
    setLifecycleAnnouncements(current.lifecycleAnnouncements);
    setEmoji(current.emojiReactions);
    setDmQuote(current.replyQuoteDm);
    setGroupQuote(current.replyQuoteGroup);
    setGroups(groupActivationText(current.groupActivation));
  }, [connection, open]);
  const parsedGroups = parseDiscordGroupActivation(groups);
  const valid = /^[1-9][0-9]{16,19}$/u.test(ownerId.trim()) && parsedGroups !== undefined;
  return <Modal open={open} title={t("messaging.discordConfigureTitle")} description={t("messaging.discordConfigureBody")} closeLabel={t("common.close")} onClose={onClose} initialFocus={() => inputRef.current} showClose size="large">
    <form className="messaging-form messaging-form--grid" onSubmit={(event) => {
      event.preventDefault();
      if (valid && parsedGroups !== undefined) onSubmit(ownerId.trim(), {
        lifecycleAnnouncements,
        emojiReactions: emoji,
        replyQuoteDm: dmQuote,
        replyQuoteGroup: groupQuote,
        groupActivation: parsedGroups
      });
    }}>
      <label className="messaging-form__wide"><span>{t("messaging.discordOwnerId")}</span><input ref={inputRef} value={ownerId} onChange={(event) => setOwnerId(event.target.value)} inputMode="numeric" /></label>
      <label><span>{t("messaging.emojiReactions")}</span><SelectControl value={emoji} onChange={(event) => setEmoji(event.target.value as typeof emoji)}><option value="off">{t("common.off")}</option><option value="minimal">{t("messaging.reactionsMinimal")}</option><option value="expressive">{t("messaging.reactionsExpressive")}</option></SelectControl></label>
      <label><span>{t("messaging.dmQuote")}</span><SelectControl value={dmQuote} onChange={(event) => setDmQuote(event.target.value as typeof dmQuote)}><option value="off">{t("common.off")}</option><option value="first">{t("messaging.quoteFirst")}</option></SelectControl></label>
      <label><span>{t("messaging.groupQuote")}</span><SelectControl value={groupQuote} onChange={(event) => setGroupQuote(event.target.value as typeof groupQuote)}><option value="off">{t("common.off")}</option><option value="first">{t("messaging.quoteFirst")}</option><option value="all">{t("messaging.quoteAll")}</option></SelectControl></label>
      <label className="messaging-choice-row"><CheckboxControl checked={lifecycleAnnouncements} onChange={(event) => setLifecycleAnnouncements(event.target.checked)} aria-label={t("messaging.lifecycleAnnouncements")} /><span>{t("messaging.lifecycleAnnouncements")}</span></label>
      <p className="messaging-form__hint">{t("messaging.lifecycleAnnouncementsBody")}</p>
      <label className="messaging-form__wide"><span>{t("messaging.discordGroupActivation")}</span><textarea value={groups} onChange={(event) => setGroups(event.target.value)} rows={5} placeholder={"123456789012345678/234567890123456789=mention\n123456789012345678/345678901234567890=always"} aria-invalid={parsedGroups === undefined} /></label>
      <p className="messaging-form__hint messaging-form__wide">{parsedGroups === undefined ? t("messaging.discordGroupActivationInvalid") : t("messaging.discordGroupActivationBody")}</p>
      <div className="modal__actions messaging-form__wide"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={!valid || busy}>{busy ? <Spinner /> : null}{t("common.save")}</Button></div>
    </form>
  </Modal>;
}

function SlackConfigurationDialog({ open, connection, busy, t, onClose, onSubmit }: {
  readonly open: boolean;
  readonly connection: MessagingConnectionView;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSubmit: (ownerId: string, configuration: SlackMessagingConfigurationView) => void;
}): JSX.Element {
  const initial = connection.slackConfiguration ?? DEFAULT_SLACK_CONFIGURATION;
  const [ownerId, setOwnerId] = useState(connection.ownerProviderUserId ?? "");
  const [lifecycleAnnouncements, setLifecycleAnnouncements] = useState(initial.lifecycleAnnouncements);
  const [emoji, setEmoji] = useState(initial.emojiReactions);
  const [groups, setGroups] = useState(groupActivationText(initial.groupActivation));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const current = connection.slackConfiguration ?? DEFAULT_SLACK_CONFIGURATION;
    setOwnerId(connection.ownerProviderUserId ?? "");
    setLifecycleAnnouncements(current.lifecycleAnnouncements);
    setEmoji(current.emojiReactions);
    setGroups(groupActivationText(current.groupActivation));
  }, [connection, open]);
  const parsedGroups = parseSlackGroupActivation(groups);
  const valid = validSlackOwnerId(ownerId.trim()) && parsedGroups !== undefined;
  return <Modal open={open} title={t("messaging.slackConfigureTitle")} description={t("messaging.slackConfigureBody")} closeLabel={t("common.close")} onClose={onClose} initialFocus={() => inputRef.current} showClose size="large">
    <form className="messaging-form messaging-form--grid" onSubmit={(event) => {
      event.preventDefault();
      if (valid && parsedGroups !== undefined) onSubmit(ownerId.trim(), {
        lifecycleAnnouncements,
        emojiReactions: emoji,
        groupActivation: parsedGroups
      });
    }}>
      <label className="messaging-form__wide"><span>{t("messaging.slackOwnerId")}</span><input ref={inputRef} value={ownerId} onChange={(event) => setOwnerId(event.target.value)} autoComplete="off" spellCheck={false} /></label>
      <label><span>{t("messaging.emojiReactions")}</span><SelectControl value={emoji} onChange={(event) => setEmoji(event.target.value as typeof emoji)}><option value="off">{t("common.off")}</option><option value="minimal">{t("messaging.reactionsMinimal")}</option><option value="expressive">{t("messaging.reactionsExpressive")}</option></SelectControl></label>
      <label className="messaging-choice-row"><CheckboxControl checked={lifecycleAnnouncements} onChange={(event) => setLifecycleAnnouncements(event.target.checked)} aria-label={t("messaging.lifecycleAnnouncements")} /><span>{t("messaging.lifecycleAnnouncements")}</span></label>
      <p className="messaging-form__hint">{t("messaging.lifecycleAnnouncementsBody")}</p>
      <label className="messaging-form__wide"><span>{t("messaging.slackGroupActivation")}</span><textarea value={groups} onChange={(event) => setGroups(event.target.value)} rows={5} placeholder={"C12345678=mention\nG12345678=always"} aria-invalid={parsedGroups === undefined} /></label>
      <p className="messaging-form__hint messaging-form__wide">{parsedGroups === undefined ? t("messaging.slackGroupActivationInvalid") : t("messaging.slackGroupActivationBody")}</p>
      <p className="messaging-form__warning messaging-form__wide">{t("messaging.slackGroupSafety")}</p>
      <div className="modal__actions messaging-form__wide"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={!valid || busy}>{busy ? <Spinner /> : null}{t("common.save")}</Button></div>
    </form>
  </Modal>;
}

function DingTalkConfigurationDialog({ open, connection, busy, t, onClose, onSubmit }: {
  readonly open: boolean;
  readonly connection: MessagingConnectionView;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSubmit: (configuration: DingTalkMessagingConfigurationView) => void;
}): JSX.Element {
  const initial = connection.dingtalkConfiguration!;
  const [appKey, setAppKey] = useState(initial.appKey);
  const [groups, setGroups] = useState(groupActivationText(initial.groupActivation));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const current = connection.dingtalkConfiguration!;
    setAppKey(current.appKey);
    setGroups(groupActivationText(current.groupActivation));
  }, [connection, open]);
  const parsedGroups = parseDingTalkGroupActivation(groups);
  const valid = validDingTalkProviderId(appKey, 256) && parsedGroups !== undefined;
  return <Modal open={open} title={t("messaging.dingtalkConfigureTitle")} description={t("messaging.dingtalkConfigureBody")} closeLabel={t("common.close")} onClose={onClose} initialFocus={() => inputRef.current} showClose size="large">
    <form className="messaging-form messaging-form--grid" onSubmit={(event) => {
      event.preventDefault();
      if (valid && parsedGroups !== undefined) onSubmit({ appKey: appKey.trim(), groupActivation: parsedGroups });
    }}>
      <label className="messaging-form__wide"><span>{t("messaging.dingtalkAppKey")}</span><input ref={inputRef} value={appKey} onChange={(event) => setAppKey(event.target.value)} autoComplete="off" spellCheck={false} /></label>
      <p className="messaging-form__hint messaging-form__wide">{t("messaging.dingtalkAppKeyChangeBody")}</p>
      <label className="messaging-form__wide"><span>{t("messaging.dingtalkGroupActivation")}</span><textarea value={groups} onChange={(event) => setGroups(event.target.value)} rows={5} placeholder={"cidxxxxxxxx=mention\ncidyyyyyyyy=always"} aria-invalid={parsedGroups === undefined} /></label>
      <p className="messaging-form__hint messaging-form__wide">{parsedGroups === undefined ? t("messaging.dingtalkGroupActivationInvalid") : t("messaging.dingtalkGroupActivationBody")}</p>
      <div className="modal__actions messaging-form__wide"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={!valid || busy}>{busy ? <Spinner /> : null}{t("common.save")}</Button></div>
    </form>
  </Modal>;
}

function FeishuConfigurationDialog({ open, connection, busy, t, onClose, onSubmit }: {
  readonly open: boolean;
  readonly connection: MessagingConnectionView;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSubmit: (configuration: FeishuMessagingConfigurationView) => void;
}): JSX.Element {
  const initial = connection.feishuConfiguration!;
  const [appId, setAppId] = useState(initial.appId);
  const [lifecycleAnnouncements, setLifecycleAnnouncements] = useState(initial.lifecycleAnnouncements);
  const [emoji, setEmoji] = useState(initial.emojiReactions);
  const [dmQuote, setDmQuote] = useState(initial.replyQuoteDm);
  const [groupQuote, setGroupQuote] = useState(initial.replyQuoteGroup);
  const [groupPermissionMode, setGroupPermissionMode] = useState(initial.groupPermissionMode);
  const [groups, setGroups] = useState(groupActivationText(initial.groupActivation));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const current = connection.feishuConfiguration!;
    setAppId(current.appId);
    setLifecycleAnnouncements(current.lifecycleAnnouncements);
    setEmoji(current.emojiReactions);
    setDmQuote(current.replyQuoteDm);
    setGroupQuote(current.replyQuoteGroup);
    setGroupPermissionMode(current.groupPermissionMode);
    setGroups(groupActivationText(current.groupActivation));
  }, [connection, open]);
  const parsedGroups = parseFeishuGroupActivation(groups);
  const valid = validFeishuProviderId(appId, 256) && parsedGroups !== undefined;
  const providerName = channelLabel(connection.channel);
  return <Modal open={open} title={t("messaging.feishuConfigureTitle", { name: providerName })} description={t("messaging.feishuConfigureBody", { name: providerName })} closeLabel={t("common.close")} onClose={onClose} initialFocus={() => inputRef.current} showClose size="large">
    <form className="messaging-form messaging-form--grid" onSubmit={(event) => {
      event.preventDefault();
      if (valid && parsedGroups !== undefined) onSubmit({
        appId: appId.trim(),
        lifecycleAnnouncements,
        emojiReactions: emoji,
        replyQuoteDm: dmQuote,
        replyQuoteGroup: groupQuote,
        groupActivation: parsedGroups,
        groupPermissionMode
      });
    }}>
      <label className="messaging-form__wide"><span>{t("messaging.feishuAppId")}</span><input ref={inputRef} value={appId} onChange={(event) => setAppId(event.target.value)} autoComplete="off" spellCheck={false} /></label>
      <p className="messaging-form__hint messaging-form__wide">{t("messaging.feishuAppIdChangeBody")}</p>
      <label><span>{t("messaging.emojiReactions")}</span><SelectControl value={emoji} onChange={(event) => setEmoji(event.target.value as typeof emoji)}><option value="off">{t("common.off")}</option><option value="minimal">{t("messaging.reactionsMinimal")}</option><option value="expressive">{t("messaging.reactionsExpressive")}</option></SelectControl></label>
      <label><span>{t("messaging.dmQuote")}</span><SelectControl value={dmQuote} onChange={(event) => setDmQuote(event.target.value as typeof dmQuote)}><option value="off">{t("common.off")}</option><option value="first">{t("messaging.quoteFirst")}</option></SelectControl></label>
      <label><span>{t("messaging.groupQuote")}</span><SelectControl value={groupQuote} onChange={(event) => setGroupQuote(event.target.value as typeof groupQuote)}><option value="off">{t("common.off")}</option><option value="first">{t("messaging.quoteFirst")}</option><option value="all">{t("messaging.quoteAll")}</option></SelectControl></label>
      <label><span>{t("messaging.feishuGroupPermission")}</span><SelectControl value={groupPermissionMode} onChange={(event) => setGroupPermissionMode(event.target.value as typeof groupPermissionMode)}><option value="ask">{t("messaging.permissionAsk")}</option><option value="bypassPermissions">{t("messaging.permissionBypass")}</option></SelectControl></label>
      <label className="messaging-choice-row"><CheckboxControl checked={lifecycleAnnouncements} onChange={(event) => setLifecycleAnnouncements(event.target.checked)} aria-label={t("messaging.lifecycleAnnouncements")} /><span>{t("messaging.lifecycleAnnouncements")}</span></label>
      <p className="messaging-form__hint">{t("messaging.lifecycleAnnouncementsBody")}</p>
      <label className="messaging-form__wide"><span>{t("messaging.feishuGroupActivation")}</span><textarea value={groups} onChange={(event) => setGroups(event.target.value)} rows={5} placeholder={"oc_xxxxxxxx=mention\noc_yyyyyyyy=always"} aria-invalid={parsedGroups === undefined} /></label>
      <p className="messaging-form__hint messaging-form__wide">{parsedGroups === undefined ? t("messaging.feishuGroupActivationInvalid") : t("messaging.feishuGroupActivationBody")}</p>
      <p className="messaging-form__warning messaging-form__wide">{t("messaging.feishuGroupSafety")}</p>
      <div className="modal__actions messaging-form__wide"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={!valid || busy}>{busy ? <Spinner /> : null}{t("common.save")}</Button></div>
    </form>
  </Modal>;
}

function WeComConfigurationDialog({ open, connection, busy, t, onClose, onSubmit }: {
  readonly open: boolean;
  readonly connection: MessagingConnectionView;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSubmit: (configuration: WeComMessagingConfigurationView) => void;
}): JSX.Element {
  const [botId, setBotId] = useState(connection.wecomConfiguration!.botId);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setBotId(connection.wecomConfiguration!.botId);
  }, [connection, open]);
  const valid = validWeComBotId(botId);
  return <Modal open={open} title={t("messaging.wecomConfigureTitle")} description={t("messaging.wecomConfigureBody")} closeLabel={t("common.close")} onClose={onClose} initialFocus={() => inputRef.current} showClose>
    <form className="messaging-form" onSubmit={(event) => {
      event.preventDefault();
      if (valid) onSubmit({ botId: botId.trim() });
    }}>
      <label><span>{t("messaging.wecomBotId")}</span><input ref={inputRef} value={botId} onChange={(event) => setBotId(event.target.value)} autoComplete="off" spellCheck={false} /></label>
      <p className="messaging-form__hint">{t("messaging.wecomBotIdChangeBody")}</p>
      <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={!valid || busy}>{busy ? <Spinner /> : null}{t("common.save")}</Button></div>
    </form>
  </Modal>;
}

function ClearCredentialDialog({ open, connection, busy, t, onClose, onConfirm }: {
  readonly open: boolean;
  readonly connection: MessagingConnectionView;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  const dingtalk = connection.channel === "dingtalk";
  const appSecret = connection.channel === "feishu" || connection.channel === "lark" || connection.channel === "wecom";
  const title = dingtalk ? "messaging.dingtalkClearTitle"
    : connection.channel === "wechat" ? "messaging.wechatClearTitle"
    : connection.channel === "slack" ? "messaging.slackClearTitle"
    : connection.channel === "wecom" ? "messaging.wecomClearTitle"
      : appSecret ? "messaging.appSecretClearTitle" : "messaging.clearTitle";
  const action = dingtalk ? "messaging.dingtalkClearCredential"
    : connection.channel === "wechat" ? "messaging.wechatClearCredential"
    : connection.channel === "slack" ? "messaging.slackClearCredential"
    : connection.channel === "wecom" ? "messaging.wecomClearCredential"
      : appSecret ? "messaging.appSecretClearCredential" : "messaging.clearCredential";
  return <Modal open={open} title={t(title)} description={t(connection.channel === "wechat" ? "messaging.wechatClearBody" : connection.channel === "slack" ? "messaging.slackClearBody" : "messaging.clearBody")} closeLabel={t("common.close")} onClose={onClose} dialogRole="alertdialog">
    <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="danger" disabled={busy} onClick={onConfirm}>{busy ? <Spinner /> : null}{t(action)}</Button></div>
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

function groupActivationText(value: Readonly<Record<string, "mention" | "always" | "disabled">>): string {
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

function parseDiscordGroupActivation(value: string): Record<string, "mention" | "always" | "disabled"> | undefined {
  const result: Record<string, "mention" | "always" | "disabled"> = {};
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^([1-9][0-9]{16,19})\/([1-9][0-9]{16,19})\s*=\s*(mention|always|disabled)$/u.exec(line);
    if (match === null) return undefined;
    const key = `${match[1]!}/${match[2]!}`;
    if (result[key] !== undefined) return undefined;
    result[key] = match[3]! as "mention" | "always" | "disabled";
  }
  return result;
}

function parseSlackGroupActivation(value: string): Record<string, "mention" | "always" | "disabled"> | undefined {
  const result: Record<string, "mention" | "always" | "disabled"> = {};
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^([CG][A-Z0-9]{8,63})\s*=\s*(mention|always|disabled)$/u.exec(line);
    if (match === null || Object.hasOwn(result, match[1]!)) return undefined;
    result[match[1]!] = match[2]! as "mention" | "always" | "disabled";
  }
  return result;
}

function parseDingTalkGroupActivation(value: string): Record<string, "mention" | "always" | "disabled"> | undefined {
  const result: Record<string, "mention" | "always" | "disabled"> = {};
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^(.+?)\s*=\s*(mention|always|disabled)$/u.exec(line);
    const conversationId = match?.[1]?.trim();
    if (match === null || conversationId === undefined || !validDingTalkProviderId(conversationId, 512)
      || Object.hasOwn(result, conversationId)) return undefined;
    result[conversationId] = match[2]! as "mention" | "always" | "disabled";
  }
  return result;
}

function parseFeishuGroupActivation(value: string): Record<string, "mention" | "always" | "disabled"> | undefined {
  const result: Record<string, "mention" | "always" | "disabled"> = {};
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^(.+?)\s*=\s*(mention|always|disabled)$/u.exec(line);
    const chatId = match?.[1]?.trim();
    if (match === null || chatId === undefined || !validFeishuProviderId(chatId, 512)
      || Object.hasOwn(result, chatId)) return undefined;
    result[chatId] = match[2]! as "mention" | "always" | "disabled";
  }
  return result;
}

function validDingTalkProviderId(value: string, maximum: number): boolean {
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(normalized);
}

function validFeishuProviderId(value: string, maximum: number): boolean {
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(normalized);
}

function validWeComBotId(value: string): boolean {
  const normalized = value.trim();
  return normalized.length >= 1
    && normalized.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(normalized);
}

function validSlackOwnerId(value: string): boolean {
  return /^[UW][A-Z0-9]{8,63}$/u.test(value);
}

function validSlackToken(value: string, prefix: "xapp-" | "xoxb-"): boolean {
  return value.startsWith(prefix) && value.length > prefix.length && value.length <= 8_192
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function telegramConfigurationEqual(
  left: TelegramMessagingConfigurationView | undefined,
  right: TelegramMessagingConfigurationView | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.emojiReactions === right.emojiReactions
    && left.replyQuoteDm === right.replyQuoteDm
    && left.replyQuoteGroup === right.replyQuoteGroup
    && activationRulesEqual(left.groupActivation, right.groupActivation);
}

function discordConfigurationEqual(
  left: DiscordMessagingConfigurationView | undefined,
  right: DiscordMessagingConfigurationView | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.lifecycleAnnouncements === right.lifecycleAnnouncements
    && left.emojiReactions === right.emojiReactions
    && left.replyQuoteDm === right.replyQuoteDm
    && left.replyQuoteGroup === right.replyQuoteGroup
    && activationRulesEqual(left.groupActivation, right.groupActivation);
}

function slackConfigurationEqual(
  left: SlackMessagingConfigurationView | undefined,
  right: SlackMessagingConfigurationView | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.lifecycleAnnouncements === right.lifecycleAnnouncements
    && left.emojiReactions === right.emojiReactions
    && activationRulesEqual(left.groupActivation, right.groupActivation);
}

function dingtalkConfigurationEqual(
  left: DingTalkMessagingConfigurationView | undefined,
  right: DingTalkMessagingConfigurationView | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.appKey === right.appKey && activationRulesEqual(left.groupActivation, right.groupActivation);
}

function feishuConfigurationEqual(
  left: FeishuMessagingConfigurationView | undefined,
  right: FeishuMessagingConfigurationView | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.appId === right.appId
    && left.lifecycleAnnouncements === right.lifecycleAnnouncements
    && left.emojiReactions === right.emojiReactions
    && left.replyQuoteDm === right.replyQuoteDm
    && left.replyQuoteGroup === right.replyQuoteGroup
    && left.groupPermissionMode === right.groupPermissionMode
    && activationRulesEqual(left.groupActivation, right.groupActivation);
}

function wecomConfigurationEqual(
  left: WeComMessagingConfigurationView | undefined,
  right: WeComMessagingConfigurationView | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.botId === right.botId;
}

function messagingCredentialActionLabel(connection: MessagingConnectionView, t: Translator): string {
  if (connection.channel === "slack") {
    return t(connection.credentialConfigured ? "messaging.slackReplaceCredential" : "messaging.slackAddCredential");
  }
  if (connection.channel === "dingtalk") {
    return t(connection.credentialConfigured ? "messaging.dingtalkReplaceCredential" : "messaging.dingtalkAddCredential");
  }
  if (connection.channel === "feishu" || connection.channel === "lark") {
    return t(connection.credentialConfigured ? "messaging.feishuReplaceCredential" : "messaging.feishuAddCredential");
  }
  if (connection.channel === "wecom") {
    return t(connection.credentialConfigured ? "messaging.wecomReplaceCredential" : "messaging.wecomAddCredential");
  }
  return t(connection.credentialConfigured ? "messaging.replaceCredential" : "messaging.addCredential");
}

function activationRulesEqual(
  left: Readonly<Record<string, "mention" | "always" | "disabled">>,
  right: Readonly<Record<string, "mention" | "always" | "disabled">>
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value);
}

function modelSelectionKey(providerId?: string, modelId?: string): string {
  return providerId === undefined || modelId === undefined ? "" : JSON.stringify([providerId, modelId]);
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() !== "" ? reason.message : fallback;
}
