import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import type { AppController } from "../controller.js";
import type { HostedAgentSettingsApi, HostedAgentCatalogView, HostedAgentSettingsUpdate, HostedAgentSettingsView } from "../hosted-agent-settings.js";
import type { Translator } from "./types.js";
import { Button, Pill, SwitchControl } from "./ui.js";
import { RemoteModelAccessEditor } from "./RemoteModelAccessEditor.js";
import "./hosted-agent-settings.css";

type Feedback = "loadFailed" | "saveFailed" | "conflict" | "saved";
interface View { readonly api: HostedAgentSettingsApi; readonly loading: boolean; readonly pending: boolean;
  readonly settings?: HostedAgentSettingsView; readonly catalog?: HostedAgentCatalogView; readonly feedback?: Feedback }
interface Owner { readonly api: HostedAgentSettingsApi; readonly lifetime: AbortController; readId: number; reading: boolean; writing: boolean; dirty: boolean }

export function HostedAgentSettings({ controller, t }: { readonly controller: AppController; readonly t: Translator }): JSX.Element | null {
  const { state } = controller;
  if (!state.activeProfile || state.connectionState !== "connected" || state.taskSource?.kind === "joined" || state.sessionAccess?.role === "guest") return null;
  return <HostedAgentSettingsPanel key={`${state.activeProfile.serverId}:${state.activeProfile.id}:${state.connectionGeneration ?? 0}`}
    controller={controller} nodeName={state.activeProfile.name} t={t} />;
}
function HostedAgentSettingsPanel({ controller, nodeName, t }: { readonly controller: AppController; readonly nodeName: string; readonly t: Translator }): JSX.Element | null {
  const api = useMemo<HostedAgentSettingsApi>(() => ({ getHostedAgentSettings: controller.getHostedAgentSettings,
    getHostedAgentCatalog: controller.getHostedAgentCatalog, updateHostedAgentSettings: controller.updateHostedAgentSettings }),
  [controller.getHostedAgentSettings, controller.getHostedAgentCatalog, controller.updateHostedAgentSettings]);
  const [view, setView] = useState<View>({ api, loading: true, pending: false });
  const [draft, setDraft] = useState({ api, perDevice: "16", total: "64" });
  const current = useRef<Owner | undefined>(undefined);
  const active = view.api === api ? view : { api, loading: true, pending: false };
  const fields = draft.api === api ? draft : { api, perDevice: "16", total: "64" };
  const read = useCallback(async (duringWrite = false): Promise<boolean> => {
    const owner = current.current;
    if (!owner || owner.api !== api || owner.lifetime.signal.aborted || owner.reading || owner.writing && !duringWrite) return false;
    owner.reading = true;
    const id = ++owner.readId;
    const live = () => current.current === owner && !owner.lifetime.signal.aborted && owner.readId === id;
    setView(previous => ({ ...(previous.api === api ? previous : { api, pending: false }), loading: true }));
    try {
      const [settings, catalog] = await Promise.all([api.getHostedAgentSettings(owner.lifetime.signal), api.getHostedAgentCatalog(owner.lifetime.signal)]);
      if (!live()) return false;
      setView(previous => ({ ...(previous.api === api ? previous : { api }), loading: false, pending: owner.writing, settings, catalog }));
      if (!owner.dirty) setDraft({ api, perDevice: String(settings.limits.perDevice), total: String(settings.limits.total) });
      return true;
    } catch {
      if (live()) setView(previous => ({ ...(previous.api === api ? previous : { api }), loading: false, pending: owner.writing, feedback: "loadFailed" }));
      return false;
    } finally { if (live()) owner.reading = false; }
  }, [api]);
  useEffect(() => {
    const owner: Owner = { api, lifetime: new AbortController(), readId: 0, reading: false, writing: false, dirty: false };
    current.current = owner; void read();
    const timer = window.setInterval(() => { void read(); }, 30_000);
    return () => { owner.lifetime.abort(); window.clearInterval(timer); if (current.current === owner) current.current = undefined; };
  }, [api, read]);
  const change = async (update: HostedAgentSettingsUpdate): Promise<void> => {
    const owner = current.current, settings = active.settings;
    if (!owner || owner.api !== api || owner.writing || owner.reading || !settings) return;
    owner.writing = true;
    const live = () => current.current === owner && !owner.lifetime.signal.aborted;
    setView(previous => ({ ...previous, pending: true, feedback: undefined }));
    try {
      const result = await api.updateHostedAgentSettings(update, settings.revision, owner.lifetime.signal);
      if (!live()) return;
      if (update.kind === "limits" || update.kind === "resetLimits") owner.dirty = false;
      if (!owner.dirty) setDraft({ api, perDevice: String(result.limits.perDevice), total: String(result.limits.total) });
      setView(previous => ({ ...previous, settings: result, pending: false, feedback: "saved" }));
    } catch (error) {
      if (!live()) return;
      if (ConnectError.from(error).code === Code.Aborted) {
        if (await read(true) && live()) setView(previous => ({ ...previous, feedback: "conflict" }));
      } else setView(previous => ({ ...previous, feedback: "saveFailed" }));
    } finally { if (live()) { owner.writing = false; setView(previous => ({ ...previous, pending: false })); } }
  };
  const settings = active.settings;
  if (active.catalog?.backends.length === 0) return null;
  const busy = active.pending || active.loading;
  const perDevice = parseLimit(fields.perDevice), total = parseLimit(fields.total);
  const invalid = perDevice === undefined || total === undefined;
  const edited = settings && (perDevice !== settings.limits.perDevice || total !== settings.limits.total);
  const updateDraft = (field: "perDevice" | "total", value: string) => {
    const owner = current.current; if (!owner || owner.api !== api) return; owner.dirty = true;
    setDraft({ ...fields, [field]: value });
  };
  return <section className="hosted-agent-settings" aria-labelledby="hosted-agent-settings-heading">
    <div className="settings-section-heading settings-section-heading--with-actions">
      <div className="settings-section-heading__copy"><h3 id="hosted-agent-settings-heading">{t("settings.hostedAgents.title")}</h3>
        <p>{t("settings.hostedAgents.body", { name: nodeName })}</p></div>
      <Button disabled={busy} onClick={() => { void read(); }}>{t("common.refresh")}</Button>
    </div>
    {active.loading && !settings && <p role="status">{t("settings.hostedAgents.loading")}</p>}
    {active.feedback && <p role={active.feedback === "saved" ? "status" : "alert"} className={active.feedback === "saved" ? "muted" : "hosted-agent-settings__error"}>
      {t(`settings.hostedAgents.${active.feedback}`)}</p>}
    {settings && <div className="settings-card-stack">
      <div className="settings-card"><div className="setting-row hosted-agent-settings__toggle">
        <div><strong>{t("settings.hostedAgents.allow")}</strong><span>{t("settings.hostedAgents.allowBody")}</span></div>
        <SwitchControl checked={settings.remoteControlEnabled} disabled={busy} aria-label={t("settings.hostedAgents.allow")}
          onChange={event => { void change({ kind: "remoteControl", enabled: event.target.checked }); }} />
      </div></div>
      {active.catalog?.backends.map(backend => <div className="settings-card" key={backend.backendId}>
        <div className="setting-row"><div><strong>{backend.displayName}</strong><span>{t("settings.hostedAgents.providersBody")}</span></div></div>
        {backend.providers.map(provider => {
          const permission = settings.providers.find(permission => permission.backendId === backend.backendId && permission.providerId === provider.providerId), allowed = permission?.enabled === true;
          return <div key={provider.providerId}><div className="setting-row hosted-agent-settings__toggle">
            <div><strong>{provider.displayName}</strong><span>{provider.connected ? t("settings.hostedAgents.models", { count: provider.modelCount }) : t("settings.hostedAgents.disconnected")}</span></div>
            <SwitchControl checked={allowed} disabled={busy || !settings.remoteControlEnabled}
              aria-label={t("settings.hostedAgents.providerAria", { backend: backend.displayName, name: provider.displayName })}
              onChange={event => { void change({ kind: "provider", backendId: backend.backendId, providerId: provider.providerId, enabled: event.target.checked }); }} />
          </div><RemoteModelAccessEditor key={JSON.stringify(permission?.modelIds)} selected={permission?.modelIds} models={provider.models ?? []}
            disabled={busy} language={controller.state.effectiveLocale}
            onSave={modelIds => change({ kind: "modelAccess", backendId: backend.backendId, providerId: provider.providerId, modelIds })} /></div>;
        })}
        {backend.providers.length === 0 && <p className="hosted-agent-settings__note muted">{t("settings.hostedAgents.noProviders")}</p>}
      </div>)}
      <div className="settings-card">
        <div className="setting-row"><div><strong>{t("settings.hostedAgents.limits")}</strong><span>{t("settings.hostedAgents.limitsBody")}</span></div>
          <Pill>{t(settings.limitsOverridden ? "settings.hostedAgents.customLimits" : "settings.hostedAgents.defaultLimits")}</Pill></div>
        <div className="setting-row"><div><strong>{t("settings.hostedAgents.usage")}</strong><span>{settings.usage ? t("settings.hostedAgents.usageBody", settings.usage) : t("settings.hostedAgents.usageUnknown")}</span></div>
          <Pill>{settings.usage ? `${settings.usage.total} / ${settings.limits.total}` : "—"}</Pill></div>
        <form onSubmit={event => { event.preventDefault(); if (!invalid && edited) void change({ kind: "limits", perDevice, total }); }}>
          <label className="setting-row"><div><strong>{t("settings.hostedAgents.perDevice")}</strong><span>{t("settings.hostedAgents.currentLimit", { count: settings.limits.perDevice })}</span></div>
            <input type="number" min={1} max={1000} step={1} inputMode="numeric" value={fields.perDevice} disabled={busy}
              aria-invalid={perDevice === undefined} onChange={event => updateDraft("perDevice", event.target.value)} /></label>
          <label className="setting-row"><div><strong>{t("settings.hostedAgents.total")}</strong><span>{t("settings.hostedAgents.currentLimit", { count: settings.limits.total })}</span></div>
            <input type="number" min={1} max={1000} step={1} inputMode="numeric" value={fields.total} disabled={busy}
              aria-invalid={total === undefined} onChange={event => updateDraft("total", event.target.value)} /></label>
          {invalid && <p role="alert" className="hosted-agent-settings__error">{t("settings.hostedAgents.invalidLimits")}</p>}
          <div className="hosted-agent-settings__actions"><Button type="submit" disabled={busy || invalid || !edited}>{t("common.save")}</Button>
            <Button disabled={busy || !settings.limitsOverridden} onClick={() => { void change({ kind: "resetLimits" }); }}>{t("settings.hostedAgents.resetLimits")}</Button></div>
        </form>
      </div>
    </div>}
  </section>;
}
function parseLimit(value: string): number | undefined { const number = Number(value); return /^\d+$/u.test(value) && Number.isSafeInteger(number) && number >= 1 && number <= 1000 ? number : undefined; }
